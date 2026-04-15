# AGENTS.md

Compact repo guide for OpenCode sessions in `NextGenChat`.

## Read First
- Read `CLAUDE.md` before non-trivial work. It contains required file-header rules and the agent-system constraints that still matter.
- Read `apps/web/AGENTS.md` before editing `apps/web`. This repo uses `next@16.2.2`; check installed docs in `node_modules/next/dist/docs/` instead of relying on memory.
- Read `plan.md` only for major architecture or cross-package changes. Prefer scripts and code over plan prose when they disagree.
- Prefer executable sources over phase/status prose. Some README sections lag behind the current code.

## Repo Shape
- Monorepo: `apps/backend`, `apps/web`, `packages/types`, `packages/config`.
- `packages/types` is the contract source of truth for API payloads and socket events. Backend and web are expected to import from it, not redefine schemas locally.
- `packages/types/src/index.ts` re-exports with explicit `.js` paths; keep that pattern when adding exports.
- `apps/mobile` is not a workspace package yet; do not assume mobile scripts exist.

## Commands That Matter
- Use `pnpm setup:local`, not `pnpm setup`. The README calls out that `pnpm setup` can hit pnpm's built-in command instead of the repo bootstrap.
- `pnpm dev:local` is the real local dev entrypoint. It stops stale servers, copies root `.env` to `apps/backend/.env`, runs `prisma:generate` + `prisma:push`, then starts Turbo dev.
- `pnpm install:local` is the one-line bootstrap/service install path, not a normal dependency install.
- Focused package commands:
  - Backend: `pnpm --filter @nextgenchat/backend dev|build|lint|typecheck|test`
  - Web: `pnpm --filter @nextgenchat/web dev|build|lint|typecheck`
  - Types: `pnpm --filter @nextgenchat/types build|lint|typecheck`
- Single backend test: `pnpm --filter @nextgenchat/backend exec vitest run <path-or-pattern>` or `-t "name"`.
- `apps/web` currently has no test script, and backend `test` runs Vitest with `--passWithNoTests`. A green `pnpm test` is weaker evidence than usual.

## Verified Local Mode Behavior
- `scripts/setup.sh` forces local defaults into `.env`: `DEPLOYMENT_MODE=local`, `DATABASE_URL=file:./dev.db`, `REDIS_ENABLED=false`.
- Root `.env` is the source file; setup/dev scripts copy it to `apps/backend/.env` for Prisma.
- `AGENT_WORKSPACES_DIR` is chosen during setup and stored outside the repo by default (`~/.nextgenchat/agent-workspaces`). Do not assume agent files live under the project tree.
- `.env.example` sets `OPENAI_API_KEY=disabled-local-key`. The server can boot without a real provider key, but agent-doc assistance, creator generation, and some provider-backed flows degrade or fall back until a real key is configured.

## Verification Order
- CI runs: `pnpm --filter @nextgenchat/backend prisma:generate` -> `pnpm lint` -> `pnpm typecheck` -> `pnpm test` -> `pnpm --filter @nextgenchat/backend prisma:validate`.
- If you change shared contracts in `packages/types`, run `pnpm --filter @nextgenchat/types build` before typechecking backend or web.

## Source File Rule
- Every source file in `apps/` and `packages/` must keep the top-of-file scaffold note described in `CLAUDE.md`.
- When creating a new source file, add that note before imports.

## Architecture Notes Agents Commonly Miss
- Backend entrypoint is `apps/backend/src/main.ts`: Fastify + Socket.io + Prisma, with the agent processor started at boot.
- Queue behavior is mode-dependent: `apps/backend/src/queues/agent.processor.ts` creates a real BullMQ worker only when Redis is enabled; local mode returns a no-op worker handle.
- Keep backend route handlers thin; business logic lives in `*.service.ts`.
- Non-public backend routes and socket payloads are expected to be validated with shared Zod schemas from `@nextgenchat/types`.
- The actual built-in agent tool list lives in `apps/backend/src/modules/agents/default-agent-tools.ts`; do not trust older README references to a smaller tool set.

## Agent-System Gotchas
- Agent trigger modes in shared types are `AUTO`, `WAKEUP`, `MENTIONS_ONLY`, `ALL_MESSAGES`, `DISABLED`. Routing service handles `WAKEUP` / `MENTIONS_ONLY` / `DISABLED` specially and schedules the other active modes unconditionally.
- Protected agent workspace files are enforced in backend tooling. Agents must not write `soul.md`, `identity.md`, `agent.md`, `pickup.md`, or `wakeup.md` directly.
- Preserve `stripMessageWrapper()` protections in `apps/backend/src/modules/gateway/agent-session.gateway.ts` and `apps/backend/src/modules/tools/tool-registry.service.ts` so saved replies do not leak internal XML-style wrappers.
