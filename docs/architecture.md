# Architecture

This document explains how the current `NextGenChat` application behaves in practice.

It is intentionally current-state documentation, not a description of the full future roadmap.

For the long-term phased plan, see [`../plan.md`](../plan.md).

## Design Intent

The project is being built around a persistent-agent model.

That means the system separates:

- conversation state
- durable memory
- workspace docs
- compacted summaries
- provider configuration
- operator controls

Instead of treating the agent as a single prompt string, the app already models the agent as a durable workspace participant with structured state.

## Current Runtime Shape

The app currently runs as a local-first system made of:

- Next.js frontend
- Fastify backend
- Socket.io realtime channel
- SQLite database
- in-process agent execution
- OpenAI provider integration

The operator journey is:

1. first-run setup creates the owner and seeds the initial agent
2. login routes into chat
3. chat sends user messages and receives streamed AI replies
4. the agent workspace page manages the agent's durable markdown docs

## Diagram Set

### System overview

![System overview](./diagrams/system-overview.png)

This is the best high-level picture of the current app.

It shows:

- the browser-based frontend
- the Fastify and Socket.io backend runtime
- the local SQLite persistence layer
- the OpenAI dependency
- the current scope and planned-later boundaries

### Product map

![Product map](./diagrams/product-map.png)

This diagram explains what the operator actually sees:

- setup
- login
- chat
- agent workspace management

It also reflects the seeded single-workspace, single-channel, single-agent local flow the app currently uses.

### Message pipeline

![Message pipeline](./diagrams/message-pipeline.png)

This is the current runtime loop:

1. user sends a message
2. the message is persisted
3. agents are resolved for triggering
4. a local agent job runs in-process
5. context is assembled
6. the provider streams tokens
7. the final agent message is saved and broadcast

### Context model

![Context model](./diagrams/context-model.png)

This is one of the most important parts of the current architecture.

The builder currently follows this order:

1. stable agent docs
2. structured memory
3. latest conversation summary
4. recent messages that fit
5. the trigger message

Compaction is scheduled before hard overflow, but it does not block the current request.

### Domain model

![Domain model](./diagrams/domain-model.png)

The persisted model already separates the important agent concepts:

- `Agent`
- `AgentIdentity`
- `AgentMemory`
- `ConversationSummary`
- `WorkspaceFile`
- `ProviderConfig`

That separation is what makes the later roadmap realistic without rewriting the core model.

## Agent Workspace Semantics

An “agent workspace” already exists conceptually and in storage, but it is intentionally scoped.

Current meaning:

- the agent owns persistent markdown docs
- the admin can edit those docs in a dedicated UI
- those docs are part of the context builder
- structured memory is preserved separately and mirrored into `memory.md`

Not implemented yet:

- arbitrary file browsing
- agent-controlled file mutation
- repo cloning and maintenance
- shell or MCP workspace execution

This is deliberate. The architecture is being expanded in stable layers instead of mixing tools, files, and chat behavior too early.

## Context Management Semantics

The current context system is designed to avoid the classic long-chat failure modes.

### What is already implemented

- token-budget aware assembly
- stable prompt prefix construction
- durable memory loading outside raw chat history
- conversation summary loading
- async compaction scheduling
- message metadata persistence for usage and context stats

### What is scaffolded but not finished

- exact provider-specific token counting
- richer prompt cache controls
- Anthropic cache boundaries
- deeper compaction analytics
- heartbeat-aware autonomous continuation

## Current Boundaries

To keep the implementation clean, the current app intentionally does not yet attempt to solve everything.

Not in the current slice:

- group chat collaboration
- shared group workspaces
- agent tools
- repo maintenance workflows
- heartbeat cron execution
- MCP orchestration

These remain planned layers on top of the current foundation.

## Related Files

| File | Purpose |
|---|---|
| [`../architecture.puml`](../architecture.puml) | source diagram definitions |
| [`../architecture.pdf`](../architecture.pdf) | bundled PDF export |
| [`../plan.md`](../plan.md) | full roadmap and future phases |
| [`../README.md`](../README.md) | project entrypoint |
