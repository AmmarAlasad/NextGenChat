# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Status

**Phases 1 through 5 are implemented and running.** The full architecture and roadmap live in `plan.md`. Read it before starting any significant work.

What is currently running:
- **Phase 1:** owner setup wizard, JWT auth (access token in memory, refresh in httpOnly cookie), one workspace + channel + agent, message persistence, BullMQ agent job pipeline, Socket.io streaming, full frontend (setup → login → chat)
- **Phase 2/3B:** direct chats, group chats, speaker-aware group context assembly
- **Phase 3C:** agent creation + profile editing, group membership management, per-agent WAKEUP-LLM routing
- **Phase 4:** dedicated agent workspace pages, eight-file agent architecture, AgentCreatorAgent, `send_reply` / `channel_send_message` / workspace tools, structured validators on all agent file writes, session lanes (serial execution per agent:channel), real SSE streaming
- **Phase 5:** rules engine (stub), MCP integration (Browser MCP via stdio), agent skills system, agent cron scheduling, task mode with todowrite tool, wakeup LLM service

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
pnpm setup:local       # Creates .env, installs deps, syncs Prisma
pnpm install:local     # One-line bootstrap from cloned repo

# ── Daily dev workflow ────────────────────────────────────────────────────────
pnpm dev:local         # Backend (http://localhost:3001) + frontend (http://localhost:3000)
pnpm stop              # Stop all dev servers

# ── Other ─────────────────────────────────────────────────────────────────────
pnpm install           # Install all workspace dependencies
pnpm dev               # All apps in dev mode (no infra pre-check)
pnpm --filter @nextgenchat/backend dev
pnpm --filter @nextgenchat/web dev

# Type-check / lint / format
pnpm typecheck
pnpm lint
pnpm format

# Build (Turborepo handles dep order — always build types first if changed)
pnpm build
pnpm --filter @nextgenchat/types build   # required before typechecking backend/web

# Tests
pnpm test
pnpm --filter @nextgenchat/backend test
pnpm --filter @nextgenchat/backend test:watch
pnpm --filter @nextgenchat/backend exec vitest run <path-or-pattern>  # single file/pattern

# Prisma
pnpm --filter @nextgenchat/backend prisma:generate   # after schema changes
pnpm --filter @nextgenchat/backend prisma:push       # sync local SQLite schema
pnpm --filter @nextgenchat/backend prisma:migrate    # network/shared-mode workflow
pnpm --filter @nextgenchat/backend prisma:studio     # GUI browser
```

## Architecture Decisions (Do Not Re-litigate)

- **Fastify** (not Express) — schema validation, TypeScript-first, performance
- **Socket.io** (not raw WebSockets) — rooms, namespaces, optional Redis adapter, mobile SDK compatibility
- **SQLite is the default local data store** — no external database required for one-line local installs
- **Redis and BullMQ are optional in local mode**, required for shared/cloud scale
- **Prisma** ORM — no raw SQL except `$queryRaw` for full-text search
- **Argon2id** for password hashing — not bcrypt, not SHA
- **Refresh tokens in `httpOnly; Secure; SameSite=Strict` cookies** — access tokens in memory, never `localStorage`
- **Zod schemas in `packages/types`** are the single source of truth — both backend and frontend import from there, never duplicate schemas
- **Deployment mode is environment-driven** — `DEPLOYMENT_MODE=local` relaxes TLS/rate-limit requirements; `DEPLOYMENT_MODE=network` hardens everything

## Eight-File Agent Architecture

Every agent has an isolated on-disk workspace under `$AGENT_WORKSPACES_DIR/{agentId}/`. Eight markdown files define the agent completely:

| File | Who writes it | Purpose |
|---|---|---|
| `soul.md` | AgentCreatorAgent only | Immutable ethics and values — bootstrap priority 20, injected after Agent.md |
| `identity.md` | AgentCreatorAgent only | Public persona, tone, communication style |
| `Agent.md` | AgentCreatorAgent only | Operating manual — tool rules, memory update triggers, multi-step response rules |
| `user.md` | Agent itself | Evolving model of the user, written via `workspace_write_file` |
| `memory.md` | Agent itself | Long-term patterns and learnings, written via `workspace_write_file` |
| `Heartbeat.md` | Agent itself | Cron-driven status log for resumable long-running work |
| `wakeup.md` | AgentCreatorAgent only | Decision instructions for the wakeup LLM (when to respond in groups) |
| `pickup.md` | AgentCreatorAgent only | (Legacy alias) same purpose as wakeup.md — kept for compatibility |

**Write protection:** `workspace_write_file` (the agent tool) blocks writes to `soul.md`, `identity.md`, `agent.md`, and `pickup.md`. Agents may only update `user.md`, `memory.md`, and `heartbeat.md`. Only `AgentCreatorAgent` (admin API) may update protected files.

**Context injection order** (inside `ContextBuilder.build`; bootstrap priorities defined in `bootstrap-context.ts`):
1. `runtime-context.md` — current channel, participants, constraints (injected by ContextBuilder directly)
2. `Agent.md` — operating manual (bootstrap priority 10)
3. `soul.md` — ethics and values (bootstrap priority 20)
4. `identity.md` — persona and voice (bootstrap priority 30)
5. `user.md` — agent's model of the user (bootstrap priority 40)
6. `tools.md` — approved tool list and usage rules (generated, bootstrap priority 50)
7. `agency.md` — workspace-level constitution, shared across all agents (bootstrap priority 60)
8. `project.md` — channel project context; stored in `WorkspaceFile`, managed via `project.service.ts` (bootstrap priority 65)
9. `memory.md` — long-term learnings (bootstrap priority 70)
10. `Heartbeat.md` — dynamic, resumable work state (below cache boundary, always rebuilt)
11. Conversation summary — compacted older history
12. Cross-channel context — DM channels only

## AgentCreatorAgent

`apps/backend/src/modules/agents/agent-creator.service.ts` is a dedicated LLM service that generates and maintains the eight agent files. It is the **only** path that may write to protected files.

Two entry points:
- **`generateAndWriteAgentDocs(agentId, name, description)`** — called during setup; generates all eight files from a plain-language description
- **`chatWithCreator(agentId, message, history)`** — called from the admin chat panel; edits files through conversation

**Safety validators** run before every file write and reject:
- `wakeup.md` / `pickup.md` that is a JSON blob instead of instruction markdown
- `Agent.md` missing `send_reply`, `memory.md`, `user.md`, or `workspace_write_file` references
- `soul.md` that is too short or is a JSON blob
- Any file shorter than its minimum viable length

Rejected updates leave the existing file untouched. The chat reply notes what was blocked and why.

Route: `POST /agents/:id/creator/chat`

## Agent Tools

All tools live in `apps/backend/src/modules/tools/tool-registry.service.ts`. Default tools are registered in `default-agent-tools.ts`.

| Tool | Purpose |
|---|---|
| `workspace_read_file` | Read a file or directory from the agent's workspace |
| `workspace_write_file` | Write a file inside the agent's workspace (protected files blocked) |
| `workspace_bash` | Run shell commands from the agent workspace with timeout |
| `channel_send_message` | Post a message to a different non-direct channel the agent belongs to (cross-channel relay) |
| `send_reply` | Post an intermediate message to the **current** channel mid-turn — enables human-like multi-part replies |
| `todowrite` | Create/update/cancel todo items; state persisted to `.nextgenchat/todo-state.json` for task-mode continuation |

`send_reply` is the key tool for natural pacing. The agent calls it to post a first message ("Let me look into that…"), does the work, then produces a final reply. The user sees 2–3 messages from one agent turn. It does **not** trigger other agents.

`channel_send_message` is for relay only (posting to a different group channel). It **does** trigger other agents in the target channel with `isRelay: true`.

`executeToolCall` requires both `agentId` and `channelId` in the execution context so `send_reply` knows which channel to post to.

## Agent Routing

`agent-routing.service.ts` — gate-based filter before any LLM call:

**Trigger modes (per agent):**
- `DISABLED` — always skipped
- `MENTIONS_ONLY` — only when explicitly addressed by name/slug
- `ALL_MESSAGES` / `AUTO` — scheduled unconditionally; agent self-filters with `[[NO_REPLY]]`
- `WAKEUP` — runs a cheap pre-filter LLM (`gpt-4o-mini` + `wakeup.md`) before scheduling

**Evaluation order:**
1. Mode gate — DISABLED skips immediately; MENTIONS_ONLY checks for explicit mention
2. Agent-sender guard — when sender is an agent and `isRelay=false`, only explicitly mentioned agents respond (prevents infinite chains). Relay messages (`isRelay=true`) bypass this guard.
3. For `WAKEUP` agents — `wakeup-llm.service.ts` runs `gpt-4o-mini` with `wakeup.md` as the system prompt and last 8 messages as context. Returns YES/NO. Defaults to NO on error.
4. `ALL_MESSAGES`/`AUTO` agents — enqueued unconditionally; the agent produces `[[NO_REPLY]]` to self-filter.

**Wakeup model defaults:** `WAKEUP_MODEL = 'gpt-4o-mini'`, `WAKEUP_MAX_TOKENS = 10`, `WAKEUP_CONTEXT_MESSAGES = 8`, `temperature = 0.0`. All WAKEUP checks run in parallel.

**Message visibility (`agent-visibility.ts`):** user messages are visible to all eligible channel members; agent reply messages are visible in an agent's context only if (a) it is the agent's own reply, or (b) the reply explicitly mentions another agent by `@slug` or name. This prevents agents from seeing each other's unrelated conversation threads.

## LLM Provider Layer

Five supported providers under `modules/providers/`. All implement `LLMProvider` from `@nextgenchat/types`.

| Provider | Auth | Notes |
|---|---|---|
| `openai` | API key | tiktoken for token counting |
| `openai-codex-oauth` | OAuth 2.0 | tokens in `GlobalProviderConfig` row (encrypted), auto-refresh |
| `anthropic` | API key | exact token count via `/v1/messages/count_tokens`; prompt caching via `cache_control` |
| `kimi` | API key | OpenAI-compatible at `api.moonshot.cn`; extends OpenAI provider |
| `openrouter` | API key | OpenAI-compatible; model list fetched from OpenRouter and cached in Redis |

- Credentials encrypted at rest (AES-256-GCM, key from `ENCRYPTION_KEY`)
- `ProviderRegistry` caches instantiated providers by config hash

## Context Window Management

Four-layer system in `modules/context/`:

1. **Token counting** (`token-counter.ts`): tiktoken for OpenAI/Kimi/OpenRouter, Anthropic API for Claude. Always reserve `RESPONSE_BUFFER` (default 4096 tokens).
2. **Auto-compaction** (`compaction.service.ts`): when history exceeds budget, summarize old messages via a cheap model, store in `ConversationSummary`. Runs as async BullMQ job — never blocks current LLM call.
3. **Prompt caching** (`cache.service.ts`): for Anthropic, add `cache_control: { type: "ephemeral" }` after static context. Track `cache_read_input_tokens` vs `cache_creation_input_tokens` in `message.metadata`.
4. **Static prefix cache** (`static-prefix-cache.ts`): caches the static doc portion of the prompt (soul, identity, Agent.md, tools, user, memory, project, agency, runtime-context) by mtime-hash + TTL. Invalidated by `workspaceService.writeAgentWorkspaceFile()`. Heartbeat.md, conversation summary, and history are never cached.

`ContextBuilder.build(agentId, channelId, messageId)` is the single entry point.

## Shared Types Package (`packages/types`)

Any time you add a new API endpoint, socket event, or DB-facing DTO:
1. Define the Zod schema in `packages/types/src/`
2. Export the inferred TypeScript type alongside it
3. Import in both backend route handler and frontend API client
4. Run `pnpm --filter @nextgenchat/types build` before typechecking other packages

Socket event names and payloads are defined in `packages/types/src/socket-events.ts` as discriminated unions.

Key non-obvious type files:
- `providers-admin.ts` — `ProviderStatus`, `SetApiKeyCredentialSchema`, `UpdateAgentProviderSchema`, `SetFallbackProviderSchema`, `STATIC_PROVIDER_MODELS`, `PROVIDER_METADATA`

## Backend Module Structure

```
modules/
  auth/
    auth.routes.ts       # Fastify route registrations
    auth.service.ts      # Business logic (setup, login, refresh, logout)
    auth.schema.ts       # Re-exports from @nextgenchat/types
  chat/
    chat.service.ts      # Message persistence, agent scheduling, relay messages
  agents/
    agents.service.ts          # Agent CRUD
    agent-routing.service.ts   # Pre-LLM routing — which agents respond
    agent-routing.utils.ts     # Pure deterministic heuristics (no DB/provider deps, unit-testable)
    agent-creator.service.ts   # AgentCreatorAgent — generates and edits agent docs
    agent-output.ts            # Sanitizes LLM output: strips block tags, leaky prompts, [[NO_REPLY]]
    agent-visibility.ts        # Message visibility rules — which messages enter an agent's context
    agent-cron.service.ts      # Agent-managed cron/one-off schedules; mirrors to .nextgenchat/schedules.json
    wakeup-llm.service.ts      # Cheap pre-filter LLM for WAKEUP-mode agents (reads wakeup.md)
    skill.service.ts           # Agent skills — directories rooted in agent workspace at skills/{name}/
    skill-installer.service.ts # Installs skills from templates or external sources
    task-state.ts              # Todo-backed task-state parsing + multi-step continuation rules
    default-agent-tools.ts     # Default tool set registered for new agents
  gateway/
    agent-session.gateway.ts   # Owns full agent turn lifecycle (replaced agent.processor as entry point)
    session-lane.ts            # At-most-one-active-turn per agentId:channelId (serial execution)
  project/
    project.service.ts        # Project CRUD; project.md file stored in WorkspaceFile table
    project.routes.ts         # Project API routes
  workspace/
    workspace.service.ts             # Agent doc file management (read/write/ensure)
    workspace.routes.ts              # Workspace API routes
    agent-workspace-tools.service.ts # `read_file` and `apply_patch` tools for agents (=== SEARCH === / === REPLACE === format)
  tools/
    tool-registry.service.ts  # Built-in tool definitions and execution
  context/
    context-builder.ts        # Assembles LLM prompt from docs + history
    bootstrap-context.ts      # OpenClaw-ported file budgeting/truncation — 20 KB/file, 150 KB total, 70%+20% head+tail strategy
    static-prefix-cache.ts    # Caches static doc prefix by mtime-hash + TTL
  mcp/
    mcp.service.ts            # Browser MCP runtime integration — stdio client, tool sync to DB
    mcp.routes.ts             # MCP API routes
  rules/
    rules.service.ts          # Policy evaluation stub (ALLOW/BLOCK/REQUIRE_APPROVAL) — Phase 5 TODO
    rules.routes.ts           # Rules API routes
  providers/
    providers.routes.ts       # Provider admin API — CRUD for global credentials, per-agent provider, fallback, OpenAI Codex OAuth flow
    base.provider.ts          # Abstract LLMProvider base class
    registry.ts               # ProviderRegistry — caches instantiated providers by config hash
    openai.provider.ts        # OpenAI provider (tiktoken)
    anthropic.provider.ts     # Anthropic provider (exact token count + prompt caching)
    kimi.provider.ts          # Kimi/Moonshot provider (extends OpenAI)
    openrouter.provider.ts    # OpenRouter provider (dynamic model list from API, cached in Redis)
    openai-codex-oauth.provider.ts  # Codex OAuth flow helpers
queues/
  agent.processor.ts    # Thin BullMQ worker shell — delegates to agent-session.gateway.ts#runAgentTurn()
```

Route handlers stay thin — call service methods, return results. All business logic lives in `*.service.ts`.

## Agent Session Gateway (`gateway/agent-session.gateway.ts`)

`agent.processor.ts` is now a thin BullMQ shell — all turn logic lives in `agent-session.gateway.ts#runAgentTurn()`.

Key behaviours:
- **Session lanes** (`session-lane.ts`): at most one active turn per `agentId:channelId`. Concurrent jobs queue behind the active lane.
- **Real SSE streaming**: uses `provider.stream()` for final text rounds; non-streaming for intermediate tool rounds.
- **Tool activity events**: emits `agent:tool:start` / `agent:tool:end` socket events during the tool loop so the frontend can show live activity indicators.
- Strips `<message speaker="..." speakerType="...">` XML wrappers from LLM output before saving — prevents self-reinforcing pattern.
- `sanitizeAgentVisibleContent()` (in `agent-output.ts`) strips internal block tags (`<thinking>`, `<scratchpad>`, etc.) and leaky prompt fragments before any text is shown to users.
- If the sanitized output equals `[[NO_REPLY]]` the agent's turn is silently discarded — no message saved, no Socket.io event emitted.
- Relay commands (`<<send:channel-name>>…<</send>>`) are extracted after the LLM call, stripped from the saved response, and posted to target channels.
- **Task mode** (`task-state.ts`): if the request likely requires multi-step work, the gateway injects task-mode instructions and evaluates whether a tool-loop turn should continue based on persisted todo state at `.nextgenchat/todo-state.json` in the agent workspace. The `todowrite` tool updates this file.

## Agent Skills

`skill.service.ts` — each skill is a directory in the agent workspace at `skills/{name}/` with a required `SKILL.md` entry point. Metadata is stored in the `AgentSkill` DB table; the full directory lives on disk.

- Skills have a `type` (e.g. `CUSTOM`, `TEMPLATE`) and `sourceType` (e.g. `LOCAL`, `GITHUB`)
- File inventory is classified by path: `SKILL.md` → `skill`, `references/*` → `reference`, `scripts/*` → `script`, `assets/*` → `asset`
- Activating a skill exposes its real installed structure to the agent context
- `staticPrefixCache.invalidate(agentId)` is called after skill changes

## Agent Cron Scheduling

`agent-cron.service.ts` — agents can schedule both one-off wakeups and recurring cron tasks.

- Schedules persisted in Prisma (`AgentSchedule` table) with per-channel targeting
- Mirrored to `.nextgenchat/schedules.json` in the agent workspace so agents can inspect/edit their own schedules
- Simple scheduled posts are delivered directly when the task clearly describes a message to send

## MCP Integration

`mcp.service.ts` — manages a workspace-scoped Browser MCP server over stdio.

- Uses `@modelcontextprotocol/sdk` stdio client; one Browser MCP server per workspace
- Discovered tools are synced into `McpServerTool` and `AgentTool` Prisma rows
- Per-agent enable/disable via `AgentTool` join table
- MCP env vars stored encrypted (AES-256-GCM) in the `McpServer` row
- Future: multi-server registration, approval workflows

## Security Requirements (Non-Negotiable)

- All route inputs validated with Zod (import schema from `@nextgenchat/types`)
- Auth middleware (`preHandler` hook) on every non-public route
- Socket.io events validated with Zod before any processing
- Rate limiting on all auth endpoints and message-send events
- File uploads: MIME type verified server-side, path keys validated against safe pattern
- Never log passwords, tokens, or message content — log IDs instead
- Agent workspace access is isolated — always check `agentId` ownership before file operations
- `workspace_write_file` blocks writes to `soul.md`, `identity.md`, `agent.md`, `pickup.md`

## Real-Time Conventions

- **Rooms:** `channel:{channelId}` — join on `channel:join`, leave on disconnect or `channel:leave`
- **Namespaces:** `/chat` for messages, `/presence` for online status
- **All server→client events** defined in `socket-events.ts` — no ad-hoc string events
- Agents emit messages through the same pipeline as users (`senderType: 'AGENT'`)
- `message:routing:complete` is emitted after routing (even when 0 agents selected) so the frontend can exit the routing/queued state

## Agent Job Pipeline

1. Save triggering message to DB
2. Enqueue BullMQ job (`agent:process`) — never call LLM inline
3. Worker delegates to `agent-session.gateway.ts#runAgentTurn()`
4. Session lane acquired (serial per agentId:channelId)
5. Context built via `ContextBuilder.build()`, task-mode instructions injected if needed
6. Tool loop: LLM call → tool calls → execute → repeat until text response
7. Strip message wrapper, extract relay commands, stream final response
8. Save message to DB, broadcast via Socket.io
9. Execute relay commands (post to other channels)
10. `triggerAgentsForMessage` for the saved response (agent-to-agent chains suppressed unless relay)

## Frontend Notes

- **Next.js 15 (App Router)** — read `node_modules/next/dist/docs/` before changing framework-specific code
- State management: **Zustand** for client state, **TanStack Query** for server state
- **Tailwind CSS v4** — tokens in `@theme inline { }` in `globals.css`, not `tailwind.config.ts`
- Reuse schemas/types from `@nextgenchat/types` for forms and API clients

### Design System — Antimatter UI (Indigo)

All color tokens in `apps/web/src/app/globals.css`. Never use hardcoded hex in component files — use CSS custom property tokens (`bg-primary`, `text-on-surface-variant`, etc.).

Key tokens:
- `--primary: #4c58a6` (indigo accent)
- `--surface-container-lowest`: card backgrounds
- `--on-surface` / `--on-surface-variant`: text hierarchy
- `--outline-variant`: borders and dividers

Typography: **Manrope** (`font-headline`) for headings, **Geist Sans** for body, **Geist Mono** for code.

### Frontend Design Skill

`~/.claude/skills/frontend-design/SKILL.md` — invoke with `/frontend-design` before any UI work.

### Chat Screen Layout

`chat-screen.tsx` is `h-screen overflow-hidden`. The messages canvas is the **only** scrollable element. Auto-scroll only fires when within 120px of bottom. Do not reintroduce `scrollIntoView` or `min-h-screen` on outer containers.

### Agent Admin Page

`apps/web/src/app/agents/[id]/page.tsx` renders `agent-admin-screen.tsx`. Contains:
- Agent settings form (name, persona, trigger mode, status)
- Eight-file doc editor with tab navigation
- **AgentCreatorAgent chat panel** — replaces the old writing assistant. User types natural-language instructions; AgentCreatorAgent updates the relevant files and reports what changed.

### Setup Wizard

`apps/web/src/app/setup/page.tsx` — first-run wizard. Takes `agentDescription` (not `agentSystemPrompt`). After creating the agent, calls `AgentCreatorService.generateAndWriteAgentDocs()` in the background to replace default docs with AI-generated content tailored to the description.

## Environment & Secrets

- `.env.example` is committed, `.env` is gitignored
- Backend validates all required env vars with Zod on startup — server refuses to start if misconfigured
- LLM API keys stored encrypted in DB, not in environment variables
- `AGENT_WORKSPACES_DIR` — path to on-disk agent workspaces (default: `agent-workspaces/`)
- Docker test stack: `docker/docker-compose.test.yml`
