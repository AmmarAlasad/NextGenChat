# Heartbeat.md Template

This template represents the heartbeat or cron execution plan for an agent.

It should contain:

- recurring tasks the agent should perform on schedule
- channel context for where heartbeat messages belong
- guardrails for autonomous actions and escalation paths
- expected output format for routine check-ins

Future cron tooling should read from this document when waking an agent on schedule.
