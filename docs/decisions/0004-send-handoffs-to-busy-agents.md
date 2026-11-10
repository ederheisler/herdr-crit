# 0004: Send handoffs to busy agents

## Context

A handoff failed because the busy-agent guard rejected the selected agent while it was working.
The user said the existing flow needed a new agent and was "not cool".
The user then said, "i believe you should send and let the agent deal with the queue".

## Decision

Send preparation and feedback handoffs directly to the selected existing agent, even while it is busy.
Use regular `hc send` for a validated live agent in the idle, working, or Done state, without `--if idle`.
The selected agent manages its input queue and scheduling. The mod does not guarantee queue behavior.
Do not wait in the mod, invoke interrupt or force, or require a new agent.
Keep the same agent address, private handoff, and existing liveness, process identity, and ownership validation.
Blocked, error, unknown, or exited agents require manual Retry.
Preserve protection for in-progress or uncertain sends. Do not automatically resend a handoff with an ambiguous outcome.

## Rationale

Follow the user's explicit choice to send while the selected agent is busy and let that agent manage its input.
A wait in the mod or a new-agent requirement does not match that choice.
