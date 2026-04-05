# AGENTS.md

Agent operating guide for `NextGenChat`.

## Repo Snapshot
- Monorepo managed with `pnpm` workspaces and `turbo`.
- Apps live in `apps/`; shared packages live in `packages/`.
- Backend: Fastify + Socket.io + Prisma + TypeScript.
- Web: Next.js App Router + React + TypeScript.
- Shared API and socket contracts live in `packages/types` as Zod schemas plus inferred types.
- Current implementation status and roadmap live in `CLAUDE.md` and `plan.md`.

## First Reads
- Read `CLAUDE.md` before making non-trivial changes.
- Read `plan.md` before major architectural or cross-package changes.
- Read `apps/web/AGENTS.md` before editing anything in `apps/web`.

## Rule Files Present
- Root `AGENTS.md`: this file.
- `apps/web/AGENTS.md`: Next.js-specific warning plus scaffold-note reminder.
- No `.cursorrules` file was found.
- No `.cursor/rules/` directory was found.
- No `.github/copilot-instructions.md` file was found.

## Locked Architecture Rules
- Use Fastify, not Express.
- Use Socket.io, not raw WebSockets.
- Use Prisma for database access; avoid raw SQL except approved full-text cases.
- Use Argon2id for password hashing.
- Keep refresh tokens in secure `httpOnly` cookies; never use `localStorage`.
- Treat `packages/types` as the single source of truth for request, response, and socket contracts.
- Respect `DEPLOYMENT_MODE`; do not hardcode local vs shared behavior.
- Local mode may run work in-process; shared mode uses BullMQ and Redis-backed fan-out.

## Required File Header
- Every source file in `apps/` and `packages/` must begin with the scaffold note described in `CLAUDE.md`.
- Preserve existing scaffold notes when editing.
- If a file's responsibility changes, update the note instead of removing it.
- If you create a new source file, add the note before imports.

## Workspace Commands
- Install dependencies: `pnpm install`
- Local setup: `pnpm setup:local`
- One-line local bootstrap: `pnpm install:local`
- Start local dev flow: `pnpm dev:local`
- Stop local dev processes: `pnpm stop`
- Run all workspace dev tasks: `pnpm dev`
- Build everything: `pnpm build`
- Lint everything: `pnpm lint`
- Type-check everything: `pnpm typecheck`
- Run all tests: `pnpm test`
- Format repo files: `pnpm format`

## Package Commands
- Backend dev: `pnpm --filter @nextgenchat/backend dev`
- Web dev: `pnpm --filter @nextgenchat/web dev`
- Backend build: `pnpm --filter @nextgenchat/backend build`
- Web build: `pnpm --filter @nextgenchat/web build`
- Types build: `pnpm --filter @nextgenchat/types build`
- Backend lint: `pnpm --filter @nextgenchat/backend lint`
- Web lint: `pnpm --filter @nextgenchat/web lint`
- Types lint: `pnpm --filter @nextgenchat/types lint`
- Backend type-check: `pnpm --filter @nextgenchat/backend typecheck`
- Web type-check: `pnpm --filter @nextgenchat/web typecheck`
- Types type-check: `pnpm --filter @nextgenchat/types typecheck`

## Test Commands
- Run all tests in the monorepo: `pnpm test`
- Run backend tests: `pnpm --filter @nextgenchat/backend test`
- Run backend tests in watch mode: `pnpm --filter @nextgenchat/backend test:watch`
- Run a single backend test file: `pnpm --filter @nextgenchat/backend exec vitest run src/path/to/file.test.ts`
- Run a single backend test by test name: `pnpm --filter @nextgenchat/backend exec vitest run -t "test name"`
- `apps/web` currently has no `test` script; do not invent one in instructions or automation.
- `pnpm test` uses Turborepo, so only packages with a `test` script will execute tests.

## Prisma And Data Commands
- Generate Prisma client: `pnpm --filter @nextgenchat/backend prisma:generate`
- Push local schema to SQLite: `pnpm --filter @nextgenchat/backend prisma:push`
- Run development migrations: `pnpm --filter @nextgenchat/backend prisma:migrate`
- Open Prisma Studio: `pnpm --filter @nextgenchat/backend prisma:studio`
- Validate Prisma schema: `pnpm --filter @nextgenchat/backend prisma:validate`

## Working Style
- Prefer small, targeted changes over broad refactors.
- Inspect neighboring files before editing so new code matches local patterns.
- Check real package scripts before assuming a command exists.
- Do not rewrite unrelated code just to normalize style.
- Preserve user changes you did not make.

## Shared Contracts
- Define new API schemas, DTOs, and socket payloads in `packages/types/src/` first.
- Export both the Zod schema and the inferred TypeScript type from shared contract files.
- Re-export new modules through `packages/types/src/index.ts`.
- In `packages/types`, internal export paths use explicit `.js` extensions.
- After changing shared contracts, run `pnpm --filter @nextgenchat/types build` before typechecking backend or web.
- Do not duplicate contracts in app code.

## TypeScript Rules
- TypeScript is strict; do not bypass with `any` unless unavoidable and justified inline.
- Prefer `z.infer<typeof Schema>` over handwritten duplicate types.
- In `packages/types`, ESLint enforces interface-style type definitions where applicable.
- Use `import type` for type-only imports.
- Match the existing type style in the file unless repo rules require otherwise.

## Imports And Exports
- Match the surrounding file's quote style; the repo is not fully normalized.
- Group imports as external packages, workspace packages, then local modules.
- Keep imports tidy, but avoid churn from reordering unrelated lines.
- In backend code, prefer the `@/` alias for local imports where it is already established.

## Naming Conventions
- Use `PascalCase` for React components, Zod schemas, enums, and TypeScript types.
- Use `camelCase` for variables, functions, object properties, and service methods.
- Use `SCREAMING_SNAKE_CASE` only for real top-level constants.
- Backend feature files follow patterns like `auth.routes.ts`, `auth.service.ts`, and `auth.schema.ts`.
- Keep filenames descriptive and aligned with existing module naming.

## Formatting
- Shared Prettier config enforces semicolons and trailing commas.
- Match existing formatting in files you touch instead of mass-normalizing.
- Prefer concise code over extra helpers unless reuse or clarity clearly improves.
- Add comments only when behavior is not obvious from the code.
- Avoid non-ASCII characters unless the file already uses them and there is a strong reason.

## Backend Guidelines
- Keep route handlers thin; business logic belongs in `*.service.ts`.
- In backend feature modules, `*.schema.ts` should re-export or compose shared schemas rather than redefining them.
- Validate route inputs with Zod schemas imported from `@nextgenchat/types`.
- Put auth middleware on every non-public route.
- Validate Socket.io payloads before processing.
- Apply rate limiting to auth endpoints and message-send flows.
- Never emit ad-hoc socket event names; use shared contracts in `packages/types/src/socket-events.ts`.
- Rooms are named `channel:{channelId}`; namespaces are `/chat` and `/presence`.

## Frontend Guidelines
- Preserve the existing Next.js App Router structure under `apps/web/src/app`.
- Reuse shared schemas and types from `@nextgenchat/types` for forms and API clients.
- Do not assume the Next.js version from memory; check `apps/web/package.json` and `node_modules/next/dist/docs/`.
- Keep desktop and mobile behavior in mind for UI changes.
- Follow existing patterns around React Query, Zustand, React Hook Form, and Socket.io client usage.

## Error Handling And Logging
- Fail fast on invalid configuration; backend env validation belongs in `apps/backend/src/config/env.ts`.
- Throw or return structured errors with stable codes when designing APIs.
- Handle async boundaries explicitly in services, workers, and provider integrations.
- Do not log passwords, tokens, API keys, refresh tokens, or chat message content.
- Log identifiers and operational context instead of sensitive payloads.

## Security Requirements
- Provider credentials must be encrypted at rest and never returned to clients.
- Verify agent ownership before any workspace or file operation.
- Verify upload MIME types server-side and keep storage keys on a safe validated pattern.
- Keep security behavior environment-driven for local vs network modes.
- Do not weaken auth, cookie, or encryption decisions without updating the architecture docs.

## Agent-System Notes
- Agent workspace files live under `$AGENT_WORKSPACES_DIR/{agentId}/`.
- Protected files such as `soul.md`, `identity.md`, `agent.md`, and `pickup.md` are only writable through `AgentCreatorAgent` flows.
- Preserve `stripMessageWrapper()` behavior in `apps/backend/src/queues/agent.processor.ts`; it prevents XML wrapper leakage into saved replies.
- Preserve the routing model in `agent-routing.service.ts`: mode gates, agent-sender guard, then pickup LLM.
- `send_reply` posts intermediate messages in the current channel and should not trigger downstream agents.

## When Unsure
- Choose the option that preserves shared contracts, strict typing, and thin route handlers.
- Prefer consistency with `CLAUDE.md` and `plan.md` over ad hoc local patterns.
- If introducing a new pattern, document it only when the reason would otherwise be unclear.
