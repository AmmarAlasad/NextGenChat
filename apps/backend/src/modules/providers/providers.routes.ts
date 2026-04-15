/**
 * Provider Administration Routes
 *
 * REST API for managing global LLM provider credentials, per-agent provider
 * selection, fallback provider configuration, and the OpenAI Codex OAuth flow.
 *
 * Phase 5 implementation status:
 * - GET  /providers              — list all providers with configured status
 * - PUT  /providers/:name        — save or update global API key credentials
 * - DELETE /providers/:name      — remove global credentials
 * - GET  /providers/:name/models — list available models (OpenRouter: live; others: static)
 * - GET  /providers/fallback     — get fallback provider setting
 * - PUT  /providers/fallback     — set or clear fallback provider
 * - PUT  /agents/:id/provider    — update per-agent provider and model
 * - GET  /providers/oauth/codex/init     — start OpenAI Codex OAuth flow
 *
 * Future: per-provider health checks, usage analytics, multi-account OAuth.
 */

import { randomBytes } from 'node:crypto';

import type { FastifyPluginAsync } from 'fastify';

import {
  PROVIDER_METADATA,
  STATIC_PROVIDER_MODELS,
  SetApiKeyCredentialSchema,
  SetFallbackProviderSchema,
  UpdateAgentProviderSchema,
} from '@nextgenchat/types';

import { prisma } from '@/db/client.js';
import { decryptJson, encryptJson } from '@/lib/crypto.js';
import { authService } from '@/modules/auth/auth.service.js';
import { authenticateRequest, requireAuthUser } from '@/middleware/auth.js';
import { redis } from '@/lib/redis.js';
import {
  buildCodexAuthUrl,
  generateCodexPkce,
} from '@/modules/providers/openai-codex-oauth.provider.js';
import { CODEX_OAUTH_REDIRECT_URI, ensureCodexOAuthCallbackServerStarted } from '@/modules/providers/openai-codex-callback-server.js';
import { OpenRouterProvider } from '@/modules/providers/openrouter.provider.js';
import { providerRegistry } from '@/modules/providers/registry.js';
import { env } from '@/config/env.js';

const FALLBACK_PROVIDER_KEY = 'FALLBACK_PROVIDER';
const OAUTH_STATE_TTL = 60 * 10; // 10 minutes
const SETUP_PENDING_CODEX_KEY = 'SETUP_PENDING_PROVIDER_OPENAI_CODEX_OAUTH';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function listAllProviders(options?: { includeSetupPendingCodex?: boolean }) {
  const allNames = Object.keys(PROVIDER_METADATA);

  const globalConfigs = await prisma.globalProviderConfig.findMany({
    where: { providerName: { in: allNames } },
  });
  const configMap = Object.fromEntries(globalConfigs.map((c) => [c.providerName, c]));
  const pendingSetupCodex = options?.includeSetupPendingCodex
    ? await prisma.systemSetting.findUnique({ where: { key: SETUP_PENDING_CODEX_KEY } })
    : null;

  return allNames.map((name) => {
    const meta = PROVIDER_METADATA[name];
    const global = configMap[name];

    let isConfigured = false;
    let oauthExpiresAt: string | null = null;

    if (global?.isActive) {
      if (meta.authKind === 'oauth') {
        try {
          const creds = decryptJson<{ expiresAt: string }>(global.credentials);
          isConfigured = Boolean(creds?.expiresAt);
          oauthExpiresAt = creds?.expiresAt ?? null;
        } catch { /* not configured */ }
      } else {
        try {
          const creds = decryptJson<{ apiKey: string }>(global.credentials);
          isConfigured = Boolean(creds?.apiKey);
        } catch { /* not configured */ }
      }
    }

    if (!isConfigured && name === 'openai-codex-oauth' && pendingSetupCodex) {
      isConfigured = true;
    }

    // Also check env var fallback for API key providers.
    if (!isConfigured && meta.authKind === 'api_key') {
      const envFallbacks: Record<string, string | undefined> = {
        openai: env.OPENAI_API_KEY && env.OPENAI_API_KEY !== 'disabled-local-key' ? env.OPENAI_API_KEY : undefined,
        anthropic: process.env.ANTHROPIC_API_KEY,
        kimi: process.env.KIMI_API_KEY,
        openrouter: process.env.OPENROUTER_API_KEY,
      };
      isConfigured = Boolean(envFallbacks[name]);
    }

    return {
      providerName: name,
      label: meta.label,
      authKind: meta.authKind,
      isConfigured,
      isActive: Boolean(global?.isActive) || isConfigured,
      oauthExpiresAt,
    };
  });
}

async function getProviderModels(providerName: string) {
  if (providerName === 'openrouter') {
    const global = await prisma.globalProviderConfig.findUnique({
      where: { providerName: 'openrouter' },
    });

    const envKey = process.env.OPENROUTER_API_KEY;
    let apiKey: string | undefined;

    if (global?.isActive) {
      try {
        const creds = decryptJson<{ apiKey: string }>(global.credentials);
        apiKey = creds.apiKey;
      } catch {
        apiKey = undefined;
      }
    }

    apiKey = apiKey ?? envKey;

    if (!apiKey) {
      throw new Error('OpenRouter API key is not configured.');
    }

    const provider = new OpenRouterProvider(apiKey, 'openai/gpt-4o');
    return provider.listModels();
  }

  return STATIC_PROVIDER_MODELS[providerName] ?? [];
}

async function requireSetupMode(reply: { status: (code: number) => { send: (body: unknown) => unknown } }) {
  if (!(await authService.getSetupRequired())) {
    reply.status(403).send({ error: 'Setup has already been completed.' });
    return false;
  }

  return true;
}

// ── Routes ────────────────────────────────────────────────────────────────────

export const providersRoutes: FastifyPluginAsync = async (fastify) => {
  // ── Public setup-time provider routes ─────────────────────────────────────

  fastify.get('/auth/setup/providers', async (_request, reply) => {
    if (!(await requireSetupMode(reply))) return;
    return listAllProviders({ includeSetupPendingCodex: true });
  });

  fastify.get('/auth/setup/providers/:name/models', async (request, reply) => {
    if (!(await requireSetupMode(reply))) return;

    const params = request.params as { name: string };

    try {
      return { providerName: params.name, models: await getProviderModels(params.name) };
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : 'Failed to load provider models.' });
    }
  });

  fastify.get('/auth/setup/oauth/codex/init', async (_request, reply) => {
    if (!(await requireSetupMode(reply))) return;

    await ensureCodexOAuthCallbackServerStarted();

    const state = randomBytes(24).toString('hex');
    const pkce = generateCodexPkce();

    try {
      await redis.set(`oauth:state:${state}`, JSON.stringify({ mode: 'setup', verifier: pkce.verifier }), 'EX', OAUTH_STATE_TTL);
    } catch {
      // Redis unavailable — degraded CSRF protection in local single-node mode.
    }

    const authUrl = buildCodexAuthUrl(state, CODEX_OAUTH_REDIRECT_URI, pkce.challenge);
    return reply.send({ authUrl, state });
  });

  // ── List all providers ────────────────────────────────────────────────────

  fastify.get('/providers', { preHandler: authenticateRequest }, async () => {
    return listAllProviders();
  });

  // ── Get fallback provider ─────────────────────────────────────────────────

  fastify.get('/providers/fallback', { preHandler: authenticateRequest }, async () => {
    const setting = await prisma.systemSetting.findUnique({
      where: { key: FALLBACK_PROVIDER_KEY },
    });

    if (!setting) {
      return { providerName: null, model: null };
    }

    return setting.value as { providerName: string | null; model: string | null };
  });

  // ── Set fallback provider ─────────────────────────────────────────────────

  fastify.put('/providers/fallback', { preHandler: authenticateRequest }, async (request) => {
    const input = SetFallbackProviderSchema.parse(request.body);

    await prisma.systemSetting.upsert({
      where: { key: FALLBACK_PROVIDER_KEY },
      update: { value: input },
      create: { key: FALLBACK_PROVIDER_KEY, value: input },
    });

    return input;
  });

  // ── OAuth: initiate OpenAI Codex flow ─────────────────────────────────────

  fastify.get('/providers/oauth/codex/init', { preHandler: authenticateRequest }, async (_request, reply) => {
    await ensureCodexOAuthCallbackServerStarted();

    const state = randomBytes(24).toString('hex');
    const pkce = generateCodexPkce();

    try {
      await redis.set(`oauth:state:${state}`, JSON.stringify({ mode: 'settings', verifier: pkce.verifier }), 'EX', OAUTH_STATE_TTL);
    } catch {
      // Redis unavailable — use a short-lived in-memory state (single-server only).
    }

    const authUrl = buildCodexAuthUrl(state, CODEX_OAUTH_REDIRECT_URI, pkce.challenge);
    return reply.send({ authUrl, state });
  });

  // ── Set global API key credentials ────────────────────────────────────────

  fastify.put('/providers/:name', { preHandler: authenticateRequest }, async (request, reply) => {
    requireAuthUser(request);
    const params = request.params as { name: string };
    const input = SetApiKeyCredentialSchema.parse(request.body);

    if (input.providerName !== params.name) {
      return reply.status(400).send({ error: 'providerName in body must match URL parameter.' });
    }

    if (PROVIDER_METADATA[params.name]?.authKind !== 'api_key') {
      return reply.status(400).send({ error: 'This provider uses OAuth, not an API key.' });
    }

    await prisma.globalProviderConfig.upsert({
      where: { providerName: params.name },
      update: { credentials: encryptJson({ apiKey: input.apiKey }), isActive: true },
      create: {
        providerName: params.name,
        credentials: encryptJson({ apiKey: input.apiKey }),
        isActive: true,
      },
    });

    providerRegistry.invalidateProvider(params.name);

    return { ok: true };
  });

  // ── Remove global credentials ─────────────────────────────────────────────

  fastify.delete('/providers/:name', { preHandler: authenticateRequest }, async (request, reply) => {
    requireAuthUser(request);
    const params = request.params as { name: string };

    const existing = await prisma.globalProviderConfig.findUnique({
      where: { providerName: params.name },
    });

    if (!existing) {
      return reply.status(404).send({ error: 'Provider credential not found.' });
    }

    await prisma.globalProviderConfig.delete({
      where: { providerName: params.name },
    });

    providerRegistry.invalidateProvider(params.name);

    return { ok: true };
  });

  // ── List models for a provider ────────────────────────────────────────────

  fastify.get('/providers/:name/models', { preHandler: authenticateRequest }, async (request, reply) => {
    const params = request.params as { name: string };
    const providerName = params.name;

    try {
      return { providerName, models: await getProviderModels(providerName) };
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : 'Failed to load provider models.' });
    }
  });

  // ── Update per-agent provider ─────────────────────────────────────────────

  fastify.put('/agents/:id/provider', { preHandler: authenticateRequest }, async (request, reply) => {
    const authUser = requireAuthUser(request);
    const params = request.params as { id: string };
    const input = UpdateAgentProviderSchema.parse(request.body);

    // Verify ownership.
    const agent = await prisma.agent.findUnique({
      where: { id: params.id },
      include: {
        workspace: {
          select: {
            memberships: { where: { userId: authUser.id }, select: { id: true }, take: 1 },
          },
        },
      },
    });

    if (!agent || agent.workspace.memberships.length === 0) {
      return reply.status(403).send({ error: 'You do not have access to this agent.' });
    }

    await prisma.providerConfig.upsert({
      where: { agentId: params.id },
      update: { providerName: input.providerName, model: input.model },
      create: {
        agentId: params.id,
        providerName: input.providerName,
        model: input.model,
        credentials: encryptJson({}),
        config: { temperature: 0.4, maxTokens: 1024 },
      },
    });

    providerRegistry.invalidate(params.id);

    return { ok: true, providerName: input.providerName, model: input.model };
  });
};
