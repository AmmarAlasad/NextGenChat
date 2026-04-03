# NextGenChat

A local-first collaborative platform where humans and AI agents share workspaces, channels, memory, tools, files, and real-time conversations. Starts as a personal local tool and scales to friends and mobile without rewriting the architecture.

## Current Phase: Phase 1 — Working Chat

- Owner setup wizard (first run)
- JWT auth with secure refresh tokens
- One workspace · one channel · one AI agent
- Real-time streaming via Socket.io + BullMQ
- OpenAI provider (gpt-4o-mini by default)

---

## Getting Started (Fresh Install)

### 1. Install prerequisites

```bash
# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# pnpm
npm install -g pnpm
```

> PostgreSQL and Redis are installed automatically by `pnpm setup` if missing.

### 2. Clone and set up

```bash
git clone <repo-url>
cd NextGenChat
cp .env.example .env        # then fill in your OPENAI_API_KEY
pnpm setup                  # installs everything, creates DB, runs migrations
```

### 3. Start

```bash
pnpm dev:phase1
```

Open **http://localhost:3000** — you'll be guided through the first-run setup wizard.

---

## Daily Workflow

```bash
pnpm dev:phase1     # start backend + frontend (auto-starts DB/Redis if needed)
pnpm stop           # stop dev servers
```

---

## All Commands

```bash
# Setup & lifecycle
pnpm setup          # first-time setup (installs deps, DB, migrations)
pnpm dev:phase1     # start the full stack
pnpm stop           # stop dev servers

# Development
pnpm dev            # raw turbo dev (no infra/migration pre-check)
pnpm build          # build all packages
pnpm lint           # lint all packages
pnpm typecheck      # type-check all packages
pnpm test           # run all tests
pnpm format         # prettier write

# Database
pnpm --filter @nextgenchat/backend prisma:migrate    # run migrations
pnpm --filter @nextgenchat/backend prisma:generate   # regenerate Prisma client
pnpm --filter @nextgenchat/backend prisma:studio     # open Prisma Studio GUI
```

---

## URLs

| URL | Service |
|-----|---------|
| http://localhost:3000 | Web frontend |
| http://localhost:3001 | Backend API |
| http://localhost:3001/health | Health check |

---

## Project Guides

| File | Purpose |
|------|---------|
| `plan.md` | Master roadmap, phase breakdown, architecture decisions |
| `CLAUDE.md` | Implementation rules for AI coding assistants |
| `AGENTS.md` | Operating guide for autonomous coding agents |
| `architecture.puml` | System and workflow diagrams |
| `.env.example` | All required environment variables with documentation |
