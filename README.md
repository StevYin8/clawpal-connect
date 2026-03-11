# clawpal-connect (hosted relay connector, MVP v0.2.0)

`clawpal-connect` is the standalone host-side connector for **ClawPal official hosted relay mode**.

This repo is intentionally aligned to the current mainline docs (2026-03-11):
- App connects to official backend.
- Connector connects outbound to official backend.
- Backend forwards requests to connector and receives streamed responses.

Direct/pairing-first flows are not the primary story here.

## Positioning

`clawpal-connect` is the user host connector, not the App UI and not the full official backend service.

It is responsible for:
- probing local OpenClaw gateway availability.
- managing local host binding metadata.
- maintaining connector lifecycle (connect, heartbeat, request handling).
- receiving backend-forwarded requests and returning streamed events.

It is not responsible for:
- ClawPal App UI.
- official account/auth domain model.
- production backend transport implementation in this repo.

## Current MVP capabilities

- `gateway_detector`: probes local OpenClaw gateway via `POST /tools/invoke` + `session_status`.
- `host_registry`: local host binding persistence (`~/.clawpal-connect/host-registry.json`).
- `backend_client`: connector-side abstraction over backend transport and event emission.
- `mock_backend_transport`: local mock transport for relay-flow demo/testing.
- `runtime_worker`: handles forwarded requests and emits streamed `message.*` events.
- `heartbeat_manager`: periodic `host.status` events.
- `connector_runtime`: orchestration of registry + backend + worker + heartbeat.
- `clawpal-connect` CLI lifecycle commands: `status`, `bind`, `start`, `demo`.
- local web UI retained only for diagnostics (`start --web-ui`).

## Install

Requirements:
- Node.js 20+
- npm 10+

```bash
npm install
```

## CLI usage

Check local gateway and host binding status:

```bash
npm run status -- --gateway http://127.0.0.1:3456 --token "$OPENCLAW_GATEWAY_TOKEN"
```

Bind connector host metadata locally:

```bash
npm run bind -- \
  --host-id my-host \
  --host-name "My Mac" \
  --user-id user-123 \
  --backend-url https://relay.clawpal.example
```

Start connector lifecycle loop (mock transport, optional diagnostics UI):

```bash
npm run start:dev -- --web-ui
```

Run end-to-end local relay demo (forwarded request -> streamed result):

```bash
npm run demo -- --message "hello from app"
```

`demo` intentionally uses mock transport + mock runtime execution and bypasses real gateway availability checks so relay event flow can be validated locally.

## Event model

The mock relay flow emits backend-style events:
- `host.status`
- `message.start`
- `message.delta`
- `message.done`
- `message.error`

## Architecture

```text
src/
  cli.ts
  gateway_detector.ts
  host_registry.ts
  backend_client.ts
  mock_backend_transport.ts
  runtime_worker.ts
  heartbeat_manager.ts
  connector_runtime.ts
  web/
    local_web_ui.ts
tests/
  *.test.ts
```

## Explicit TODO boundaries (official backend)

This repository does **not** claim production backend readiness.

Still TODO for the official backend integration:
- real long-connection transport adapter (WebSocket/gRPC/SSE contract with official backend).
- official bind/login/token issuance flow and secure token refresh.
- production-grade reconnect policy and retry backoff strategy.
- secure secret storage (current local registry is plain JSON for MVP scaffolding).
- real OpenClaw streaming bridge (runtime worker currently uses a mock executor for demo).

## Test

```bash
npm test
```
