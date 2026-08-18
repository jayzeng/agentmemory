# Ecosystem reference slice

This is a deliberately small, executable proof for the architecture in [`../ecosystem.html`](../ecosystem.html). It is **reference code, not a production package**.

It proves one end-to-end path without an LLM or external Slack credentials:

1. Normalize Slack channel messages and thread replies into one valid operational scope.
2. Replay structured correction episodes from two independent sessions.
3. Detect one supported recurring-correction pattern.
4. Validate that every cited evidence reference was exposed to the reviewer.
5. Plan and apply a thread-local decision-retrieval policy with revision checking and idempotency.

```bash
npm run test:ecosystem
```

## Why `conversation` exists

Slack's literal graph is not always `workspace → channel → thread → message`; top-level messages have no thread parent. The reference model introduces an operational `conversation` scope:

- `{ kind: "thread", id: thread_ts }` for a thread reply.
- `{ kind: "channel", id: "channel:" + channel_id }` for a top-level message.

This gives retrieval and authorization one stable path while preserving source IDs. It is an operational projection, not a replacement for Slack's full domain model.

## Intentionally missing

- Real Slack bindings or credentials.
- LLM review; the seam begins at `LearningCandidate`.
- Durable filesystem journal. Production persistence still needs locking, record framing/checksums, fsync policy, crash recovery, retention, and deletion behavior.
- Automatic promotion. The reference applies an `active-under-evaluation` policy conceptually; production must add offline eval, canary, comparison, and revert states.
- General-purpose schema/SDK generation. Hand-author a second app first; compile only proven repetition.
