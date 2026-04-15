/**
 * OpenAI Codex OAuth Provider — OAuth 2.0 Authorization Code Flow
 *
 * Extends OpenAIProvider — same API format, different auth mechanism.
 * Credentials are stored encrypted in GlobalProviderConfig (not env vars).
 *
 * OAuth Flow:
 * 1. Admin opens Settings → Providers → "Connect OpenAI Codex".
 * 2. GET /providers/oauth/codex/init → backend returns the OpenAI consent URL.
 * 3. User approves → OpenAI redirects to GET /providers/oauth/codex/callback?code=&state=.
 * 4. Backend exchanges code → access_token + refresh_token, encrypted into GlobalProviderConfig.
 * 5. On every LLM call, ensureTokenFresh() silently refreshes if within 60 s of expiry.
 *
 * Phase 5 implementation status:
 * - ensureTokenFresh() reads from and writes back to GlobalProviderConfig via the
 *   global credentials accessor provided at construction time.
 * - complete() and stream() delegate to OpenAIProvider after token refresh.
 * - Future: per-agent OAuth tokens if multi-account needed.
 */

import { createHash, randomBytes } from 'node:crypto';

import type { FinishReason, LLMMessage, LLMRequestOptions, LLMResponse, LLMStreamChunk, ToolCall } from '@nextgenchat/types';

import { encryptJson, decryptJson } from '@/lib/crypto.js';
import { prisma } from '@/db/client.js';
import { BaseProvider } from '@/modules/providers/base.provider.js';

interface CodexTextBlock { type: 'text'; text: string; }
interface CodexImageBlock { type: 'image'; mimeType: string; dataBase64: string; }
type CodexContentBlock = CodexTextBlock | CodexImageBlock;

const OPENAI_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OPENAI_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const OPENAI_CODEX_BASE_URL = 'https://chatgpt.com/backend-api';
const TOKEN_REFRESH_BUFFER_SECONDS = 60;
const OAUTH_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const OAUTH_SCOPE = 'openid profile email offline_access';

export interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: string; // ISO 8601
  scope?: string;
  accountId?: string;
}

function normalizeToolCallId(id: string) {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || `fc_${randomBytes(8).toString('hex')}`;
}

function splitSystemPrompt(messages: LLMMessage[], explicitSystemPrompt?: string) {
  const systemParts: string[] = [];
  const nonSystemMessages: LLMMessage[] = [];

  if (explicitSystemPrompt?.trim()) {
    systemParts.push(explicitSystemPrompt.trim());
  }

  for (const message of messages) {
    if (message.role === 'system') {
      const systemText = typeof message.content === 'string'
        ? message.content
        : (message.content as unknown as CodexContentBlock[]).filter((block): block is CodexTextBlock => block.type === 'text').map((block) => block.text).join('\n\n');
      if (systemText.trim()) systemParts.push(systemText.trim());
      continue;
    }

    nonSystemMessages.push(message);
  }

  return {
    instructions: systemParts.join('\n\n') || undefined,
    messages: nonSystemMessages,
  };
}

function convertCodexInput(messages: LLMMessage[]) {
  const input: Array<Record<string, unknown>> = [];

  for (const message of messages) {
    if (message.role === 'user') {
      input.push({
        role: 'user',
        content: typeof message.content === 'string'
          ? [{ type: 'input_text', text: message.content }]
          : (message.content as unknown as CodexContentBlock[]).map((block) => block.type === 'text'
            ? { type: 'input_text', text: block.text }
            : { type: 'input_image', image_url: `data:${block.mimeType};base64,${block.dataBase64}`, detail: 'auto' }),
      });
      continue;
    }

    if (message.role === 'assistant') {
      const assistantText = typeof message.content === 'string'
        ? message.content
        : (message.content as unknown as CodexContentBlock[]).filter((block): block is CodexTextBlock => block.type === 'text').map((block) => block.text).join('\n\n');

      if (assistantText) {
        input.push({
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: assistantText, annotations: [] }],
          id: `msg_${normalizeToolCallId(randomBytes(6).toString('hex'))}`,
        });
      }

      for (const toolCall of message.toolCalls ?? []) {
        input.push({
          type: 'function_call',
          id: `fc_${normalizeToolCallId(toolCall.id)}`,
          call_id: toolCall.id,
          name: toolCall.name,
          arguments: toolCall.arguments || '{}',
        });
      }
      continue;
    }

    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.toolCallId ?? '',
        output: message.content,
      });
    }
  }

  return input;
}

function buildCodexBody(model: string, options: LLMRequestOptions) {
  const { instructions, messages } = splitSystemPrompt(options.messages, options.systemPrompt);

  return {
    model,
    store: false,
    stream: true,
    instructions,
    input: convertCodexInput(messages),
    text: { verbosity: 'medium' },
    include: ['reasoning.encrypted_content'],
    tool_choice: options.tools?.length ? (options.toolChoice?.type === 'function' ? { type: 'function', name: options.toolChoice.name } : 'auto') : undefined,
    parallel_tool_calls: true,
    tools: options.tools?.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: false,
    })),
  };
}

function buildCodexHeaders(token: string, accountId: string) {
  const headers = new Headers();
  headers.set('Authorization', `Bearer ${token}`);
  headers.set('chatgpt-account-id', accountId);
  headers.set('originator', 'pi');
  headers.set('OpenAI-Beta', 'responses=experimental');
  headers.set('accept', 'text/event-stream');
  headers.set('content-type', 'application/json');
  headers.set('User-Agent', `nextgenchat (${process.platform} ${process.arch})`);
  return headers;
}

function resolveCodexUrl(baseUrl = OPENAI_CODEX_BASE_URL) {
  const normalized = baseUrl.replace(/\/+$/, '');
  if (normalized.endsWith('/codex/responses')) return normalized;
  if (normalized.endsWith('/codex')) return `${normalized}/responses`;
  return `${normalized}/codex/responses`;
}

async function* parseSse(response: Response) {
  if (!response.body) {
    throw new Error('Codex returned no response body.');
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });

    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      const dataLines = rawEvent
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .filter(Boolean);

      if (dataLines.length > 0) {
        const data = dataLines.join('\n');
        if (data !== '[DONE]') {
          yield JSON.parse(data) as Record<string, unknown>;
        }
      }

      boundary = buffer.indexOf('\n\n');
    }

    if (done) break;
  }
}

export class OpenAICodexOAuthProvider extends BaseProvider {
  override readonly name: import('@nextgenchat/types').ProviderName = 'openai-codex-oauth';

  override readonly supportedModels = [
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.3-codex',
    'gpt-5.3-codex-spark',
  ];

  private oauthCredentials: OAuthCredentials;

  constructor(credentials: OAuthCredentials, model: string) {
    super(credentials.accessToken, model);
    this.oauthCredentials = credentials;
  }

  /**
   * Refresh the access token if it is within TOKEN_REFRESH_BUFFER_SECONDS of
   * expiry. Writes the updated token back to GlobalProviderConfig.
   */
  private async ensureTokenFresh(): Promise<void> {
    const expiresAt = new Date(this.oauthCredentials.expiresAt).getTime();
    const nowMs = Date.now();
    const bufferMs = TOKEN_REFRESH_BUFFER_SECONDS * 1000;

    if (expiresAt - nowMs > bufferMs) {
      return; // Token is fresh enough
    }

    const response = await fetch(OPENAI_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.oauthCredentials.refreshToken,
        client_id: OPENAI_CODEX_CLIENT_ID,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI Codex OAuth token refresh failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      scope?: string;
    };

    const accountId = extractAccountId(data.access_token);

    this.oauthCredentials = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? this.oauthCredentials.refreshToken,
      expiresAt: new Date(Date.now() + data.expires_in * 1000).toISOString(),
      scope: data.scope ?? this.oauthCredentials.scope,
      accountId,
    };

    // Persist the refreshed token back to GlobalProviderConfig.
    await prisma.globalProviderConfig.update({
      where: { providerName: 'openai-codex-oauth' },
      data: { credentials: encryptJson(this.oauthCredentials) },
    });

  }

  private requireAccountId() {
    const accountId = this.oauthCredentials.accountId ?? extractAccountId(this.oauthCredentials.accessToken);
    if (!accountId) {
      throw new Error('OpenAI Codex OAuth token is missing account context. Reconnect Codex in Settings.');
    }

    this.oauthCredentials.accountId = accountId;
    return accountId;
  }

  private async createCodexResponse(options: LLMRequestOptions) {
    await this.ensureTokenFresh();
    const accountId = this.requireAccountId();

    const response = await fetch(resolveCodexUrl(), {
      method: 'POST',
      headers: buildCodexHeaders(this.oauthCredentials.accessToken, accountId),
      body: JSON.stringify(buildCodexBody(this.model, options)),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(text || `Codex request failed: ${response.status} ${response.statusText}`);
    }

    return response;
  }

  override async complete(options: LLMRequestOptions): Promise<LLMResponse> {
    let content = '';
    let toolCalls: ToolCall[] | undefined;
    let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 };
    let responseId = '';
    let finishReason: FinishReason = 'stop';

    for await (const chunk of this.stream(options)) {
      content += chunk.delta;
      if (chunk.toolCalls) toolCalls = chunk.toolCalls;
      if (chunk.usage) {
        usage = {
          promptTokens: chunk.usage.promptTokens,
          completionTokens: chunk.usage.completionTokens,
          totalTokens: chunk.usage.totalTokens,
          cachedTokens: chunk.usage.cachedTokens ?? 0,
        };
      }
      if (chunk.responseId) responseId = chunk.responseId;
      if (chunk.finishReason) finishReason = chunk.finishReason;
    }

    return {
      id: responseId || randomBytes(8).toString('hex'),
      content,
      finishReason,
      toolCalls,
      usage,
      providerMetadata: { model: this.model, transport: 'openai-codex-responses' },
    };
  }

  override async *stream(options: LLMRequestOptions): AsyncGenerator<LLMStreamChunk> {
    const response = await this.createCodexResponse(options);
    const toolBuffers = new Map<string, { id: string; name: string; arguments: string }>();
    let responseId = '';
    let finishReason: FinishReason = 'stop';
    let usage: LLMStreamChunk['usage'];

    for await (const event of parseSse(response)) {
      const type = typeof event.type === 'string' ? event.type : '';

      if (type === 'response.created') {
        responseId = typeof (event.response as { id?: unknown } | undefined)?.id === 'string'
          ? (event.response as { id: string }).id
          : responseId;
        continue;
      }

      if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
        const delta = typeof event.delta === 'string' ? event.delta : '';
        if (delta) yield { delta };
        continue;
      }

      if (type === 'response.output_item.added' && (event.item as { type?: unknown } | undefined)?.type === 'function_call') {
        const item = event.item as { call_id?: unknown; name?: unknown; arguments?: unknown };
        const id = typeof item.call_id === 'string' ? item.call_id : randomBytes(8).toString('hex');
        toolBuffers.set(id, {
          id,
          name: typeof item.name === 'string' ? item.name : 'tool',
          arguments: typeof item.arguments === 'string' ? item.arguments : '',
        });
        continue;
      }

      if (type === 'response.function_call_arguments.delta') {
        const itemId = typeof event.item_id === 'string' ? event.item_id : undefined;
        const delta = typeof event.delta === 'string' ? event.delta : '';
        if (itemId && toolBuffers.has(itemId)) {
          toolBuffers.get(itemId)!.arguments += delta;
        } else if (toolBuffers.size > 0) {
          const last = Array.from(toolBuffers.values()).at(-1);
          if (last) last.arguments += delta;
        }
        continue;
      }

      if (type === 'response.output_item.done' && (event.item as { type?: unknown } | undefined)?.type === 'function_call') {
        const item = event.item as { call_id?: unknown; name?: unknown; arguments?: unknown };
        const id = typeof item.call_id === 'string' ? item.call_id : randomBytes(8).toString('hex');
        toolBuffers.set(id, {
          id,
          name: typeof item.name === 'string' ? item.name : 'tool',
          arguments: typeof item.arguments === 'string' ? item.arguments : '{}',
        });
        continue;
      }

      if (type === 'response.failed' || type === 'error') {
        const message = typeof event.message === 'string'
          ? event.message
          : typeof (event.response as { error?: { message?: unknown } } | undefined)?.error?.message === 'string'
            ? String((event.response as { error: { message: string } }).error.message)
            : 'Codex request failed.';
        throw new Error(message);
      }

      if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.done') {
        const responsePayload = event.response as {
          id?: unknown;
          status?: unknown;
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            total_tokens?: number;
            input_tokens_details?: { cached_tokens?: number };
          };
        } | undefined;

        if (typeof responsePayload?.id === 'string') responseId = responsePayload.id;

        const cachedTokens = responsePayload?.usage?.input_tokens_details?.cached_tokens ?? 0;
        usage = {
          promptTokens: (responsePayload?.usage?.input_tokens ?? 0) - cachedTokens,
          completionTokens: responsePayload?.usage?.output_tokens ?? 0,
          totalTokens: responsePayload?.usage?.total_tokens ?? 0,
          cachedTokens,
        };

        const status = typeof responsePayload?.status === 'string' ? responsePayload.status : 'completed';
        finishReason = status === 'incomplete' ? 'length' : status === 'failed' || status === 'cancelled' ? 'error' : toolBuffers.size > 0 ? 'tool_calls' : 'stop';

        yield {
          delta: '',
          toolCalls: toolBuffers.size > 0 ? Array.from(toolBuffers.values()) : undefined,
          finishReason,
          responseId,
          usage,
          providerMetadata: { model: this.model, transport: 'openai-codex-responses' },
        };
        return;
      }
    }
  }
}

// ── OAuth helpers used by the routes layer ────────────────────────────────────

function base64UrlEncode(buffer: Buffer) {
  return buffer.toString('base64url');
}

function sha256Base64Url(input: string) {
  return base64UrlEncode(createHash('sha256').update(input).digest());
}

export function generateCodexPkce() {
  const verifier = base64UrlEncode(randomBytes(32));
  const challenge = sha256Base64Url(verifier);

  return { verifier, challenge };
}

export function extractAccountId(accessToken: string) {
  try {
    const parts = accessToken.split('.');
    if (parts.length !== 3) return undefined;

    const payload = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')) as {
      'https://api.openai.com/auth'?: { chatgpt_account_id?: unknown };
    };

    const accountId = payload['https://api.openai.com/auth']?.chatgpt_account_id;
    return typeof accountId === 'string' && accountId.trim() ? accountId : undefined;
  } catch {
    return undefined;
  }
}

export function buildCodexAuthUrl(state: string, redirectUri: string, codeChallenge: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: OPENAI_CODEX_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: OAUTH_SCOPE,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: 'pi',
  });
  return `${OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

export async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<OAuthCredentials> {
  const response = await fetch(OPENAI_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: OPENAI_CODEX_CLIENT_ID,
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI Codex OAuth token exchange failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope?: string;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + data.expires_in * 1000).toISOString(),
    scope: data.scope,
    accountId: extractAccountId(data.access_token),
  };
}

export function decryptOAuthCredentials(encryptedCredentials: string): OAuthCredentials {
  return decryptJson<OAuthCredentials>(encryptedCredentials);
}
