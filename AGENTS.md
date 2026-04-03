# AGENTS.md

This file is the operating guide for coding agents working in `NextGenChat`.

## Project Snapshot

- Monorepo managed with `pnpm` workspaces and `turbo`.
- Apps live in `apps/`; shared packages live in `packages/`.
- Backend: Fastify + Socket.io + BullMQ + Prisma + TypeScript.
- Web: Next.js App Router + React + TypeScript.
- Shared contracts: `packages/types` with Zod schemas and inferred types.
- Current status: active planning / early development; read `plan.md` before major work.

## Locked Architecture Rules

- Use Fastify, not Express.
- Use Socket.io, not raw WebSockets.
- Use BullMQ for agent / LLM work; do not call LLMs inline in request handlers.
- Use Prisma for DB access; avoid raw SQL except approved full-text cases.
- Use Argon2id for password hashing.
- Keep refresh tokens in secure `httpOnly` cookies; never use `localStorage`.
- Treat `packages/types` as the single source of truth for API and socket contracts.
- Respect `DEPLOYMENT_MODE`; do not hardcode local/network behavior.

## Commands

### Workspace commands

- Install deps: `pnpm install`
- Run all dev tasks: `pnpm dev`
- Build all packages: `pnpm build`
- Lint all packages: `pnpm lint`
- Type-check all packages: `pnpm typecheck`
- Run all tests: `pnpm test`
- Format repo files: `pnpm format`

### Filtered workspace commands

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

### Tests

- Backend tests: `pnpm --filter @nextgenchat/backend test`
- Backend watch mode: `pnpm --filter @nextgenchat/backend test:watch`
- Single backend test file: `pnpm --filter @nextgenchat/backend test path/to/file.test.ts`
- Direct Vitest single file: `pnpm --filter @nextgenchat/backend exec vitest run src/modules/auth/auth.service.test.ts`
- Single backend test by name: `pnpm --filter @nextgenchat/backend exec vitest run -t "test name"`
- Current state: `apps/web` has no `test` script yet; do not invent one in instructions or automation.

### Database / Prisma

- Generate Prisma client: `pnpm --filter @nextgenchat/backend prisma:generate`
- Run Prisma migrations: `pnpm --filter @nextgenchat/backend prisma:migrate`
- Open Prisma Studio: `pnpm --filter @nextgenchat/backend prisma:studio`

## How Agents Should Work Here

- Read `plan.md` and `CLAUDE.md` before substantial design or architecture changes.
- Prefer small, targeted edits that match existing patterns.
- Check package scripts before assuming a command exists.
- If you add an endpoint, socket event, or shared DTO, update `packages/types` first.
- Keep backend route handlers thin; business logic belongs in `*.service.ts`.
- Re-export shared schemas from backend `*.schema.ts` files instead of redefining them.

## TypeScript and Types

- The repo uses `strict` TypeScript; do not bypass with `any` unless unavoidable and documented.
- Prefer inferred types from Zod via `z.infer<typeof Schema>`.
- Export both the Zod schema and inferred type from shared contract files.
- Do not duplicate request/response or socket payload types in backend/web code.
- In backend apps, use the `@/*` path alias for local source imports when appropriate.
- In `packages/types`, export through `src/index.ts` so consumers use the package entrypoint.

## Imports and Exports

- Follow existing file conventions for quote style instead of mass-normalizing files.
- Keep imports grouped logically: external packages, workspace packages, then local modules.
- Use `import type` for type-only imports when writing new code.
- In `packages/types`, internal re-exports use explicit `.js` extensions in export paths.
- Prefer named exports for schemas, services, constants, and helper types.

## Naming Conventions

- Use `PascalCase` for Zod schemas, enums, React components, and TypeScript types.
- Use `camelCase` for variables, functions, service methods, and object properties.
- Use `SCREAMING_SNAKE_CASE` for top-level constants only when they are true constants.
- Route/module filenames follow feature naming like `auth.routes.ts`, `auth.service.ts`, `auth.schema.ts`.
- Keep feature modules colocated under `apps/backend/src/modules/<feature>/`.

## Formatting and File Style

- Match the surrounding file's formatting exactly; this repo currently has mixed quote styles.
- Preserve semicolon usage when present.
- Prefer concise files and descriptive names over long inline comments.
- Only add comments when they clarify non-obvious behavior or document constraints.
- Avoid non-ASCII characters unless the file already uses them and there is a real need.
- Preserve the top-of-file scaffold notes already present in repo files; update them when behavior changes, but do not delete or replace them with shorter generic comments.

## Backend Rules

- Validate all route inputs with Zod schemas imported from `@nextgenchat/types`.
- Put auth middleware on every non-public route.
- Apply rate limiting to auth endpoints and message-send flows.
- Validate Socket.io payloads before processing.
- Never emit ad-hoc socket event names; use the shared contracts in `packages/types/src/socket-events.ts`.
- Rooms are named `channel:{channelId}`; namespaces are `/chat` and `/presence`.
- Agent responses must go through the normal message pipeline with `senderType: 'AGENT'`.
- For agent-triggered work: save message, enqueue BullMQ job, build context, save response, broadcast, then update memory.

## Frontend Rules

- Preserve the existing Next.js App Router structure under `apps/web/src/app`.
- Respect strict TypeScript and Next.js linting.
- Reuse shared schemas/types from `@nextgenchat/types` for forms and API clients.
- Do not assume old Next.js APIs are still correct; verify against the installed Next.js version when changing framework-specific code.
- Keep desktop and mobile behavior in mind for any UI work.

## Error Handling and Logging

- Fail fast on invalid configuration; backend env validation belongs in `src/config/env.ts`.
- Throw or return structured errors with stable codes when designing new APIs.
- Do not log passwords, tokens, API keys, refresh tokens, or chat message content.
- Log identifiers and operational context instead of sensitive payloads.
- Handle async boundaries explicitly in services, queue workers, and provider integrations.

## Security Requirements

- Provider credentials must be encrypted at rest and never returned to clients.
- Verify agent ownership before any workspace or file operation.
- Verify upload MIME types server-side and keep storage keys on a safe validated pattern.
- Keep local-vs-network security behavior environment-driven.
- Never weaken auth, cookie, or encryption decisions without updating the architecture docs.

## Existing Agent-Specific Rules Found In Repo

- `apps/web/AGENTS.md` contains a Next.js-specific warning: this version may differ from your training data; read the relevant docs in `node_modules/next/dist/docs/` before changing framework code and heed deprecations.
- No `.cursorrules` file was found.
- No `.cursor/rules/` directory was found.
- No `.github/copilot-instructions.md` file was found.

## Practical Guidance For Changes

- Before editing, inspect neighboring files for style and architecture patterns.
- Before running tests, confirm the target package actually defines the script you plan to use.
- When adding new shared contracts, update consumers in backend and web in the same change.
- Prefer additive changes over broad refactors in this early-stage codebase.
- If a file is mostly a TODO stub, keep new code aligned with the documented intent in its header comment.
- If you create a new scaffold file, add a top note describing its purpose, planned responsibilities, and future implementation boundaries.

## When Unsure

- Choose the option that preserves shared contracts, strict typing, and thin route handlers.
- Prefer consistency with `plan.md` and `CLAUDE.md` over ad hoc local patterns.
- If introducing a new pattern, document it in code only when the reason is not obvious.
