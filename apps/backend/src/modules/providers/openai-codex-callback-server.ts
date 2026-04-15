/**
 * OpenAI Codex OAuth Callback Server
 *
 * Runs a tiny localhost-only callback server on port 1455 so OpenAI Codex OAuth
 * can complete against the same redirect URI OpenClaw uses.
 *
 * Phase 5 implementation status:
 * - Handles both setup-time and settings-time Codex OAuth callbacks.
 * - Exchanges the code, persists credentials, and redirects back to the web app.
 * - Future phases can add richer callback diagnostics and expiry cleanup.
 */

import http from 'node:http';

import { Prisma } from '@prisma/client';

import { env } from '@/config/env.js';
import { prisma } from '@/db/client.js';
import { redis } from '@/lib/redis.js';
import { encryptJson } from '@/lib/crypto.js';
import { providerRegistry } from '@/modules/providers/registry.js';
import { exchangeCodeForTokens } from '@/modules/providers/openai-codex-oauth.provider.js';

const CALLBACK_PORT = 1455;
const CALLBACK_HOST = '127.0.0.1';
const CALLBACK_PATH = '/auth/callback';
const SETUP_PENDING_CODEX_KEY = 'SETUP_PENDING_PROVIDER_OPENAI_CODEX_OAUTH';
export const CODEX_OAUTH_REDIRECT_URI = 'http://localhost:1455/auth/callback';

type CodexOAuthState = {
  mode: 'setup' | 'settings';
  verifier: string;
};

let callbackServer: http.Server | null = null;
let callbackServerReady: Promise<void> | null = null;

function sendHtml(res: http.ServerResponse, statusCode: number, title: string, body: string) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family: sans-serif; padding: 24px;"><h1>${title}</h1><p>${body}</p></body></html>`);
}

async function consumeState(state: string) {
  const raw = await redis.get(`oauth:state:${state}`);
  if (!raw) {
    return null;
  }

  await redis.del(`oauth:state:${state}`);

  try {
    const parsed = JSON.parse(raw) as CodexOAuthState;
    if ((parsed.mode === 'setup' || parsed.mode === 'settings') && typeof parsed.verifier === 'string' && parsed.verifier) {
      return parsed;
    }
  } catch {
    return null;
  }

  return null;
}

async function persistCallbackResult(mode: CodexOAuthState['mode'], code: string, verifier: string) {
  const creds = await exchangeCodeForTokens(code, CODEX_OAUTH_REDIRECT_URI, verifier);

  if (mode === 'setup') {
    await prisma.systemSetting.upsert({
      where: { key: SETUP_PENDING_CODEX_KEY },
      update: { value: creds as unknown as Prisma.InputJsonValue },
      create: { key: SETUP_PENDING_CODEX_KEY, value: creds as unknown as Prisma.InputJsonValue },
    });

    return `${env.APP_URL}/setup?provider=openai-codex-oauth&connected=true`;
  }

  await prisma.globalProviderConfig.upsert({
    where: { providerName: 'openai-codex-oauth' },
    update: { credentials: encryptJson(creds), isActive: true },
    create: { providerName: 'openai-codex-oauth', credentials: encryptJson(creds), isActive: true },
  });

  providerRegistry.invalidateProvider('openai-codex-oauth');
  return `${env.APP_URL}/settings?provider=openai-codex-oauth&connected=true`;
}

async function handleCallback(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? '', `http://${CALLBACK_HOST}:${CALLBACK_PORT}`);

  if (url.pathname !== CALLBACK_PATH) {
    sendHtml(res, 404, 'Not found', 'This callback path does not exist.');
    return;
  }

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (!code || !state) {
    sendHtml(res, 400, 'Authentication Error', 'Missing code or state parameter.');
    return;
  }

  const oauthState = await consumeState(state);
  if (!oauthState) {
    sendHtml(res, 400, 'Authentication Error', 'OAuth state is missing or expired.');
    return;
  }

  try {
    const redirectUrl = await persistCallbackResult(oauthState.mode, code, oauthState.verifier);
    res.statusCode = 302;
    res.setHeader('Location', redirectUrl);
    res.end();
  } catch (error) {
    sendHtml(
      res,
      500,
      'Authentication Error',
      error instanceof Error ? error.message : 'OAuth exchange failed.',
    );
  }
}

export async function ensureCodexOAuthCallbackServerStarted() {
  if (callbackServerReady) {
    await callbackServerReady;
    return;
  }

  callbackServerReady = new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      void handleCallback(req, res);
    });

    server.once('error', (error) => {
      callbackServerReady = null;
      reject(error);
    });

    server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
      callbackServer = server;
      resolve();
    });
  });

  await callbackServerReady;
}

export async function closeCodexOAuthCallbackServer() {
  if (!callbackServer) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    callbackServer?.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

  callbackServer = null;
  callbackServerReady = null;
}
