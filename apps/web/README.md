# @nextgenchat/web

Next.js App Router scaffold for the NextGenChat web client.

## Current Scope

- Scaffold only: route shells, shared layout, typed client utilities, and project-specific placeholders.
- Source of truth for contracts lives in `packages/types`.
- Backend integration, auth flows, and workspace UI are intentionally left as TODO scaffolds.

## Common Commands

```bash
pnpm --filter @nextgenchat/web dev
pnpm --filter @nextgenchat/web build
pnpm --filter @nextgenchat/web lint
pnpm --filter @nextgenchat/web typecheck
```

## Notes For Agents

- Read `../../plan.md` and `../../architecture.puml` before major frontend changes.
- Check `AGENTS.md` and `CLAUDE.md` in this app before editing framework-specific code.
- Verify Next.js behavior against the installed docs in `node_modules/next/dist/docs/`.
