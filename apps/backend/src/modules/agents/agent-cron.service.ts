/**
 * Agent Cron Service
 *
 * Implements agent-managed scheduled work for both one-off wakeups and
 * recurring cron schedules, with a workspace manifest file that agents can use
 * to inspect, edit, and delete their own schedules.
 *
 * Phase 4 implementation status:
 * - Persists schedules in Prisma with per-channel targeting.
 * - Computes next-run timestamps in a cross-platform Node scheduler.
 * - Mirrors schedules into `.nextgenchat/schedules.json` inside each agent workspace.
 * - Delivers simple scheduled posts directly when the task clearly describes a message to send.
 * - Future phases can add pause/resume, richer recurrence editing, and run history.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { AgentScheduleRecord, CreateAgentScheduleInput, UpdateAgentScheduleInput } from '@nextgenchat/types';
import { CronExpressionParser } from 'cron-parser';
import { z } from 'zod';

import { prisma } from '@/db/client.js';
import { agentProcessQueue } from '@/lib/queues.js';
import { chatService } from '@/modules/chat/chat.service.js';
import { workspaceService } from '@/modules/workspace/workspace.service.js';
import { getChatNamespace, getChannelRoom } from '@/sockets/socket-server.js';

const SCHEDULE_MANIFEST_RELATIVE_PATH = path.join('.nextgenchat', 'schedules.json');

const ScheduleManifestEntrySchema = z.object({
  id: z.string().uuid(),
  schedule: z.string().min(1).optional(),
  task: z.string().min(1).optional(),
  timezone: z.string().min(1).optional(),
}).passthrough();

const ScheduleManifestSchema = z.object({
  schedules: z.array(ScheduleManifestEntrySchema),
});

type ScheduleManifestEntry = z.infer<typeof ScheduleManifestEntrySchema>;

type ScheduleJobRecord = {
  id: string;
  agentId: string;
  channelId: string;
  kind: 'ONCE' | 'CRON';
  schedule: string;
  task: string;
  timezone: string;
  status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED';
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  channel: { name: string };
};

function getDefaultTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function assertValidDate(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('Invalid schedule date. Use an ISO timestamp for one-time schedules.');
  }
  return parsed;
}

function normalizeCronExpression(value: string) {
  const trimmed = value.trim().replace(/\s+/g, ' ');
  const fields = trimmed.split(' ');

  if (fields.length === 5) {
    return `0 ${trimmed}`;
  }

  if (fields.length !== 6) {
    throw new Error('Cron expressions must use 5 or 6 fields.');
  }

  return trimmed;
}

function normalizeScheduleValue(kind: 'ONCE' | 'CRON', schedule: string) {
  return kind === 'CRON' ? normalizeCronExpression(schedule) : schedule.trim();
}

function computeNextRun(input: {
  kind: 'ONCE' | 'CRON';
  schedule: string;
  timezone: string;
  fromDate?: Date;
}) {
  const baseDate = input.fromDate ?? new Date();

  if (input.kind === 'ONCE') {
    const runAt = assertValidDate(input.schedule.trim());
    if (runAt.getTime() <= baseDate.getTime()) {
      throw new Error('One-time schedules must be set in the future.');
    }
    return runAt;
  }

  try {
    return CronExpressionParser.parse(normalizeCronExpression(input.schedule), {
      currentDate: baseDate,
      tz: input.timezone,
      strict: true,
    }).next().toDate();
  } catch (error) {
    throw new Error(`Invalid cron expression: ${error instanceof Error ? error.message : 'Unknown parser error.'}`, {
      cause: error,
    });
  }
}

function buildInternalWakeupMessage(input: {
  kind: 'ONCE' | 'CRON';
  task: string;
  schedule: string;
  timezone: string;
}) {
  const mode = input.kind === 'ONCE' ? 'one-time wakeup' : 'recurring wakeup';
  return [
    `Scheduled ${mode}.`,
    `Task: ${input.task}`,
    `Schedule: ${input.schedule}`,
    `Timezone: ${input.timezone}`,
    'Execute the task now. If this is a reminder, send the reminder into this channel.',
  ].join('\n');
}

function stripWrappingQuotes(value: string) {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '\'' || first === '"' || first === '`') && last === first) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

function parseDirectScheduledPost(task: string) {
  const normalizedTask = task.trim().replace(/\s+/g, ' ');
  const match = /^(?:send|post)\s+(.+?)(?:\s+(?:to|in)\s+#([a-z0-9_-]+))?(?:\s+(?:using|via)\s+channel_send_message\.?)?$/i.exec(normalizedTask);

  if (!match) {
    return null;
  }

  const content = stripWrappingQuotes(match[1] ?? '');
  if (!content) {
    return null;
  }

  return {
    content,
    targetChannelName: match[2]?.trim().toLowerCase() ?? null,
  };
}

function describeSchedule(kind: 'ONCE' | 'CRON', schedule: string, timezone: string) {
  if (kind === 'ONCE') {
    const runAt = assertValidDate(schedule);
    return `Once at ${runAt.toLocaleString('en-US', { timeZone: timezone, timeZoneName: 'short' })}`;
  }

  const normalized = normalizeCronExpression(schedule);
  const [seconds, minutes, hours, dayOfMonth, month, dayOfWeek] = normalized.split(' ');

  if (seconds === '0' && minutes.startsWith('*/') && hours === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    const interval = minutes.slice(2);
    return `Every ${interval} minute${interval === '1' ? '' : 's'}`;
  }

  if (seconds === '0' && minutes === '0' && hours.startsWith('*/') && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    const interval = hours.slice(2);
    return `Every ${interval} hour${interval === '1' ? '' : 's'}`;
  }

  if (seconds === '0' && dayOfMonth === '*' && month === '*') {
    const timeLabel = `${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}`;
    if (dayOfWeek === '*') {
      return `Every day at ${timeLabel} (${timezone})`;
    }
    if (dayOfWeek === '1-5') {
      return `Weekdays at ${timeLabel} (${timezone})`;
    }

    const weekdayNames: Record<string, string> = {
      '0': 'Sunday',
      '1': 'Monday',
      '2': 'Tuesday',
      '3': 'Wednesday',
      '4': 'Thursday',
      '5': 'Friday',
      '6': 'Saturday',
      '7': 'Sunday',
    };

    if (weekdayNames[dayOfWeek]) {
      return `Every ${weekdayNames[dayOfWeek]} at ${timeLabel} (${timezone})`;
    }
  }

  const nextRun = computeNextRun({
    kind: 'CRON',
    schedule: normalized,
    timezone,
  });

  return `Custom cron (${normalized}) · next run ${nextRun.toLocaleString('en-US', { timeZone: timezone, timeZoneName: 'short' })}`;
}

function describeDelivery(task: string, channelName: string) {
  const directPost = parseDirectScheduledPost(task);
  if (!directPost) {
    return `Wake the agent in #${channelName} to do: ${task}`;
  }

  const targetChannel = directPost.targetChannelName ?? channelName;
  return `Post "${directPost.content}" in #${targetChannel}`;
}

function serializeSchedule(job: ScheduleJobRecord): AgentScheduleRecord {
  return {
    id: job.id,
    agentId: job.agentId,
    channelId: job.channelId,
    channelName: job.channel.name,
    kind: job.kind,
    schedule: job.schedule,
    scheduleDescription: describeSchedule(job.kind, job.schedule, job.timezone),
    task: job.task,
    deliveryDescription: describeDelivery(job.task, job.channel.name),
    timezone: job.timezone,
    status: job.status,
    lastRunAt: job.lastRunAt?.toISOString() ?? null,
    nextRunAt: job.nextRunAt?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

export class AgentCronService {
  getManifestRelativePath() {
    return SCHEDULE_MANIFEST_RELATIVE_PATH;
  }

  async getManifestAbsolutePath(agentId: string) {
    const slug = await workspaceService.fetchSlug(agentId);
    return path.join(workspaceService.getAgentWorkspaceDir(slug), SCHEDULE_MANIFEST_RELATIVE_PATH);
  }

  async listAgentSchedules(agentId: string): Promise<AgentScheduleRecord[]> {
    const jobs = await prisma.agentCronJob.findMany({
      where: { agentId },
      include: {
        channel: {
          select: {
            name: true,
          },
        },
      },
      orderBy: [
        { status: 'asc' },
        { nextRunAt: 'asc' },
        { createdAt: 'asc' },
      ],
    });

    return jobs.map((job) => serializeSchedule(job as ScheduleJobRecord));
  }

  async syncWorkspaceManifest(agentId: string) {
    const manifestPath = await this.getManifestAbsolutePath(agentId);
    const schedules = await this.listAgentSchedules(agentId);
    const manifest = {
      generatedAt: new Date().toISOString(),
      note: 'Edit schedule, timezone, or task values in-place to update a job. Delete an entry from the schedules array to remove it.',
      schedules,
    };

    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }

  async createAgentSchedule(agentId: string, input: CreateAgentScheduleInput) {
    const agent = await prisma.agent.findUnique({
      where: { id: agentId },
      select: {
        id: true,
        status: true,
      },
    });

    if (!agent || agent.status === 'ARCHIVED') {
      throw new Error('Agent not found or archived.');
    }

    const membership = await prisma.agentChannelMembership.findFirst({
      where: {
        agentId,
        channelId: input.channelId,
      },
      select: { id: true },
    });

    if (!membership) {
      throw new Error('The agent can only schedule work in channels it already belongs to.');
    }

    const timezone = input.timezone?.trim() || getDefaultTimezone();
    const schedule = normalizeScheduleValue(input.kind, input.schedule);
    const nextRunAt = computeNextRun({
      kind: input.kind,
      schedule,
      timezone,
    });

    const created = await prisma.agentCronJob.create({
      data: {
        agentId,
        channelId: input.channelId,
        kind: input.kind,
        schedule,
        task: input.task.trim(),
        timezone,
        nextRunAt,
        status: 'ACTIVE',
      },
      include: {
        channel: {
          select: { name: true },
        },
      },
    });

    await this.syncWorkspaceManifest(agentId);
    return serializeSchedule(created as ScheduleJobRecord);
  }

  async updateAgentSchedule(agentId: string, scheduleId: string, input: UpdateAgentScheduleInput) {
    const existing = await prisma.agentCronJob.findFirst({
      where: {
        id: scheduleId,
        agentId,
      },
      include: {
        channel: {
          select: { name: true },
        },
      },
    });

    if (!existing) {
      throw new Error('Scheduled job not found for this agent.');
    }

    const schedule = normalizeScheduleValue(existing.kind, input.schedule ?? existing.schedule);
    const timezone = (input.timezone ?? existing.timezone).trim();
    const task = (input.task ?? existing.task).trim();
    const nextRunAt = computeNextRun({
      kind: existing.kind,
      schedule,
      timezone,
    });

    const updated = await prisma.agentCronJob.update({
      where: { id: scheduleId },
      data: {
        schedule,
        timezone,
        task,
        nextRunAt,
        status: 'ACTIVE',
      },
      include: {
        channel: {
          select: { name: true },
        },
      },
    });

    await this.syncWorkspaceManifest(agentId);
    return serializeSchedule(updated as ScheduleJobRecord);
  }

  async deleteAgentSchedule(agentId: string, scheduleId: string) {
    const existing = await prisma.agentCronJob.findFirst({
      where: {
        id: scheduleId,
        agentId,
      },
      select: { id: true },
    });

    if (!existing) {
      throw new Error('Scheduled job not found for this agent.');
    }

    await prisma.agentCronJob.delete({
      where: { id: scheduleId },
    });

    await this.syncWorkspaceManifest(agentId);
  }

  async syncManifestChanges(agentId: string, content: string) {
    let parsed: { schedules: ScheduleManifestEntry[] };

    try {
      const raw = JSON.parse(content) as unknown;
      if (Array.isArray(raw)) {
        parsed = { schedules: raw.map((entry) => ScheduleManifestEntrySchema.parse(entry)) };
      } else {
        parsed = ScheduleManifestSchema.parse(raw);
      }
    } catch (error) {
      throw new Error(`Invalid schedules manifest JSON: ${error instanceof Error ? error.message : 'Unknown parse error.'}`, {
        cause: error,
      });
    }

    const existing = await prisma.agentCronJob.findMany({
      where: { agentId },
      include: {
        channel: {
          select: { name: true },
        },
      },
    });

    const existingIds = new Set(existing.map((job) => job.id));
    const existingById = new Map(existing.map((job) => [job.id, job]));
    const keepIds = new Set(parsed.schedules.map((entry) => entry.id));

    for (const requestedId of keepIds) {
      if (!existingIds.has(requestedId)) {
        throw new Error(`Unknown schedule id in manifest: ${requestedId}. Only existing schedules can remain in the file.`);
      }
    }

    const idsToDelete = existing
      .map((job) => job.id)
      .filter((jobId) => !keepIds.has(jobId));

    let updatedCount = 0;

    for (const entry of parsed.schedules) {
      const existingJob = existingById.get(entry.id);
      if (!existingJob) {
        continue;
      }

      const nextSchedule = normalizeScheduleValue(existingJob.kind, entry.schedule ?? existingJob.schedule);
      const nextTimezone = (entry.timezone ?? existingJob.timezone).trim();
      const nextTask = (entry.task ?? existingJob.task).trim();
      const changed = nextSchedule !== existingJob.schedule
        || nextTimezone !== existingJob.timezone
        || nextTask !== existingJob.task;

      if (!changed) {
        continue;
      }

      const nextRunAt = computeNextRun({
        kind: existingJob.kind,
        schedule: nextSchedule,
        timezone: nextTimezone,
      });

      await prisma.agentCronJob.update({
        where: { id: entry.id },
        data: {
          schedule: nextSchedule,
          timezone: nextTimezone,
          task: nextTask,
          nextRunAt,
          status: 'ACTIVE',
        },
      });
      updatedCount += 1;
    }

    if (idsToDelete.length > 0) {
      await prisma.agentCronJob.deleteMany({
        where: {
          agentId,
          id: { in: idsToDelete },
        },
      });
    }

    await this.syncWorkspaceManifest(agentId);

    return {
      updatedCount,
      deletedCount: idsToDelete.length,
      deletedIds: idsToDelete,
    };
  }

  private async tryDeliverDirectScheduledPost(job: ScheduleJobRecord) {
    const directPost = parseDirectScheduledPost(job.task);
    if (!directPost) {
      return false;
    }

    const memberships = await prisma.agentChannelMembership.findMany({
      where: { agentId: job.agentId },
      include: {
        channel: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    const targetMembership = directPost.targetChannelName
      ? memberships.find((membership) => membership.channel.name.toLowerCase() === directPost.targetChannelName)
      : memberships.find((membership) => membership.channelId === job.channelId);

    if (!targetMembership) {
      return false;
    }

    const message = await chatService.createAgentRelayMessage({
      channelId: targetMembership.channelId,
      senderId: job.agentId,
      content: directPost.content,
      contentType: 'MARKDOWN',
      metadata: {
        schedule: {
          source: 'agent-cron',
          scheduleId: job.id,
          kind: job.kind,
        },
      },
    });

    getChatNamespace().to(getChannelRoom(targetMembership.channelId)).emit('message:new', message);
    await chatService.triggerAgentsForMessage({
      channelId: targetMembership.channelId,
      senderId: job.agentId,
      senderType: 'AGENT',
      content: directPost.content,
      messageId: message.id,
      isRelay: targetMembership.channelId !== job.channelId,
    });

    return true;
  }

  async triggerDueSchedules() {
    const now = new Date();
    const dueJobs = await prisma.agentCronJob.findMany({
      where: {
        status: 'ACTIVE',
        nextRunAt: { lte: now },
        agent: {
          status: 'ACTIVE',
        },
      },
      include: {
        channel: {
          select: { name: true },
        },
      },
      orderBy: { nextRunAt: 'asc' },
      take: 50,
    });

    for (const job of dueJobs) {
      const runStartedAt = new Date();
      let nextRunAt: Date | null = null;
      let nextStatus: 'ACTIVE' | 'ARCHIVED' = 'ACTIVE';

      if (job.kind === 'CRON') {
        nextRunAt = computeNextRun({
          kind: 'CRON',
          schedule: job.schedule,
          timezone: job.timezone,
          fromDate: runStartedAt,
        });
      } else {
        nextStatus = 'ARCHIVED';
      }

      await prisma.agentCronJob.update({
        where: { id: job.id },
        data: {
          lastRunAt: runStartedAt,
          nextRunAt,
          status: nextStatus,
        },
      });

      const deliveredDirectly = await this.tryDeliverDirectScheduledPost(job as ScheduleJobRecord);

      if (!deliveredDirectly) {
        const triggerMessage = await prisma.message.create({
          data: {
            channelId: job.channelId,
            senderId: job.agentId,
            senderType: 'AGENT',
            content: buildInternalWakeupMessage({
              kind: job.kind,
              task: job.task,
              schedule: job.schedule,
              timezone: job.timezone,
            }),
            contentType: 'SYSTEM',
            metadata: {
              internal: true,
              source: 'agent-cron',
              scheduleId: job.id,
              kind: job.kind,
            },
          },
        });

        await agentProcessQueue.add('agent:process', {
          agentId: job.agentId,
          channelId: job.channelId,
          messageId: triggerMessage.id,
        }, {
          jobId: `schedule:${job.id}:${runStartedAt.getTime()}`,
        });
      }

      await this.syncWorkspaceManifest(job.agentId);
    }
  }
}

export const agentCronService = new AgentCronService();
