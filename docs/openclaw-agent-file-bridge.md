# OpenClaw Agent File Bridge (Connector-Side)

This repository now includes a connector-local filesystem bridge in `src/openclaw_agent_file_bridge.ts`.

## Bridged Local OpenClaw Files

The bridge reads/writes the local OpenClaw source-of-truth files directly on disk:

- Config
  - `~/.openclaw/openclaw.json` as `config/openclaw.json`
- Workspace personality/identity/memory files (resolved per `agentId`)
  - `workspace/AGENTS.md`
  - `workspace/SOUL.md`
  - `workspace/IDENTITY.md`
  - `workspace/USER.md`
  - `workspace/MEMORY.md` and `workspace/memory.md`
  - `workspace/memory/**/*.md`
- Skills
  - `workspace/skills/<skill>/SKILL.md`
  - `workspace/skills/<skill>/{manifest.json,metadata.json,_meta.json,config.json}`
  - `workspace/skills/<skill>/config/*.{json,yaml,yml,toml}`
  - `shared-skills/<skill>/...` mapped to `~/.openclaw/skills/<skill>/...`

## Connector Primitives Added

- `listAgentFiles({ agentId? })`
- `readAgentFile({ agentId?, bridgePath })`
- `writeAgentFile({ agentId?, bridgePath, content, expectedRevision? })`

Design notes:

- Agent workspace resolution follows OpenClaw conventions:
  - `agents.list[].workspace`
  - fallback to `agents.defaults.workspace` for default agent
  - fallback to `~/.openclaw/workspace-<agentId>` for non-default agents
- Writes are atomic (`tmp` + `rename`).
- Optional optimistic concurrency via `expectedRevision` (sha256).
- Path allowlist + root-boundary checks reject traversal and symlink escapes.

## Pending Relay/App Wiring

The chat bridge path remains unchanged. File bridge wiring is intentionally not yet connected to relay messages.

Next wiring points:

1. Add relay/app request envelopes for `agents.files.list`, `agents.files.get`, `agents.files.set`.
2. Decode those envelopes in `src/ws_backend_transport.ts` and dispatch them through connector runtime listeners.
3. Add connector dispatch in `src/backend_client.ts` + `src/connector_runtime.ts` to route file requests to `OpenClawAgentFileBridgeService` (separate from `RuntimeWorker` chat execution).
4. Define response/error envelopes and map conflict/not-found/validation failures.
