# AgentMemory product boundary

AgentMemory is free, open-source software under the MIT License. The core is a local Markdown store with a CLI, optional [qmd](https://github.com/tobi/qmd) search, and agent skills. It remains fully usable without an account or commercial plugin.

It does **not**:

- Automatically import every vendor transcript.
- Silently decide what becomes durable — you or your agent choose what to save.
- Ship as a Python SDK, vector database, or knowledge graph.

The Markdown files remain the source of truth. Everything else — search index, dashboard, Pro plugin — is a view on top of files you can `cat`, `diff`, or delete.

## Pro plugin

AgentMemory Pro is a separately distributed commercial bundle that recalls prior coding sessions, finds repeated corrections, and shows what it learned and why in a private local Memory Dashboard.

Pro:

- Sends only a random installation identifier plus bounded compatibility metadata to obtain the signed release.
- Keeps coding history, memories, queries, repository paths, and raw session identifiers out of AgentMemory's services. Recall results are provided locally to the coding agent you invoke and are then subject to that agent or model provider's data handling.
- Lets you preview detected local coding history before install, capped at 50 sessions per local day.
- Includes a free preview: 20 useful recalls and 5 learning scans per local day; local indexing and the Memory Dashboard remain available.
- Requires no account, email, or payment method for the preview.

Paid plans are not available yet. If introduced, they will not unlock access to your own local data; Core and the preview remain independently useful. Low-level `agent-memory plugin` commands remain available for administration and scripting. See [how local privacy, signing, installation, and capability enforcement work](official-plugin-bootstrap.md).
