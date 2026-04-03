# NextGenChat — Master Project Plan

> **Vision:** A collaborative platform where humans and AI agents coexist in chat workspaces. Agents have persistent memory, identities, tool access, and workspaces. The system launches as a local-only personal tool, then scales to friends and mobile without breaking existing users or requiring architecture rewrites.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Deployment Mode Strategy](#2-deployment-mode-strategy)
3. [Tech Stack](#3-tech-stack)
4. [Monorepo Structure](#4-monorepo-structure)
5. [Phase 0 — Foundation & Local Dev](#5-phase-0--foundation--local-dev)
6. [Phase 1 — Auth (Local-First, Scales to Multi-User)](#6-phase-1--auth-local-first-scales-to-multi-user)
7. [Phase 2 — Core Real-Time Chat & Persistence](#7-phase-2--core-real-time-chat--persistence)
8. [Phase 3A — LLM Provider Layer](#8-phase-3a--llm-provider-layer)
9. [Phase 3B — Context Window Management](#9-phase-3b--context-window-management)
10. [Phase 3C — AI Agent System](#10-phase-3c--ai-agent-system)
11. [Phase 4 — Workspace & File Management](#11-phase-4--workspace--file-management)
12. [Phase 5 — Rules Engine](#12-phase-5--rules-engine)
13. [Phase 6 — MCP Integration](#13-phase-6--mcp-integration)
14. [Phase 7 — Friends Access (Network Mode)](#14-phase-7--friends-access-network-mode)
15. [Phase 8 — Mobile App (React Native)](#15-phase-8--mobile-app-react-native)
16. [Phase 9 — Observability & Production Hardening](#16-phase-9--observability--production-hardening)
17. [Security Strategy (Cross-Cutting, Mode-Aware)](#17-security-strategy-cross-cutting-mode-aware)
18. [UX Principles & Suggestions](#18-ux-principles--suggestions)
19. [Ticket Creation Guide](#19-ticket-creation-guide)

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                          CLIENTS                                │
│  ┌──────────────┐   ┌───────────────┐   ┌──────────────────┐   │
│  │  Next.js     │   │ React Native  │   │  Third-party /   │   │
│  │  Web App     │   │ Mobile (Ph.8) │   │  Future APIs     │   │
│  └──────┬───────┘   └──────┬────────┘   └────────┬─────────┘   │
└─────────┼─────────────────┼────────────────────── ┼────────────┘
          │                 │                        │
          │        REST + WebSocket (Socket.io)       │
          ▼                 ▼                        ▼
┌─────────────────────────────────────────────────────────────────┐
│              REVERSE PROXY  (Caddy / Nginx)                     │
│         [LOCAL: localhost only]  [SHARED: TLS + domain]         │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│                BACKEND  (TypeScript / Node.js / Fastify)        │
│                                                                 │
│  ┌───────────────┐  ┌──────────────┐  ┌──────────────────────┐ │
│  │   REST API    │  │  Socket.io   │  │    Agent Runner      │ │
│  │   (Fastify)   │  │  Server      │  │  (BullMQ workers)    │ │
│  └───────┬───────┘  └──────┬───────┘  └──────────┬───────────┘ │
│          └─────────────────┴─────────────────────┘             │
│                             │                                   │
│  ┌──────────┐  ┌────────────┴─┐  ┌──────────┐  ┌───────────┐  │
│  │PostgreSQL│  │    Redis     │  │  BullMQ  │  │  MinIO /  │  │
│  │(primary) │  │(pub-sub,     │  │  (jobs,  │  │  S3       │  │
│  │          │  │ sessions,    │  │  cron)   │  │  (files)  │  │
│  │          │  │ cache, ratelim)│ │          │  │           │  │
│  └──────────┘  └──────────────┘  └──────────┘  └───────────┘  │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │             LLM PROVIDER LAYER                           │  │
│  │  OpenAI · OpenAI Codex OAuth · Anthropic · Kimi · OpenRouter│  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

**Core decisions (locked):**
- Single backend serves all clients: web, mobile, future integrations — same REST + WebSocket API
- Socket.io over raw WebSockets — rooms, namespaces, Redis adapter for horizontal scaling, React Native SDK exists
- Redis Pub/Sub via `@socket.io/redis-adapter` — required for multi-instance broadcasting
- BullMQ for all async work — LLM calls, agent jobs, cron, file scanning. Never block the request cycle
- `@nextgenchat/types` package — Zod schemas + TypeScript types shared across backend, web, and mobile

---

## 2. Deployment Mode Strategy

The project evolves through four modes. Architecture decisions made today must not block future modes.

```
MODE 1: LOCAL       MODE 2: SHARED       MODE 3: MOBILE        MODE 4: CLOUD
──────────────      ──────────────       ──────────────        ──────────────
Your machine only   Friends can join     iOS / Android app     Multi-tenant SaaS
Single user         Invite-only          Connects to Mode 2    Kubernetes
localhost           Network exposed      backend               Auto-scaling
Docker Compose      TLS required         Push notifications    Full observability
No TLS needed       Rate limits critical Certificate pinning   Backup/DR
API keys in .env    Email invites        Biometric auth        Compliance
Simple auth setup   Full RBAC            SecureStore tokens
```

### What changes at each mode transition

**Local → Shared (Phase 7):**
- TLS certificate required (Caddy auto-TLS or Let's Encrypt)
- Registration system moves from "owner setup wizard" to invite-only registration
- Rate limiting becomes critical (network-exposed endpoints)
- CORS configured for actual domain
- Email/SMTP configured for invitations
- API keys move from `.env` to encrypted DB storage per workspace

**Shared → Mobile (Phase 8):**
- Push notification infrastructure (FCM + APNs)
- Mobile-specific auth endpoint (device-bound, longer-lived token)
- Certificate pinning in app
- Backend unchanged — mobile is just another client

**Shared → Cloud (Phase 9+):**
- PostgreSQL → managed RDS
- Redis → ElastiCache
- MinIO → S3
- Docker Compose → Kubernetes
- Secrets → HashiCorp Vault or AWS Secrets Manager
- Add read replicas, connection pooling (PgBouncer)

> **Rule:** Each mode transition should require **no breaking changes** to the existing database schema or API contracts. Additions only.

---

## 3. Tech Stack

### Backend
| Layer | Choice | Rationale |
|---|---|---|
| Runtime | Node.js 22 LTS + TypeScript 5 | Stable LTS, great ecosystem, type safety |
| Framework | Fastify | Faster than Express, built-in schema validation, TypeScript-native |
| Real-time | Socket.io 4 | Rooms, namespaces, Redis adapter, React Native SDK exists |
| ORM | Prisma | Type-safe queries, migrations, no raw SQL drift |
| Database | PostgreSQL 16 | ACID, JSONB columns for agent memory/config, full-text search |
| Cache / PubSub | Redis 7 | Socket.io scaling, session store, rate-limit counters, context cache |
| Job Queue | BullMQ | Agent cron jobs, async LLM calls, retries, delayed jobs |
| Auth | JWT (access) + refresh tokens in httpOnly cookies | Stateless scale + secure rotation |
| File Storage | MinIO (local/self-hosted), AWS S3 (cloud) | Unified S3-compatible API |
| Validation | Zod | Runtime + compile-time, shared with frontend and mobile |
| Password Hashing | Argon2id | Current security standard (not bcrypt) |
| Testing | Vitest + Supertest | Fast, ESM-native |
| Linting | ESLint + Prettier | Consistent codebase |

### Frontend (Web)
| Layer | Choice | Rationale |
|---|---|---|
| Framework | Next.js 15 (App Router) | SSR, file-based routing, React Server Components |
| Language | TypeScript 5 | Shared types with backend |
| Styling | Tailwind CSS + shadcn/ui | Rapid UI, accessible components out of the box |
| State | Zustand (UI state) + TanStack Query (server state) | Clean separation |
| Real-time | Socket.io client | Matches backend |
| Forms | React Hook Form + Zod | Validated forms with shared schemas |
| Virtualization | TanStack Virtual | Render only visible messages in long channels |
| Testing | Vitest + Testing Library + Playwright | Unit + E2E |

### Mobile (Phase 8 — Future)
| Layer | Choice | Rationale |
|---|---|---|
| Framework | React Native + Expo | Share hooks/types/schemas with web |
| Real-time | Socket.io React Native client | Same backend socket API |
| Navigation | Expo Router | File-based routing consistent with Next.js |
| Token Storage | Expo SecureStore | Hardware-backed, not AsyncStorage |

### DevOps / Infrastructure
| Layer | Local Mode | Shared/Cloud Mode |
|---|---|---|
| Containers | Docker Compose | Kubernetes |
| Proxy | Caddy (auto-TLS) | Nginx or Caddy |
| CI/CD | GitHub Actions | GitHub Actions |
| Secrets | `.env` (local) | Doppler / AWS Secrets Manager |
| Monitoring | Pino logs to stdout | OpenTelemetry + Grafana stack |

---

## 4. Monorepo Structure

```
nextgenchat/
├── apps/
│   ├── backend/
│   │   ├── src/
│   │   │   ├── config/           # env validation (Zod, fail fast on startup)
│   │   │   ├── db/               # Prisma client singleton
│   │   │   ├── modules/
│   │   │   │   ├── auth/         # JWT, sessions, setup wizard
│   │   │   │   ├── chat/         # Messages, channels, reactions
│   │   │   │   ├── providers/    # LLM provider layer (NEW — see Phase 3A)
│   │   │   │   │   ├── base.provider.ts
│   │   │   │   │   ├── openai.provider.ts
│   │   │   │   │   ├── openai-codex-oauth.provider.ts
│   │   │   │   │   ├── anthropic.provider.ts
│   │   │   │   │   ├── kimi.provider.ts
│   │   │   │   │   └── openrouter.provider.ts
│   │   │   │   ├── context/      # Context window management (NEW — see Phase 3B)
│   │   │   │   │   ├── token-counter.ts
│   │   │   │   │   ├── compaction.service.ts
│   │   │   │   │   └── cache.service.ts
│   │   │   │   ├── agents/
│   │   │   │   ├── workspace/
│   │   │   │   ├── rules/
│   │   │   │   └── mcp/
│   │   │   ├── sockets/          # Socket.io event handlers + rooms
│   │   │   ├── queues/           # BullMQ workers and producers
│   │   │   └── middleware/       # Auth, rate-limit, logging
│   │   ├── prisma/
│   │   │   └── schema.prisma
│   │   └── tests/
│   │
│   ├── web/
│   │   ├── app/                  # Next.js App Router pages
│   │   ├── components/
│   │   ├── hooks/
│   │   ├── lib/
│   │   │   ├── api.ts            # Typed fetch client
│   │   │   └── socket.ts         # Socket.io singleton
│   │   └── tests/
│   │
│   └── mobile/                   # Phase 8 — not yet scaffolded
│
├── packages/
│   ├── types/                    # Single source of truth for all contracts
│   │   └── src/
│   │       ├── auth.ts
│   │       ├── chat.ts
│   │       ├── agents.ts
│   │       ├── providers.ts      # Provider config types + Zod schemas
│   │       ├── context.ts        # Context window types
│   │       ├── workspace.ts
│   │       └── socket-events.ts  # Discriminated union of all socket events
│   │
│   └── config/                   # Shared ESLint, Prettier, tsconfig.base.json
│
├── docker/
│   ├── docker-compose.yml        # LOCAL mode: postgres, redis, minio, backend, web
│   └── docker-compose.test.yml
│
├── .github/
│   └── workflows/
│       ├── ci.yml
│       └── deploy.yml
│
├── pnpm-workspace.yaml
└── turbo.json
```

---

## 5. Phase 0 — Foundation & Local Dev

**Goal:** Clone the repo, run `docker compose up`, have the full stack running. No configuration required except adding API keys.

### Tasks

#### P0-01 — Monorepo Scaffolding
- Initialize pnpm workspace + Turborepo
- Create all `apps/` and `packages/` directories
- `tsconfig.base.json` extended by all packages
- Shared ESLint + Prettier config in `packages/config`
- `.nvmrc` pinned to Node 22

#### P0-02 — Docker Compose (Local Mode)
- PostgreSQL 16 with health check + persistent volume
- Redis 7 with persistent volume
- MinIO with persistent volume + auto-creates `nextgenchat` bucket on first start
- Backend with hot reload (`tsx --watch`)
- Frontend with `next dev`
- All services networked together, no ports exposed beyond `localhost`
- Single `docker compose up` brings everything up

#### P0-03 — Backend Bootstrap
- Fastify server with TypeScript
- Zod env validation on startup — server refuses to start if required env vars missing
- Prisma client setup with `schema.prisma`
- Health check: `GET /health` returns `{ status, version, db: "ok"|"error", redis: "ok"|"error" }`
- Graceful shutdown: SIGTERM/SIGINT drain active connections before exit
- Pino logger configured from start (JSON in prod, pretty in dev)

#### P0-04 — Frontend Bootstrap
- Next.js 15 App Router + TypeScript
- Tailwind CSS + shadcn/ui
- `lib/api.ts` — typed fetch client, reads `NEXT_PUBLIC_API_URL` from env
- `lib/socket.ts` — Socket.io singleton, auto-reconnects
- Dark mode support from day one (`dark:` Tailwind variants, respects system preference)

#### P0-05 — Shared Types Package
- All Zod schemas defined in `packages/types`
- TypeScript types inferred from Zod schemas (never manually duplicated)
- Socket event contracts as discriminated unions in `socket-events.ts`
- Provider config schemas in `providers.ts`

#### P0-06 — CI Pipeline (GitHub Actions)
- On every PR: `pnpm lint`, `pnpm typecheck`, `pnpm test`
- `pnpm audit` — fail on high/critical vulnerabilities
- Branch protection: PRs require green CI

**Security actions in Phase 0:**
- `.env.example` committed with all keys documented, `.env` in `.gitignore`
- Secret scanning in CI (git-leaks or detect-secrets action)
- Husky pre-commit: lint + typecheck before every commit
- Lockfile (`pnpm-lock.yaml`) committed and verified in CI

---

## 6. Phase 1 — Auth (Local-First, Scales to Multi-User)

**Goal:** Local mode uses a one-time owner setup wizard. The same auth system later supports multi-user invite registration without a rewrite.

### Local Mode vs. Shared Mode Auth

| Concern | Local Mode | Shared Mode (Phase 7) |
|---|---|---|
| Registration | Setup wizard on first run | Invite-only, email-verified |
| TLS | Not required (localhost) | Required |
| Rate limiting | Disabled or very relaxed | Strict (network-exposed) |
| Email/SMTP | Not required | Required for invites |
| Session storage | Local Redis | Same |

### Tasks

#### P1-01 — First-Run Setup Wizard
- On fresh install, DB has no users — backend returns `{ setupRequired: true }` from `GET /health`
- Frontend detects this and redirects to `/setup`
- Setup wizard: owner username + password (no email required in local mode)
- After setup: owner account created, wizard endpoint disabled forever
- `SETUP_COMPLETE` flag written to DB config table

#### P1-02 — Login & Token Issuance
- `POST /auth/login` — username/email + password
- Password verified with Argon2id
- On success: **short-lived JWT access token** (15 min) + **refresh token** (7 days)
- Access token: returned in response body, stored in memory on client (not `localStorage`)
- Refresh token: stored in `httpOnly; Secure; SameSite=Strict` cookie
- Failed login: generic "invalid credentials" message, increment counter in Redis
- Account lockout after 10 failures: 15-minute lock (not permanent)

#### P1-03 — Token Refresh & Logout
- `POST /auth/refresh` — reads httpOnly cookie, issues new access token
- **Refresh token rotation**: old token invalidated on every use
- Refresh tokens stored in `refresh_tokens` DB table (revocable)
- `POST /auth/logout` — delete refresh token from DB + clear cookie

#### P1-04 — Auth Middleware
- Fastify `preHandler` hook: verify JWT signature + expiry
- Decoded user attached to `request.user`
- Socket.io: access token verified on `connection` handshake (`socket.handshake.auth.token`)
- Unauthorized socket connections disconnected immediately

#### P1-05 — RBAC (Workspace-Scoped Roles)
- Roles: `OWNER`, `ADMIN`, `MEMBER`, `VIEWER`
- Roles scoped to workspace — one user can be ADMIN in workspace A and MEMBER in workspace B
- DB: `workspace_memberships(userId, workspaceId, role, joinedAt)`
- Route decorator: `requireRole(['ADMIN', 'OWNER'])` applied as Fastify `preHandler`

#### P1-06 — Invite-Only Registration (Shared Mode — activated in Phase 7)
- `POST /auth/invite` — admin generates invite link with signed JWT (48h expiry)
- `POST /auth/register` — only accepts requests with valid invite token
- Email + password + invite token required
- Email verification sent after registration
- **Do not** enable open registration — invite-only by default forever

#### P1-07 — Password Reset
- `POST /auth/forgot-password` — sends reset link if email exists (always returns 200)
- Reset token: 32-byte crypto-random hex, SHA-256 hashed before DB storage
- Expires in 1 hour, single-use
- `POST /auth/reset-password` — validate token, update password, invalidate all sessions for user

**Security actions in Phase 1:**
- Passwords never appear in logs (strip at middleware level)
- All auth endpoints rate-limited: 5 req/15min per IP in shared mode, relaxed locally
- `Content-Security-Policy`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` headers on all responses
- CORS: `localhost` origins in local mode; explicit domain allowlist in shared mode (no wildcard)

---

## 7. Phase 2 — Core Real-Time Chat & Persistence

**Goal:** Users create workspaces and channels, send messages in real time, and all messages are persisted to PostgreSQL. Chat history survives restarts.

### Data Model

```
Workspace
  id, name, slug, ownerId, createdAt

Channel
  id, workspaceId, name, type (PUBLIC | PRIVATE | DIRECT), createdAt, archivedAt

Message
  id, channelId, senderId, senderType (USER | AGENT)
  content (text), contentType (TEXT | MARKDOWN | FILE | SYSTEM)
  metadata (JSONB)          ← provider, model, tokenUsage, toolCalls stored here
  editedAt, deletedAt, createdAt

ConversationSummary         ← for context compaction (see Phase 3B)
  id, channelId, agentId, summary (text), tokenCount
  coversMessageIds (int[]), createdAt

ChannelMembership
  channelId, userId, role (OWNER | MODERATOR | MEMBER), joinedAt, lastReadAt

MessageReaction
  messageId, userId, emoji, createdAt

Attachment
  id, messageId, fileKey, fileName, fileSize, mimeType, virusScanStatus, uploadedAt
```

**Why `metadata JSONB` on Message?**
This is deliberate. LLM responses carry provider-specific metadata (model used, token counts, finish reason, cache hits). Storing in JSONB lets us add new provider fields without schema migrations, while keeping the core message fields clean.

### Tasks

#### P2-01 — Workspace CRUD
- `POST /workspaces` — create workspace
- `GET /workspaces` — list user's workspaces
- `GET /workspaces/:id` — details + member list
- `PATCH /workspaces/:id` — rename (admin/owner)
- `DELETE /workspaces/:id` — soft delete, triggers async cleanup job

#### P2-02 — Channel Management
- `POST /workspaces/:id/channels` — create channel
- `GET /workspaces/:id/channels` — list accessible channels
- `POST /channels/:id/invite` — invite user (admin)
- `DELETE /channels/:id` — archive (soft delete)

#### P2-03 — Message Persistence & REST API
- `GET /channels/:id/messages` — cursor-based pagination (newest first, `?before=messageId&limit=50`)
- `POST /channels/:id/messages` — send message (HTTP fallback if socket fails)
- `PATCH /messages/:id` — edit (author only, within 15 min)
- `DELETE /messages/:id` — soft delete (author or moderator)
- Full-text search: `GET /channels/:id/messages?q=term` via PostgreSQL `tsvector` index
- Messages are **never hard-deleted** — `deletedAt` timestamp set, content replaced with `[deleted]`

#### P2-04 — Socket.io Real-Time Layer
- Namespaces: `/chat` (messages), `/presence` (online status)
- Rooms: `channel:{channelId}` — joined on `channel:join`, left on disconnect or `channel:leave`
- **Client → Server events:**
  - `message:send` — `{ channelId, content, contentType }`
  - `message:edit` — `{ messageId, content }`
  - `message:delete` — `{ messageId }`
  - `typing:start` / `typing:stop` — `{ channelId }`
  - `channel:join` / `channel:leave` — `{ channelId }`
- **Server → Client events:**
  - `message:new` — full message object broadcast to channel room
  - `message:updated` — updated fields
  - `message:deleted` — `{ messageId, deletedAt }`
  - `typing:update` — `{ channelId, users: string[] }`
  - `presence:update` — `{ userId, status }`
  - `message:stream:chunk` — streaming token (Phase 3A)
  - `message:stream:end` — stream complete
- All socket payloads validated with Zod before processing

#### P2-05 — Redis Adapter (Horizontal Scaling)
- `@socket.io/redis-adapter` installed and configured from Phase 0
- All room broadcasts go through Redis — works even with 1 instance, ready for N instances

#### P2-06 — Presence System
- On connect: `SET user:{userId}:status ONLINE EX 60` in Redis
- Client heartbeat every 30s refreshes TTL
- On disconnect: set OFFLINE, publish `presence:update`
- `GET /workspaces/:id/presence` — bulk status for workspace members

#### P2-07 — Read Receipts & Unread Counts
- `lastReadAt` per user per channel tracked in `ChannelMembership`
- `POST /channels/:id/read` — updates lastReadAt
- `GET /workspaces/:id/unread` — counts per channel (messages after lastReadAt)
- Socket: emit `read:update` when user reads a channel

#### P2-08 — File Attachments
- `POST /uploads/presigned` — generate S3 presigned PUT URL (client uploads directly)
- File metadata saved after upload, message references `attachmentId`
- Size limit: 50MB per file, 10 files per message
- MIME type allowlist enforced server-side on metadata (not just client)
- Async ClamAV scan queued as BullMQ job — message shows "scanning" until complete

**Security actions in Phase 2:**
- Channel membership verified before any message send or read
- Message content sanitized: HTML stripped, only safe Markdown allowed (use `dompurify` + `marked`)
- Rate-limit message sending: 30 messages/minute per user per channel
- Presigned URLs expire in 5 minutes
- File storage keys are UUIDs, never original filenames

---

## 8. Phase 3A — LLM Provider Layer

**Goal:** A clean, extensible provider abstraction that supports 5 specific providers today and can add more later. Each provider has correct auth, streaming, tool calling, and error handling. Provider configs are stored per-agent, encrypted at rest.

### Provider Interface

```typescript
// packages/types/src/providers.ts

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentPart[]
  toolCallId?: string       // for tool result messages
  name?: string             // for tool result messages
}

export interface LLMTool {
  name: string
  description: string
  parameters: Record<string, unknown>  // JSON Schema
}

export interface LLMRequestOptions {
  messages: LLMMessage[]
  tools?: LLMTool[]
  maxTokens?: number
  temperature?: number
  stream?: boolean
  systemPrompt?: string
  cacheHints?: CacheHint[]   // for Anthropic prompt caching
}

export interface LLMResponse {
  id: string
  content: string
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error'
  toolCalls?: ToolCall[]
  usage: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
    cachedTokens?: number     // Anthropic / OpenAI cache hits
  }
  providerMetadata?: Record<string, unknown>  // stored in message.metadata
}

export interface LLMStreamChunk {
  delta: string
  finishReason?: string
}

// The contract every provider must implement
export interface LLMProvider {
  readonly name: ProviderName
  readonly supportedModels: string[]
  complete(options: LLMRequestOptions): Promise<LLMResponse>
  stream(options: LLMRequestOptions): AsyncGenerator<LLMStreamChunk>
  countTokens(messages: LLMMessage[]): Promise<number>
}

export type ProviderName = 'openai' | 'openai-codex-oauth' | 'anthropic' | 'kimi' | 'openrouter'
```

### Provider Registry

```typescript
// backend: modules/providers/registry.ts
// Singleton map — providers instantiated on first use, keyed by config hash

class ProviderRegistry {
  get(agentId: string): LLMProvider   // loads config from DB, decrypts, returns cached instance
  register(name: ProviderName, config: ProviderConfig): void
}
```

### Data Model

```
ProviderConfig
  id, agentId (or workspaceId for shared), providerName, model
  credentials (JSONB, AES-256-GCM encrypted)
  config (JSONB: temperature, maxTokens, etc.), createdAt, updatedAt

OAuthToken                              ← for OpenAI Codex OAuth
  id, agentId, accessToken (encrypted), refreshToken (encrypted)
  expiresAt, scope, createdAt, updatedAt
```

### Tasks

#### P3A-01 — OpenAI Provider (API Key)
- Auth: `Authorization: Bearer {apiKey}` header
- Base URL: `https://api.openai.com/v1`
- Models supported: `gpt-4o`, `gpt-4o-mini`, `gpt-4-turbo`, `o1`, `o3`, `o3-mini`
- Streaming: SSE with `stream: true`, parse `data:` chunks
- Tool calling: native OpenAI function calling format
- Token counting: `tiktoken` library (`cl100k_base` encoding for GPT-4 models)
- Error handling: map OpenAI error codes to internal error types
  - `429` → `RATE_LIMITED` (retry with exponential backoff, max 3 retries)
  - `401` → `AUTH_FAILED` (do not retry, alert agent in channel)
  - `500/503` → `PROVIDER_ERROR` (retry with backoff)
- Context limits by model: `gpt-4o` = 128K, `gpt-4-turbo` = 128K, `o1` = 200K

#### P3A-02 — OpenAI Codex OAuth Provider
- Auth mechanism: OAuth 2.0 Authorization Code flow (not API key)
- OAuth flow:
  1. Admin clicks "Connect OpenAI Codex" in UI
  2. Backend generates OAuth authorization URL with `state` param (CSRF protection)
  3. User redirected to OpenAI OAuth consent screen
  4. OpenAI redirects back to `GET /auth/oauth/codex/callback?code=...&state=...`
  5. Backend exchanges `code` for `access_token` + `refresh_token`
  6. Tokens encrypted and stored in `OAuthToken` table, linked to agent
- Token refresh: access tokens expire — refresh automatically before each LLM call
  - Check `expiresAt - 60 seconds` before use; refresh if needed
  - Refresh endpoint: `POST https://api.openai.com/v1/oauth/token` with `grant_type=refresh_token`
  - On refresh failure: mark agent credentials as invalid, notify admin in channel
- API calls: same as OpenAI provider but `Authorization: Bearer {oauthAccessToken}`
- Same base URL and model list as OpenAI provider
- Scopes required: `model.request` (check OpenAI OAuth docs for current scope names)
- UI: show connected/disconnected status, "Reconnect" button if token invalid

#### P3A-03 — Anthropic Provider (API Key)
- Auth: `x-api-key: {apiKey}` header + `anthropic-version: 2023-06-01` header
- Base URL: `https://api.anthropic.com/v1`
- Models supported: `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5`
- Streaming: SSE, parse `event:` + `data:` pairs, handle `content_block_delta` events
- Tool calling: Anthropic tool use format (different from OpenAI — adapter normalizes this)
- Token counting: `POST /v1/messages/count_tokens` endpoint (exact, not estimated)
- **Prompt caching** (unique to Anthropic):
  - Add `cache_control: { type: "ephemeral" }` to static message parts (system prompt, memory)
  - Cache TTL: 5 minutes (Anthropic-managed)
  - Track `cache_read_input_tokens` and `cache_creation_input_tokens` from response
  - Store cache hit stats in `message.metadata` for cost analytics
  - See Phase 3B for how caching integrates with context management
- Error handling: `529` (overloaded) → retry with backoff; `400` invalid request → log and surface to user

#### P3A-04 — Kimi K2.5 Provider (API Key) — Moonshot AI
- Provider: Moonshot AI (`https://api.moonshot.cn/v1`)
- **API format: OpenAI-compatible** — use the OpenAI SDK pointed at Moonshot's base URL
- Auth: `Authorization: Bearer {apiKey}` (same header format as OpenAI)
- Models supported:
  - `kimi-k2-5` — Kimi K2.5 (primary model)
  - `moonshot-v1-8k` — 8K context
  - `moonshot-v1-32k` — 32K context
  - `moonshot-v1-128k` — 128K context (fallback when K2.5 unavailable)
- Streaming: SSE, same format as OpenAI
- Tool calling: OpenAI function calling format (compatible)
- Token counting: use `tiktoken` (approximate — Moonshot doesn't expose a counting endpoint)
- Note: Kimi K2.5 supports long context natively — set default context window to 128K for this provider
- Error handling: same status code mapping as OpenAI provider
- **Implementation note:** Because the API is OpenAI-compatible, the Kimi provider can extend `OpenAIProvider` and only override `name`, `baseURL`, and `supportedModels`

#### P3A-05 — OpenRouter Provider (API Key)
- Base URL: `https://openrouter.ai/api/v1`
- **API format: OpenAI-compatible** — extends OpenAI provider like Kimi
- Auth: `Authorization: Bearer {openrouterApiKey}`
- Required headers: `HTTP-Referer: https://nextgenchat.local`, `X-Title: NextGenChat`
- Model format: `provider/model-name` strings (e.g., `google/gemini-2.5-pro`, `meta-llama/llama-3.3-70b-instruct`)
- Context limits: vary per model — OpenRouter returns `context_length` in model list response
- Tool calling: supported for models that support it; OpenRouter normalizes across providers
- Streaming: SSE, OpenAI-compatible format
- Token counting: use `tiktoken` as approximation; OpenRouter doesn't expose a counting endpoint
- Model discovery: `GET /api/v1/models` — cache response for 1 hour in Redis
- Admin can select any model from the discovered list when configuring an agent
- **Cost tracking**: OpenRouter returns `usage.cost` in responses — store in `message.metadata`

#### P3A-06 — Provider Config Management (Admin UI)
- `GET /agents/:id/provider` — return provider name + model (never return raw API keys)
- `PUT /agents/:id/provider` — set/update provider config
  - Body: `{ providerName, model, credentials: { apiKey? }, config: { temperature, maxTokens } }`
  - Credentials encrypted with AES-256-GCM before DB storage (key from env var `ENCRYPTION_KEY`)
  - Decryption only happens in memory during LLM calls — never sent to clients
- `DELETE /agents/:id/provider/credentials` — revoke credentials (admin)
- `POST /agents/:id/provider/test` — fire a simple test completion to verify credentials work
  - Returns: `{ success: true, model, latencyMs }` or `{ success: false, error }`
- OAuth providers: separate UI flow (see P3A-02)
- UI: provider selector dropdown → model selector (populated based on provider) → credential fields → test button

**Security actions in Phase 3A:**
- API keys never returned to clients via any endpoint
- AES-256-GCM encryption with random IV per record — key stored in env, never in DB
- OAuth `state` param verified on callback to prevent CSRF
- OAuth tokens rotated on every use
- LLM responses logged by ID only — never log actual prompt content or user message content
- Provider errors surfaced to agent in channel (user-friendly) but full error logged server-side

---

## 9. Phase 3B — Context Window Management

**Goal:** Conversations never fail because they've grown too long. Context is automatically managed per-provider with compaction and caching, keeping costs reasonable and responses relevant.

### The Problem

Every LLM provider has a context window limit. As a channel conversation grows, the full history eventually exceeds the limit. Naive approaches: either fail with an error, or silently truncate (losing important context). Neither is acceptable.

### Three-Layer Solution

```
LAYER 1: Token Budgeting     → count before sending, know what fits
LAYER 2: Auto-Compaction     → summarize old context when budget exceeded
LAYER 3: Prompt Caching      → cache static parts to reduce cost on repeated calls
```

### Data Model

```
ConversationSummary
  id, channelId, agentId
  summary (text)              ← LLM-generated summary of older messages
  tokenCount (int)            ← tokens this summary consumes
  coversFromMessageId (int)   ← oldest message covered
  covesToMessageId (int)      ← newest message covered
  createdAt

ContextCacheEntry             ← track Anthropic cache usage
  id, agentId, channelId
  cacheKey (hash)             ← hash of static context (system + memory)
  lastHitAt, hitCount
  estimatedSavings (tokens)
```

### Tasks

#### P3B-01 — Token Counter Service
- `TokenCounterService.count(messages, provider): Promise<number>`
- Per-provider implementation:
  - **OpenAI / Kimi / OpenRouter:** `tiktoken` library, `cl100k_base` encoding
    - Correctly accounts for message role overhead (~4 tokens per message)
  - **Anthropic:** `POST /v1/messages/count_tokens` — exact count from the API
    - Cache result in Redis for 60s using hash of messages as key (avoid repeated API calls)
- Context limits map (kept up to date):
  ```
  openai/gpt-4o          → 128,000
  openai/o1              → 200,000
  openai/o3              → 200,000
  anthropic/claude-opus  → 200,000
  anthropic/claude-sonnet→ 200,000
  kimi/kimi-k2-5         → 131,072
  openrouter/*           → fetched from model list, cached
  ```
- Reserve `RESPONSE_BUFFER` tokens (default: 4,096) — never fill the full context

#### P3B-02 — Context Builder
- `ContextBuilder.build(agentId, channelId, triggerMessageId): Promise<LLMMessage[]>`
- Build order:
  1. System prompt (from `AgentIdentity`) — marked as cacheable (Anthropic)
  2. Agent memory (GLOBAL + CHANNEL scope) — marked as cacheable
  3. Latest `ConversationSummary` if one exists (marked as cacheable)
  4. Recent messages from DB (newest first, fill remaining budget)
  5. Trigger message (always included, last)
- If step 4 would exceed budget: trigger auto-compaction (P3B-03) first

#### P3B-03 — Auto-Compaction Service
- Triggered when: `tokenCount(systemPrompt + memory + fullHistory) > contextLimit - RESPONSE_BUFFER`
- Algorithm:
  1. Determine how many old messages need to be summarized to fit
  2. Call LLM (cheapest model available for this provider: `gpt-4o-mini`, `claude-haiku`) with:
     ```
     "Summarize the following conversation history concisely, preserving key decisions, facts, and outcomes:"
     [old messages]
     ```
  3. Store resulting `ConversationSummary` in DB (links to covered message IDs)
  4. Future context builds use summary instead of raw old messages
- Compaction is async (BullMQ job) — it does not block the current LLM call
  - Current call uses truncated history; compacted context used from next call onward
- Summary itself is also subject to budget — if summaries accumulate, summarize the summaries (recursive, max 3 levels)

#### P3B-04 — Prompt Caching (Anthropic)
- Implemented within `AnthropicProvider.complete()`:
  - Add `cache_control: { type: "ephemeral" }` after the last turn of static content (system + memory + summary)
  - This tells Anthropic to cache everything up to that point
  - Cache TTL: 5 minutes (Anthropic-managed, reset on each cache-creating request)
- Track cache performance:
  - `cache_creation_input_tokens` → first request creates cache (costs more)
  - `cache_read_input_tokens` → subsequent requests hit cache (costs ~10x less)
  - Store both in `message.metadata.usage`
- Heartbeat strategy: if agent is active in a channel, make a dummy request every 4 minutes to keep cache warm (only if conversations are frequent — configurable)
- Cache hit rate exposed in admin analytics dashboard

#### P3B-05 — OpenAI Prompt Caching
- OpenAI automatically caches repeated prompt prefixes (no explicit API needed as of GPT-4o)
- Track `cached_tokens` from OpenAI usage response — store in `message.metadata`
- Design implication: keep static parts (system prompt, memory) at the beginning of the message array and don't change them between requests — OpenAI's cache benefits from stable prefixes

#### P3B-06 — Context Analytics (Admin)
- `GET /agents/:id/context-stats` — return:
  - Average tokens per request (prompt + completion)
  - Cache hit rate (Anthropic)
  - Number of compactions performed
  - Estimated cost savings from caching
  - Compaction history (when, how many messages summarized)
- Visualized in admin UI as a simple chart

**Security actions in Phase 3B:**
- Compaction summaries are stored in DB — apply same access control as messages
- Never include user-identifying info in cache keys
- Token count results cached in Redis with short TTL (60s) — do not cache across users

---

## 10. Phase 3C — AI Agent System

**Goal:** Admins create agents, assign them to channels, give them identities, memory, tools, and cron schedules. Agents use the LLM Provider Layer (Phase 3A) and Context Management (Phase 3B).

### Data Model

```
Agent
  id, workspaceId, name, slug, createdBy
  status (ACTIVE | PAUSED | ARCHIVED)
  providerConfigId → ProviderConfig
  createdAt

AgentIdentity
  agentId, avatarUrl, persona (text), voiceTone, systemPrompt

AgentMemory
  id, agentId, scope (GLOBAL | CHANNEL | USER)
  key, value (JSONB), updatedAt

AgentTool
  id, agentId, toolName, config (JSONB), approvedBy, approvedAt

AgentCronJob
  id, agentId, schedule (cron expr), lastRunAt, nextRunAt, status, task (text)

AgentChannelMembership
  agentId, channelId, addedBy, addedAt

AgentToolCall                 ← audit log of all tool invocations
  id, agentId, messageId, toolName, input (JSONB), output (JSONB)
  durationMs, success, createdAt
```

### Tasks

#### P3C-01 — Agent CRUD
- `POST /workspaces/:id/agents` — create agent + default `AgentIdentity` + auto-create workspace files
- `GET /workspaces/:id/agents` — list agents with status
- `PATCH /agents/:id` — update persona, system prompt, status
- `DELETE /agents/:id` — archive (soft delete, keep all history)

#### P3C-02 — Agent Identity & Doc Files
- Auto-created on agent creation in agent's workspace:
  - `Agent.md` — admin instructions and plans for the agent
  - `identity.md` — persona, tone, background
  - `memory.md` — auto-synced human-readable view of `AgentMemory`
  - `Heartbeat.md` — multi-step execution plan for cron wake-ups
- Dedicated Markdown editor in UI for these files

#### P3C-03 — Agent Memory System
- Scopes: `GLOBAL` (across all channels), `CHANNEL` (per channel), `USER` (per individual user)
- Memory stored as key-value JSONB in `AgentMemory`
- Injected into context by `ContextBuilder` (Phase 3B)
- Memory size cap: 50KB per scope
- `GET /agents/:id/memory` — admin view
- `DELETE /agents/:id/memory/:key` — manual clear

#### P3C-04 — Agent Message Pipeline
1. Message arrives in channel (via socket or REST)
2. Message saved to DB
3. Check: does this channel have active agents? Are they triggered?
4. For each triggered agent: enqueue BullMQ job `agent:process { agentId, channelId, messageId }`
5. Worker executes:
   a. Load agent config + provider config (decrypted)
   b. `ContextBuilder.build()` → context window managed, compacted if needed
   c. Streaming LLM call via provider: emit `message:stream:chunk` events via Socket.io
   d. On stream complete: save full response as `Message { senderType: AGENT }`
   e. Update agent memory if LLM signals memory operations via tool calls
6. Agents do NOT respond to other agents by default (`senderType === AGENT` → skip)
7. Job timeout: 90 seconds. On timeout: save error message, mark job failed

#### P3C-05 — Streaming Responses
- Provider `stream()` method returns `AsyncGenerator<LLMStreamChunk>`
- Worker emits each chunk via Socket.io to channel room: `message:stream:chunk { tempId, delta }`
- Client renders streaming message in real time (like ChatGPT)
- On stream complete: `message:stream:end { tempId, finalMessageId }` — client replaces temp message
- Fallback: if stream fails mid-way, save partial content + error note

#### P3C-06 — Agent Tools Framework
- Tool definition: `{ name, description, schema: ZodSchema, execute(params): Promise<result>, requiresApproval: boolean }`
- Built-in tools: `workspace_file_read`, `workspace_file_write`, `web_search`, `send_message`
- Admin approves tools per agent via `POST /agents/:id/tools`
- All tool calls logged to `AgentToolCall` table
- Tool execution sandboxed in separate BullMQ worker (no shared state with main process)

#### P3C-07 — Agent Cron / Heartbeat System
- `POST /agents/:id/cron` — create schedule `{ schedule: "0 9 * * 1-5", task: "..." }`
- BullMQ repeatable jobs handle cron
- On trigger: agent wakes up, executes `Heartbeat.md` task in its primary channel
- `GET /agents/:id/cron` — list schedules + last run status

#### P3C-08 — Agent Triggers
- `@agent-name` mention: triggers that specific agent
- Trigger modes (per agent): `MENTIONS_ONLY` | `ALL_MESSAGES` | `DISABLED`
- Anti-loop guard: agents never trigger agents (configurable exception for orchestration)

**Security actions in Phase 3C:**
- Agent cannot read channels it is not a member of
- Tool calls rate-limited per agent: 60 tool calls per hour
- Prompt injection defense: user content wrapped in `<user_message>` delimiters in context
- All agent actions attributable (logged with agentId + triggering messageId)

---

## 11. Phase 4 — Workspace & File Management

**Goal:** Each agent has a private workspace. There is a shared group workspace. Files are versioned.

### Tasks

#### P4-01 — Private Agent Workspaces
- S3 prefix: `workspaces/agents/{agentId}/`
- `GET /agents/:id/workspace/files` — list
- `POST /agents/:id/workspace/files` — upload (admin)
- `DELETE /agents/:id/workspace/files/:key` — delete
- Agent reads/writes own workspace via approved tools only

#### P4-02 — Shared Group Workspace
- S3 prefix: `workspaces/shared/{workspaceId}/`
- `GET /workspaces/:id/files` — list (all members)
- `POST /workspaces/:id/files` — upload
- `DELETE /workspaces/:id/files/:key` — delete (admin or owner)
- Agents granted read or read-write access per workspace

#### P4-03 — File Versioning
- Overwrites archive previous version with timestamp suffix (never deleted)
- `GET /workspaces/:id/files/:key/versions` — list versions
- `POST /workspaces/:id/files/:key/restore/:versionId` — restore

#### P4-04 — Agent Doc Files UI
- Dedicated Markdown editor with preview for `Agent.md`, `identity.md`, `memory.md`, `Heartbeat.md`
- Auto-save with debounce (2s after last keystroke)
- `memory.md` auto-synced when `AgentMemory` is updated

**Security actions in Phase 4:**
- All file access via backend auth check — never direct S3 URLs to clients
- File key pattern validated: `/^workspaces\/[a-z0-9\-\/]+\.[a-z0-9]+$/i`
- Max workspace size per agent: 1GB (configurable)
- MIME type verified server-side via `file-type` library (magic bytes, not extension)

---

## 12. Phase 5 — Rules Engine

**Goal:** Admins define policies on tools and resources. A Rules Agent enforces them. Agents cannot bypass rules.

### Data Model

```
Rule
  id, workspaceId, name, description, priority (int), active
  condition (JSONB), action (BLOCK | ALLOW | LOG | REQUIRE_APPROVAL)
  scope (TOOL | FILE | CHANNEL | AGENT), createdBy

RuleViolation
  id, ruleId, agentId, context (JSONB), resolvedAt, createdAt
```

### Tasks

#### P5-01 — Rule Definition API
- `POST /workspaces/:id/rules` — create rule (admin)
- `GET /workspaces/:id/rules` — list with priority order
- `PATCH /rules/:id` — update
- `DELETE /rules/:id` — deactivate (never hard-delete)

#### P5-02 — Rules Enforcement Middleware
- `RulesEngine.evaluate(agentId, toolName, params): Promise<RuleResult>`
- Evaluated in priority order, first match wins
- `REQUIRE_APPROVAL` → pause tool call, notify admin

#### P5-03 — Rules Agent
- System agent that monitors channel activity
- Explains rule violations in plain language when invoked
- Notifies admin channel on violations

#### P5-04 — Approval Workflow
- Paused tool call stored in `PendingApproval` table
- Admin notified in UI
- `POST /approvals/:id/approve` or `/deny`
- Auto-deny after 30 minutes

#### P5-05 — Audit Log
- Every rule evaluation logged: timestamp, agent, rule matched, action
- `GET /workspaces/:id/audit-log` — paginated, admin only
- Append-only (no updates/deletes)
- Entries HMAC-signed to detect tampering

---

## 13. Phase 6 — MCP Integration

**Goal:** Agents can use MCP (Model Context Protocol) tools approved by admins. MCP servers run as managed subprocesses.

### Tasks

#### P6-01 — MCP Server Registry
- `POST /workspaces/:id/mcp-servers` — register `{ name, command, args, env (encrypted) }`
- MCP servers workspace-scoped

#### P6-02 — MCP Process Manager
- Managed subprocesses: start, stop, health-ping
- Stdout/stderr captured to logs
- Auto-restart on crash (max 3 retries, then alert)

#### P6-03 — Tool Discovery & Approval
- On registration: auto-discover tools via MCP `list_tools`
- Admin approves specific tools per agent

#### P6-04 — Tool Execution
- Agent calls → backend proxies to MCP subprocess
- All MCP tool calls logged same as built-in tools
- Rules Engine applies to MCP calls

**Security actions in Phase 6:**
- MCP processes run with minimal OS permissions (no root, no network unless explicitly allowed)
- MCP env vars stored encrypted
- No wildcard tool grants — every tool approved individually per agent

---

## 14. Phase 7 — Friends Access (Network Mode)

**Goal:** Securely expose the backend to invited friends. No open registration. Full TLS. Data stays on the owner's machine (or VPS).

**This is a security mode transition, not just a feature.** Many things that were relaxed in local mode must be hardened here.

### Tasks

#### P7-01 — TLS Setup
- Caddy with automatic TLS (Let's Encrypt) when a real domain is configured
- `DEPLOYMENT_MODE=network` env var switches security posture
- In network mode: all `localhost`-only exemptions removed

#### P7-02 — Invite-Only Registration (activate P1-06)
- Enable the invite system (disabled by default in local mode)
- `POST /auth/invite` — admin generates signed invite link
- Invite links single-use, expire in 48h
- Admin can revoke pending invites
- `GET /workspaces/:id/invites` — list pending invites (admin)

#### P7-03 — Network Security Hardening
- Rate limiting fully enabled (relaxed config replaced with strict config)
- CORS updated to accept only the configured public domain
- Email/SMTP configured for invite delivery and password reset
- Fail2ban or equivalent: auto-block IPs after repeated auth failures
- `POST /admin/block-ip` — manual IP block (owner only)

#### P7-04 — Friend Data Transparency
- `GET /me/data` — user can download all their data (GDPR-style)
- `DELETE /me` — user can delete their account and all their data
- Privacy notice shown during invite registration

#### P7-05 — Connection Options Documentation
- VPN (Tailscale or WireGuard): recommended for technical users — no port forwarding needed
- Reverse proxy to VPS: for users who want a stable public URL
- Cloudflare Tunnel: zero-config TLS tunnel option

**Security actions in Phase 7:**
- All security headers now strictly enforced (local mode had relaxed CSP)
- HSTS: `max-age=31536000; includeSubDomains; preload`
- Every new user sees what data is stored and can delete it
- Owner can revoke any user's session: `DELETE /admin/sessions/:userId`

---

## 15. Phase 8 — Mobile App (React Native)

**Goal:** iOS and Android apps connecting to the Phase 7 backend. Core chat features only — admin functions remain web-only.

### Tasks

#### P8-01 — Expo Project Setup
- `apps/mobile` added to monorepo
- Shared `@nextgenchat/types` imported
- Expo Router for navigation

#### P8-02 — Auth (Mobile)
- Login screen: email + password
- Access token in **Expo SecureStore** (hardware-backed, not AsyncStorage)
- Refresh token via dedicated `POST /auth/mobile-token` endpoint (device-bound, 30-day expiry)
- Biometric unlock option (FaceID / Fingerprint via `expo-local-authentication`)
- On logout: `POST /push/unregister` + clear SecureStore

#### P8-03 — Core Chat UI
- Workspace list → Channel list → Message list (infinite scroll, virtualized)
- Socket.io connection — same backend, same events
- Streaming agent responses displayed token-by-token
- Optimistic UI: message appears immediately, synced on server ack

#### P8-04 — Push Notifications
- `POST /push/register` — store FCM/APNs device token server-side
- Notifications triggered when: new message in channel, @mention, agent completes
- Notification payload: channel name, sender name — **no message content** in payload
- `POST /push/unregister` on logout

#### P8-05 — Mobile-Specific Backend
- `POST /auth/mobile-token` — device-bound refresh token
- `DELETE /sessions/:deviceId` — remote revoke (if phone is lost)
- Push token table: `PushToken(userId, deviceId, token, platform, registeredAt)`

**Security actions in Phase 8:**
- Certificate pinning: pin to backend's TLS certificate (prevent MITM on mobile networks)
- Push notifications contain no sensitive content
- Biometric auth is local to device — biometric data never sent to backend
- Lost device: owner can revoke all sessions for a specific device

---

## 16. Phase 9 — Observability & Production Hardening

**Goal:** The system is observable, diagnosable in production, and can handle real load.

### Tasks

#### P9-01 — Structured Logging
- Pino (already configured in Phase 0) — JSON logs with `requestId`, `userId`, `agentId`
- Never log: passwords, tokens, PII, message content — log IDs only
- Local mode: pretty print to stdout; production: JSON to log aggregator

#### P9-02 — Distributed Tracing
- OpenTelemetry SDK — spans for HTTP requests, Socket events, DB queries, LLM calls, queue jobs
- Trace IDs in response headers for frontend correlation
- Shipped to Grafana Tempo

#### P9-03 — Metrics & Alerting
- Prometheus metrics: request rate, error rate, latency p50/p95/p99, socket connections, queue depth
- LLM metrics: token usage per provider, cache hit rate, cost per agent
- Grafana dashboards
- Alerts: error rate > 1%, p95 latency > 2s, queue depth > 1000

#### P9-04 — Database Performance
- Indexes:
  - `messages(channelId, createdAt DESC)` — pagination
  - `messages` full-text: `tsvector` column + GIN index
  - All foreign keys indexed
  - `agent_memory(agentId, scope, key)` — unique, for upserts
- PgBouncer connection pooling in production
- Read replicas for analytics queries

#### P9-05 — Backup & Recovery
- PostgreSQL: daily automated backups to S3, PITR enabled
- MinIO/S3 files: versioning + cross-region replication in cloud mode
- RTO: < 4 hours | RPO: < 1 hour

---

## 17. Security Strategy (Cross-Cutting, Mode-Aware)

> Security is a process, not a product. These apply throughout all phases, with notes on when they become critical.

### Authentication & Authorization
- [ ] JWT access tokens 15 min, refresh tokens rotated on use
- [ ] All tokens revocable server-side (stored in DB)
- [ ] RBAC enforced at route AND socket level
- [ ] Resource ownership verified on every mutation
- [ ] **Local mode:** single-user, no registration. **Shared mode:** invite-only, email-verified

### Transport Security
- [ ] **Local mode:** HTTP on localhost is acceptable (TLS overhead with no benefit)
- [ ] **Shared mode:** TLS 1.3 required, TLS 1.0/1.1 disabled
- [ ] HSTS enabled in shared mode: `max-age=31536000; includeSubDomains; preload`
- [ ] CORS: localhost origins in local mode, explicit domain allowlist in shared mode

### Input & Data Safety
- [ ] All inputs validated with Zod at entry (REST + Socket)
- [ ] Parameterized queries always (Prisma enforces this — no raw SQL injection vectors)
- [ ] Message content: HTML stripped server-side before storage
- [ ] File keys validated against safe pattern regex

### Rate Limiting
- [ ] **Local mode:** relaxed (you're the only user)
- [ ] **Shared mode:** 100 req/min global, strict per-endpoint limits for auth endpoints
- [ ] Socket message send: 30/min per user per channel in shared mode
- [ ] Agent tool calls: 60/hour per agent

### Secrets & Credentials
- [ ] **Local mode:** API keys in `.env`, gitignored
- [ ] **Shared mode:** LLM API keys encrypted in DB (AES-256-GCM), never in env
- [ ] OAuth tokens encrypted in DB
- [ ] Secret scanning in CI (`detect-secrets` or GitLeaks)

### LLM-Specific Security
- [ ] Prompt injection defense: user content always wrapped in `<user_message>...</user_message>` delimiters
- [ ] Agent cannot call tools it hasn't been explicitly approved for
- [ ] Agent tool HTTP calls restricted to admin-approved domain allowlist
- [ ] LLM response content sanitized before rendering (XSS)
- [ ] Compaction summaries stored under same access control as messages

### Audit & Incident Response
- [ ] Audit log: all admin actions, agent tool calls, rule violations — append-only, HMAC-signed
- [ ] `POST /admin/revoke-all-sessions` — emergency session kill switch (owner only)
- [ ] On shared mode: `POST /admin/block-ip` for abuse response

---

## 18. UX Principles & Suggestions

### Chat Experience
- **Optimistic UI:** Message appears instantly, server-synced. Failure shows retry indicator — never silent drop.
- **Streaming first:** All agent responses stream token-by-token (Phase 3C-05). Non-streaming feels broken by comparison.
- **Message threading:** Design the DB and UI for threads from Phase 2. Adding threads later to a flat message schema is painful.
- **Keyboard-first:** `Cmd/Ctrl+K` command palette for navigation. All actions reachable without mouse.
- **Virtualized lists:** TanStack Virtual — only render visible messages. Non-negotiable for channels with 10k+ messages.

### Agent Experience
- **Agent badge:** Distinct visual on agent messages — color, icon, "AI" label. Never ambiguous.
- **"Agent is thinking...":** Show typing indicator while BullMQ job processes.
- **Tool call transparency:** Collapsible "used tool: web_search for X" shown under agent message. Builds trust.
- **Context indicator:** Show agent's current context usage (e.g., "8,200 / 128,000 tokens") in agent info panel.
- **Compaction notice:** When auto-compaction happens, show a subtle "Context summarized" divider in chat.

### Admin Experience
- **Provider test button:** Always include credential test before saving — see P3A-06.
- **Agent playground:** Test agent response before adding to a live channel.
- **Rule builder:** Visual condition builder (not raw JSON). Priority drag-and-drop.
- **Context analytics:** Cache hit rate, token usage trend, cost estimation per agent.

### Performance & Polish
- **Skeleton states:** No blank UI — skeletons while data loads.
- **Offline banner:** Socket disconnected → banner + queue outgoing messages, sync on reconnect.
- **Dark mode:** Day one. Tailwind `dark:` variants, system preference respected.
- **Notification controls:** Per-channel: all messages / @mentions only / muted. Stored server-side.

---

## 19. Ticket Creation Guide

### Ticket Template

```
Title:    [PhaseID] Area — Short description
Example:  [P3A-02] Providers — OpenAI Codex OAuth flow

Type:     Feature | Security | Infrastructure | Bug | Research

Description:
  What and why in 2-3 sentences. Link to relevant plan section.

Acceptance Criteria:
  - [ ] Specific, testable outcome
  - [ ] Tests written and passing
  - [ ] Security checklist passed (if applicable)

Technical Notes:
  Key files, relevant interfaces, decisions already made in plan.

Dependencies:
  Ticket IDs that must complete first.

Security Checklist:
  - [ ] Inputs validated with Zod
  - [ ] Auth middleware applied
  - [ ] Rate limit applied (if network-exposed)
  - [ ] Action logged/audited
  - [ ] Credentials encrypted (if storing secrets)
```

### Recommended First Sprint (Phases 0 + 1 + 2 foundation)

Start here. Nothing else builds without this foundation.

| # | Ticket | Why it's first |
|---|---|---|
| 1 | `[P0-01]` Monorepo scaffolding | Everything depends on this |
| 2 | `[P0-02]` Docker Compose local dev | Parallel with #1 |
| 3 | `[P0-05]` Shared types package | Needed before any API |
| 4 | `[P0-03]` Backend bootstrap (Fastify + Prisma + health) | |
| 5 | `[P0-04]` Frontend bootstrap (Next.js + Tailwind) | Parallel with #4 |
| 6 | `[P0-06]` CI pipeline | After #1-5 pass locally |
| 7 | `[P1-01]` First-run setup wizard | First thing a user sees |
| 8 | `[P1-02]` Login + JWT issuance | |
| 9 | `[P1-03]` Token refresh + logout | |
| 10 | `[P1-04]` Auth middleware (REST + Socket) | Gate for all subsequent work |
| 11 | `[P2-01]` Workspace CRUD | |
| 12 | `[P2-02]` Channel management | |
| 13 | `[P2-03]` Message persistence + REST API | |
| 14 | `[P2-04]` Socket.io real-time layer | |
| 15 | `[P3A-01]` OpenAI provider (simplest provider first) | Unblocks agent work |
| 16 | `[P3B-01]` Token counter service | Required before any LLM call |
| 17 | `[P3B-02]` Context builder | |
| 18 | `[P3C-01]` Agent CRUD | |
| 19 | `[P3C-04]` Agent message pipeline | First end-to-end agent flow |
| 20 | `[P3C-05]` Streaming responses | Core UX feature |

After sprint 1 completes: you have a fully working local chat app with one AI provider, streaming responses, and context management. Each subsequent phase adds incrementally.

---

*Last updated: 2026-04-03 | Status: Planning — Local Mode*
