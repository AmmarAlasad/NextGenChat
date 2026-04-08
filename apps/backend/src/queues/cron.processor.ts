/**
 * Cron Worker
 *
 * Runs the in-process scheduler loop for agent wakeups and recurring work.
 * The implementation is cross-platform and does not rely on OS-specific cron.
 *
 * Phase 4 implementation status:
 * - Polls due schedules from Prisma at a fixed interval.
 * - Enqueues scheduled agent turns through the normal agent job pipeline.
 * - Future phases can replace this with a distributed scheduler in shared mode.
 */

import { agentCronService } from '../modules/agents/agent-cron.service.js';

const CRON_POLL_INTERVAL_MS = 15_000;

export interface CronProcessorHandle {
  close(): Promise<void>;
}

export function createCronProcessorWorker(): CronProcessorHandle {
  let closed = false;
  let running = false;

  const tick = async () => {
    if (closed || running) {
      return;
    }

    running = true;
    try {
      await agentCronService.triggerDueSchedules();
    } catch (error) {
      console.error('Cron processor tick failed', error);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, CRON_POLL_INTERVAL_MS);

  void tick();

  return {
    async close() {
      closed = true;
      clearInterval(timer);
    },
  };
}
