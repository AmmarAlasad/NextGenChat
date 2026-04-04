# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Status

**Phases 1 through early 4 are implemented and running.** The full architecture and roadmap live in `plan.md`. Read it before starting any significant work — it contains phase-by-phase task breakdowns, data models, security requirements, and the rationale behind tech choices.

What is currently running:
- **Phase 1:** owner setup wizard, JWT auth (access token in memory, refresh in httpOnly cookie), one workspace + channel + agent, message persistence, BullMQ agent job pipeline, Socket.io streaming, full frontend (setup → login → chat)
- **Phase 2/3B (partial):** direct chats, group chats, speaker-aware group context assembly
- **Phase 3C (partial):** agent creation + profile editing, group membership management for agents, selective agent routing before full prompt construction
- **Phase 4 (partial):** dedicated agent workspace pages (profile + markdown docs), default agent workspace tools (`workspace.read_file`, `workspace.apply_patch`)

## Monorepo Layout

```
apps/
  backend/    # Fastify + Socket.io + TypeScript API server
  web/        # Next.js 15 (App Router) frontend
  mobile/     # React Native + Expo (Phase 7, not yet scaffolded)
packages/
  types/      # Shared TypeScript types + Zod schemas (consumed by backend, web, mobile)
  config/     # Shared ESLint, Prettier, TypeScript configs
```

Managed with **pnpm workspaces + Turborepo**. Package names are `@nextgenchat/backend`, `@nextgenchat/web`, `@nextgenchat/types`, etc.

## Top-of-File Notes (Required on Every File)

Every source file in `apps/` and `packages/` **must** begin with a comment block that covers:

1. **What the file is** — one-line description of its role in the architecture
2. **Current scope** — what is actually implemented right now (Phase N status)
3. **Future responsibilities** — what will grow here in later phases

Use this format for TypeScript/TSX files:

```ts
/**
 * <Short title>
 *
 * <One-sentence description of the file's architectural role.>
 *
 * Phase N implementation status:
 * - <What is currently done.>
 * - <What is intentionally left as a stub.>
 * - <What future phases will add here.>
 */
```

**Rules:**
- Preserve these notes when editing. Update them when the file's role or scope changes.
- Do not delete a note and replace it with a shorter generic comment.
- If you create a new file, write this note before any imports.
- Keep the note accurate — a stale note is worse than no note.

## Commands

```bash
# ── First-time setup (run once after cloning) ────────────────────────────────
# Creates a local SQLite-backed .env, installs deps, and syncs Prisma.
pnpm setup:local

# One-line bootstrap from a cloned repo
pnpm install:local

# ── Daily dev workflow ────────────────────────────────────────────────────────
# Syncs Prisma and launches backend (http://localhost:3001)
# + frontend (http://localhost:3000).
pnpm dev:local
pnpm dev:phase1

# Stop all dev servers
pnpm stop

# ── Other ─────────────────────────────────────────────────────────────────────
# Install all workspace dependencies
pnpm install

# Start full stack via Docker (legacy/shared-mode infra)
docker compose -f docker/docker-compose.yml up

# Run all apps in dev mode without the infra/migration pre-check
pnpm dev

# Run a single app
pnpm --filter @nextgenchat/backend dev
pnpm --filter @nextgenchat/web dev

# Type-check / lint / format
pnpm typecheck
pnpm lint
pnpm format                # prettier --write

# Build all packages (Turborepo handles dependency order)
pnpm build

# Tests (only backend has tests — apps/web has no test script yet)
pnpm test                                                                  # all packages
pnpm --filter @nextgenchat/backend test                                    # backend only
pnpm --filter @nextgenchat/backend test:watch                              # watch mode
pnpm --filter @nextgenchat/backend exec vitest run src/path/to/file.test.ts  # single file
pnpm --filter @nextgenchat/backend exec vitest run -t "test name"          # single test by name

# Prisma (note the colon-separated script names)
pnpm --filter @nextgenchat/backend prisma:generate   # after schema changes
pnpm --filter @nextgenchat/backend prisma:push       # sync the local SQLite schema
pnpm --filter @nextgenchat/backend prisma:migrate    # network/shared-mode migration workflow
pnpm --filter @nextgenchat/backend prisma:studio     # GUI browser
```

## Architecture Decisions (Do Not Re-litigate)

These are locked decisions from `plan.md`:

- **Fastify** (not Express) for the backend — schema validation, TypeScript-first, performance
- **Socket.io** (not raw WebSockets) — for rooms, namespaces, optional Redis adapter, and mobile SDK compatibility
- **SQLite is the default local data store** — no external database is required for one-line local installs
- **Redis and BullMQ are optional in local mode** and become required again for shared/cloud scale
- **Prisma** ORM — no raw SQL except for full-text search queries using `$queryRaw` when necessary
- **Argon2id** for password hashing — not bcrypt, not SHA
- **Refresh tokens in `httpOnly; Secure; SameSite=Strict` cookies** — access tokens in memory, never `localStorage`
- **Zod schemas in `packages/types`** are the single source of truth for API contracts — both backend and frontend import from there, never duplicate schemas
- **Deployment mode is environment-driven** — `DEPLOYMENT_MODE=local` (default) relaxes TLS/rate-limit requirements; `DEPLOYMENT_MODE=network` hardens everything. Never hardcode mode-specific behavior outside of config

## LLM Provider Layer

Five supported providers, each in its own file under `modules/providers/`. All implement the `LLMProvider` interface from `@nextgenchat/types`.

| Provider | Auth | Notes |
|---|---|---|
| `openai` | API key | tiktoken for token counting |
| `openai-codex-oauth` | OAuth 2.0 | tokens stored in `OAuthToken` table, auto-refresh |
| `anthropic` | API key | exact token counting via `/v1/messages/count_tokens`; prompt caching via `cache_control` |
| `kimi` | API key | OpenAI-compatible API at `api.moonshot.cn`; extends OpenAI provider |
| `openrouter` | API key | OpenAI-compatible; model list fetched from OpenRouter and cached in Redis |

- Provider credentials are **encrypted at rest** (AES-256-GCM, key from `ENCRYPTION_KEY` env var) — never returned to clients
- `ProviderRegistry` is a singleton that caches instantiated providers by config hash
- When adding a new provider: implement `LLMProvider`, register in `ProviderRegistry`, add config schema to `packages/types/src/providers.ts`

## Context Window Management

Three-layer system, all in `modules/context/`:

1. **Token counting** (`token-counter.ts`): `tiktoken` for OpenAI/Kimi/OpenRouter, Anthropic API endpoint for Claude. Always reserve a `RESPONSE_BUFFER` (default 4096 tokens).
2. **Auto-compaction** (`compaction.service.ts`): when history exceeds budget, summarize old messages via a cheap model (gpt-4o-mini / claude-haiku), store in `ConversationSummary` table. Runs as async BullMQ job — never blocks current LLM call.
3. **Prompt caching** (`cache.service.ts`): for Anthropic, add `cache_control: { type: "ephemeral" }` after static context (system prompt + memory). Track `cache_read_input_tokens` vs `cache_creation_input_tokens` in `message.metadata`.

`ContextBuilder.build(agentId, channelId, messageId)` is the single entry point — assembles system prompt + memory + summary + recent messages within budget.

## Shared Types Package (`packages/types`)

This is critical. Any time you add a new API endpoint, socket event, or DB-facing DTO:
1. Define the Zod schema in `packages/types/src/`
2. Export the inferred TypeScript type alongside it
3. Import in both backend route handler and frontend API client

Socket event names and payloads are defined in `packages/types/src/socket-events.ts` as discriminated unions.

## Backend Module Structure

Each feature is a self-contained module under `apps/backend/src/modules/`:

```
modules/
  auth/
    auth.routes.ts      # Fastify route registrations
    auth.service.ts     # Business logic
    auth.schema.ts      # Re-exports from @nextgenchat/types (do not redefine)
  chat/
  agents/
    agent-routing.service.ts   # Pre-LLM routing decision — which agents respond
  workspace/
    agent-workspace-tools.service.ts  # Default read_file / apply_patch tools
  rules/
  mcp/
  context/
  providers/
```

Sockets live in `apps/backend/src/sockets/`: `chat.socket.ts` handles `/chat` namespace events, `presence.socket.ts` handles `/presence`.

Route handlers stay thin — call service methods, return results. All business logic lives in `*.service.ts`.

## Security Requirements (Non-Negotiable)

These apply to every PR, not just "security tickets":

- All route inputs validated with Zod (import schema from `@nextgenchat/types`)
- Auth middleware (`preHandler` hook) on every non-public route
- Socket.io events validated with Zod before any processing
- Rate limiting applied to all auth endpoints and message-send events
- File uploads: MIME type verified server-side, path keys validated against safe pattern (`/^[\w\-\/]+\.\w+$/`)
- Never log passwords, tokens, or message content — log IDs instead
- Agent workspace access is isolated by default — always check `agentId` ownership before file operations

## Real-Time Conventions

- **Rooms:** named `channel:{channelId}` — join on `channel:join` event, leave on disconnect or `channel:leave`
- **Namespaces:** `/chat` for messages, `/presence` for online status
- **All server→client events** are defined types in `socket-events.ts` — do not emit ad-hoc string events
- Agents emit messages through the same pipeline as users (`senderType: 'AGENT'`), never via a separate socket path

## Agent Job Pipeline

When implementing anything that involves an agent responding:
1. Save the triggering message to DB
2. Enqueue a BullMQ job (`agent:process`) — never call the LLM inline
3. Worker builds context: system prompt + injected memory + recent message history
4. LLM response saved as message (`senderType: AGENT`) and broadcast via Socket.io
5. Memory update (if any) happens after broadcast — do not block the response

### BullMQ Queue Processors

Four processors live under `apps/backend/src/queues/`:

| File | Queue | Purpose |
|---|---|---|
| `agent.processor.ts` | `agent:process` | Runs the LLM call, streams response, saves message |
| `compaction.processor.ts` | `context:compact` | Summarizes old history when token budget is exceeded |
| `file-scanner.processor.ts` | `file:scan` | Virus-scans uploaded attachments |
| `cron.processor.ts` | `agent:cron` | Triggers scheduled agent tasks (AgentCronJob) |

## Agent Routing

Before building full context for any agent, `agent-routing.service.ts` runs a three-stage filter:

1. **Deterministic gates** — immediate pass/fail: `triggerMode` (DISABLED, MENTIONS_ONLY, ALL_MESSAGES, AUTO), cooldown window (last N messages), agent-chain depth guard
2. **Shortlist** — explicit `@slug` mentions, name mentions (user messages only), fan-out keywords (`both`, `all`, `everyone`, etc.), and group-wide identity questions
3. **Router model** — for AUTO-mode agents not caught by stage 2, a cheap OpenAI call reads compact agent profiles and decides who should respond

`ROUTING_MAX_RESPONDERS` caps simultaneous responders; `ROUTING_MAX_AGENT_CHAIN` prevents infinite agent-to-agent loops. Both are constants in `apps/backend/src/config/constants.ts`.

## Agent Workspace & Docs

Every agent has an isolated workspace in the `WorkspaceFile` table (rows where `agentId` is set). The `AgentDocType` enum categorises the markdown documents that live there:

| DocType | Purpose |
|---|---|
| `AGENT_MD` | Core identity + capabilities document |
| `IDENTITY_MD` | Persona and voice details |
| `AGENCY_MD` | What the agent is allowed to do |
| `MEMORY_MD` | Long-term persistent notes written by the agent |
| `HEARTBEAT_MD` | Cron-driven status log |

All agents receive two workspace tools by default (implemented in `agent-workspace-tools.service.ts`):
- `workspace.read_file` — reads a file from the agent's workspace by `fileName`
- `workspace.apply_patch` — applies a SEARCH/REPLACE diff using the format:

```
=== SEARCH ===
<old text>
=== REPLACE ===
<new text>
```

File access is isolated per agent — always filter by `agentId` in workspace file queries.

## TypeScript Conventions

- The repo uses `strict` TypeScript; do not bypass with `any` unless unavoidable and documented
- Prefer inferred types from Zod via `z.infer<typeof Schema>` — export both schema and type together
- Use `import type` for type-only imports
- In backend code, use `@/*` path alias for local source imports
- In `packages/types`, internal re-exports use explicit `.js` extensions in export paths, and everything re-exports through `src/index.ts`

## Naming Conventions

- `PascalCase` for Zod schemas, enums, React components, TypeScript types
- `camelCase` for variables, functions, service methods, object properties
- `SCREAMING_SNAKE_CASE` only for true top-level constants
- Module filenames: `auth.routes.ts`, `auth.service.ts`, `auth.schema.ts`

## Frontend Notes

- **Next.js 16.2.2** — APIs and conventions may differ from training data. Read `node_modules/next/dist/docs/` before changing framework-specific code and heed deprecation notices
- State management: **Zustand** for client state, **TanStack Query** for server state
- **Tailwind CSS v4** — theme tokens are registered via `@theme inline { }` in `globals.css`, not `tailwind.config.ts`. Add new design tokens there only.
- Reuse schemas/types from `@nextgenchat/types` for forms and API clients

### Design System — Antimatter UI (Indigo)

The frontend uses the **Antimatter UI** design system. All color tokens are defined in `apps/web/src/app/globals.css` under `:root` and the `@media (prefers-color-scheme: dark)` block. Never use hardcoded hex colors in component files — always use CSS custom property tokens (e.g. `bg-primary`, `text-on-surface-variant`).

Key tokens:
- `--primary: #4c58a6` (indigo accent)
- `--surface-container-lowest`: card backgrounds
- `--on-surface` / `--on-surface-variant`: text hierarchy
- `--outline-variant`: borders and dividers

Typography:
- **Manrope** (loaded as `--font-manrope`) → exposed as `font-headline` Tailwind utility. Use for headings and branded text.
- **Geist Sans** (`--font-geist-sans`) → default body font via `--font-sans`
- **Geist Mono** (`--font-geist-mono`) → code/monospace

### Frontend Design Skill

The `frontend-design` skill is installed at `~/.claude/skills/frontend-design/SKILL.md`. Invoke it with `/frontend-design` before any UI work to enforce distinctive, production-grade design — not generic AI aesthetics. Key rules from the skill:
- Never use Inter, Roboto, or Arial — use the already-configured Manrope/Geist stack
- Commit to a clear aesthetic direction before touching a component
- Avoid purple-gradient-on-white clichés — the indigo system is already differentiated
- Use `@theme inline` animation tokens (e.g. `animate-typing`) for motion

### Chat Screen Layout

`apps/web/src/components/chat-screen.tsx` is a fixed-height layout (`h-screen overflow-hidden`). The messages canvas (`<section ref={scrollContainerRef}>`) is the **only** scrollable element. Auto-scroll only fires when the user is within 120 px of the bottom (`isNearBottomRef`). Do not reintroduce `scrollIntoView` or `min-h-screen` on the outer containers — both were bugs that caused whole-page scroll jitter.

### Agent Admin Page

`apps/web/src/app/agents/[id]/page.tsx` renders `agent-admin-screen.tsx` — the per-agent workspace view (profile, markdown docs, tool config). This is a separate route from the main chat shell.

## Environment & Secrets

- `.env.example` is committed, `.env` is gitignored
- Backend validates all required env vars with Zod on startup (`src/config/env.ts`) — the server refuses to start if misconfigured
- LLM API keys and MCP server env vars are stored encrypted in the DB, not in environment variables
- Docker test stack available at `docker/docker-compose.test.yml`
