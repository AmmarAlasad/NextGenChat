# Backend Tests

Backend testing uses Vitest + Supertest.

The scaffold currently runs with `--passWithNoTests` so the project can type-check
and build before implementation tests are added.

Planned test areas:

- health check and bootstrap
- auth services and routes
- workspace/channel/message flows
- provider registry and context management
- BullMQ worker orchestration
