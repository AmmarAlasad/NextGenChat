# NextGenChat

> A local-first workspace for collaborating with persistent AI agents that have memory, tools, files, and project context.

![License: MIT](https://img.shields.io/badge/license-MIT-green)
![Platform: Linux](https://img.shields.io/badge/platform-Linux-blue)
![Platform: Windows](https://img.shields.io/badge/platform-Windows-blue)
![Platform: macOS](https://img.shields.io/badge/platform-macOS-blue)
![Status: Experimental](https://img.shields.io/badge/status-experimental-orange)
![Local First](https://img.shields.io/badge/local--first-yes-6f42c1)

![NextGenChat repository image](./assets/repo-image.png)

> ⚠️ **Warning**
>
> NextGenChat is powerful software. It can read files, write files, run tools, browse the web, and automate actions depending on how you configure it.
>
> It is **not** a toy, and it is **not** something you should run carelessly on important machines, sensitive accounts, production systems, or environments containing secrets.
>
> If you install, run, modify, or expose this software, you do so **at your own risk**.
>
> You are responsible for how it is configured, what it can access, which tools are enabled, and what consequences follow from using it.

NextGenChat is for people who want AI agents to behave less like disposable chat tabs and more like durable collaborators.

Instead of giving you one long prompt window, it gives you:

- **persistent agents** with identity, memory, and private workspace state
- **project workspaces** with shared files, channels, and task tracking
- **real-time chat** with streamed replies, tool calls, and execution updates
- **operator control** over what agents can do, where they work, and how they are configured

## Why this exists

A lot of current AI tooling breaks down the moment work gets bigger than a single conversation.

You end up juggling:

- multiple agent instances by hand
- lost context across chats
- no durable workspace per agent
- no shared project memory
- no clear way to inspect, interrupt, or coordinate agent work

NextGenChat is an attempt to fix that.

## What makes it different

NextGenChat is built around a simple idea:

**an agent should be a long-lived workspace participant, not just a prompt response.**

That means agents can have:

- their own identity and behavior
- durable memory and markdown-based workspace docs
- tools and execution capabilities
- access to project-level shared context
- tickets and work status inside a project
- operator-visible execution, not hidden black-box behavior

## What you can do with it

### Talk to persistent agents
- direct chat with individual agents
- group chat with multiple agents
- streamed responses and visible progress updates
- stop running agents when needed

![Group chat screenshot](./assets/group-chat.png)

### Give agents real working context
- agent-private workspace docs like identity, memory, and user notes
- project workspaces with shared files and deliverables
- project-aware execution when agents work inside a project channel

![Agent workspace screenshot](./assets/agent-workspace.png)

### Organize work as projects
- create projects and project channels
- upload shared project files
- keep shared specs and artifacts in one place
- manage project tickets through a deck UI

![Project files upload screenshot](./assets/project-files-upload.png)

### Track work with a task deck
- `TODO`
- `ASSIGNED`
- `IN_PROGRESS`
- `DONE`
- `BLOCKED`
- `CANCELLED`

Current workflow supports:
- manual assignment
- auto-claim behavior for matching work
- in-progress ownership by agents
- project-channel completion updates
- drag-and-drop deck movement in the UI

![Project deck screenshot](./assets/project-deck.png)

### Connect different model providers
Currently supported:
- OpenAI
- OpenAI Codex OAuth
- Anthropic
- Kimi
- OpenRouter

You can configure providers globally and choose models per agent.

![Provider settings screenshot](./assets/provider-settings.png)

### Let agents use tools
Built-in capabilities include:
- workspace file read/write/search
- shell execution in the agent workspace
- project file tools
- project ticket tools
- todo/task tools
- web search and web fetch
- skill activation and installation
- scheduling tools
- file send-back into chat
- browser automation via MCP-backed tooling

## Who this is for

NextGenChat is especially interesting if you want one of these:

- a **local-first AI workspace**
- a way to run **multiple persistent agents** without manually juggling separate instances
- a system where agents can work with **shared project files and tickets**
- a more operational, inspectable alternative to “just another AI chat app”
- a foundation for **multi-agent workflows** with stronger operator control

## Quick start

> **Important:** this is powerful software. It can read files, write files, run tools, and automate actions. Start on a machine you control, ideally a non-critical one.

### Install from npm

#### Linux / macOS

```bash
npx @asapr0/nextgenchat@latest install
```

#### Windows

```powershell
npx @asapr0/nextgenchat@latest install
```

### Install from GitHub scripts

#### Linux

```bash
curl -fsSL https://raw.githubusercontent.com/AmmarAlasad/NextGenChat/main/scripts/install.sh | bash
```

#### macOS

```bash
curl -fsSL https://raw.githubusercontent.com/AmmarAlasad/NextGenChat/main/scripts/install-macos.sh | bash
```

#### Windows

```powershell
irm https://raw.githubusercontent.com/AmmarAlasad/NextGenChat/main/scripts/install.ps1 | iex
```

## After install

The CLI is available as both:

- `nextgenchat`
- `ngc`

Useful commands:

```bash
ngc --help
ngc --status
ngc --logs
ngc --stop
ngc --disable
ngc --uninstall
```

On all supported platforms:
- `ngc --stop` stops the app but keeps auto-start enabled
- `ngc --disable` stops it and disables automatic startup
- `ngc --uninstall` removes the service and CLI wiring
- `ngc --uninstall --remove-data` also deletes local runtime data

## Development

```bash
git clone https://github.com/AmmarAlasad/NextGenChat.git
cd NextGenChat
pnpm setup:local
pnpm dev:local
```

Windows native development:

```powershell
git clone https://github.com/AmmarAlasad/NextGenChat.git
cd NextGenChat
pnpm setup:local:win
pnpm dev:local:win
```

macOS local service install from a cloned repo:

```bash
pnpm install:local:macos
```

## Architecture at a glance

### Monorepo layout

```text
apps/
  backend/   Fastify + Socket.io + Prisma + local agent runtime
  web/       Next.js application UI
  mobile/    reserved for future mobile work

packages/
  types/     shared zod schemas and TypeScript contracts
  config/    shared lint/typescript config
```

### Stack

**Frontend**
- Next.js
- React
- TypeScript
- Socket.io client

**Backend**
- Node.js
- Fastify
- Socket.io
- Prisma
- SQLite in local mode

## Safety, risk, and responsibility

NextGenChat is intentionally powerful. That is a feature, but also a risk.

Depending on configuration, it may be able to:
- read and write files
- run shell commands
- browse the web
- automate browser actions
- retain memory and workspace state
- act in shared project contexts

That means misuse, bad configuration, weak boundaries, unsafe prompts, imported malicious content, or simple agent mistakes can cause real damage.

You should assume the following:
- agents can make mistakes
- prompts can be adversarial
- imported files can contain unsafe instructions
- browser automation can perform unintended actions
- shell access can modify or damage local state
- shared project context can affect more than one conversation

### Use at your own risk

By installing, running, modifying, or distributing this software, you accept that you do so **at your own risk**.

The authors and contributors are **not liable** for misuse of the software, operator mistakes, unsafe configuration, prompt injection outcomes, automation mistakes, data loss, damaged files, damaged repositories, account misuse, provider charges, or other harmful outcomes resulting from use or misuse.

You are responsible for:
- how the software is configured and exposed
- which tools and permissions agents receive
- which accounts, files, browsers, and services it can access
- whether your environment is appropriate for autonomous or semi-autonomous execution
- complying with applicable laws, policies, terms, and data-handling obligations

### Recommended safe usage
- start on a machine you control
- prefer a non-critical machine or VM at first
- avoid sensitive accounts and sessions initially
- do not store secrets carelessly in agent or project files
- review enabled tools before trusting an agent with real work
- keep backups before testing powerful autonomous flows
- assume any agent with shell or browser access can make expensive mistakes

### Not recommended
- running this on a critical production workstation without understanding the tool surface
- giving agents access to banking, personal email, cloud admin, or sensitive business systems
- exposing the app publicly without stronger sandboxing and policy controls
- treating autonomous tool use as risk-free
- assuming the software will prevent all misuse or unsafe behavior

## Current status

NextGenChat is already substantial, but it is still **experimental**.

That means:
- the core direction is real
- many important features already exist
- the project is usable and promising
- but it is still being hardened, refined, and expanded

## Roadmap direction

Planned and ongoing areas of improvement include:
- stronger security boundaries
- more isolation and sandboxing
- richer multi-agent collaboration flows
- better production hardening
- better packaging and operator UX
- deeper mobile and multi-user support over time

## If you want to understand it faster

Start here:
- [`docs/architecture.md`](./docs/architecture.md)
- [`architecture.pdf`](./architecture.pdf)
- [`architecture.puml`](./architecture.puml)

## License

NextGenChat is released under the **MIT License**.

See [`LICENSE`](./LICENSE).
