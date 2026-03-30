import { describe, expect, test } from "vitest";

import type { ForwardedFileRequest } from "../src/backend_client.js";
import type { GatewayCommandRunner } from "../src/gateway_watchdog.js";
import { WsBackendTransport, resolveRelayWsBaseUrl } from "../src/ws_backend_transport.js";

describe("resolveRelayWsBaseUrl", () => {
  test("maps relay HTTP API port 3001 to WS port 8788", () => {
    expect(resolveRelayWsBaseUrl("http://120.55.96.42:3001")).toBe(
      "ws://120.55.96.42:8788",
    );
  });

  test("keeps non-3001 ports while switching protocol", () => {
    expect(resolveRelayWsBaseUrl("https://relay.example:443")).toBe(
      "wss://relay.example",
    );
  });

  test("dispatches relay.forward_file_request payloads to file handlers", () => {
    const transport = new WsBackendTransport();
    let received: ForwardedFileRequest | undefined;
    transport.onForwardedFileRequest((request) => {
      received = request;
    });

    (transport as unknown as { handleRelayMessage: (payload: Record<string, unknown>) => void }).handleRelayMessage({
      type: "relay.forward_file_request",
      request: {
        requestId: "req-file-1",
        hostId: "host-1",
        userId: "user-1",
        operation: "agents.files.get",
        payload: {
          agentId: "main",
          bridgePath: "workspace/SOUL.md"
        },
        createdAt: "2026-03-20T08:00:00.000Z"
      }
    });

    expect(received).toEqual({
      requestId: "req-file-1",
      hostId: "host-1",
      userId: "user-1",
      operation: "agents.files.get",
      payload: {
        agentId: "main",
        bridgePath: "workspace/SOUL.md"
      },
      createdAt: "2026-03-20T08:00:00.000Z"
    });
  });

  test("skips relay.forward_file_request with invalid operation", () => {
    const transport = new WsBackendTransport();
    let callCount = 0;
    transport.onForwardedFileRequest(() => {
      callCount += 1;
    });

    (transport as unknown as { handleRelayMessage: (payload: Record<string, unknown>) => void }).handleRelayMessage({
      type: "relay.forward_file_request",
      request: {
        requestId: "req-file-bad",
        hostId: "host-1",
        userId: "user-1",
        operation: "agents.files.unknown",
        payload: {}
      }
    });

    expect(callCount).toBe(0);
  });

  test("moves to manual attention when gateway ownership is ambiguous", async () => {
    let restartCalls = 0;
    const gatewayCommandRunner: GatewayCommandRunner = {
      async status() {
        return {
          command: "openclaw gateway status",
          args: ["gateway", "status"],
          stdout:
            "Service: LaunchAgent (loaded)\nRuntime: running (pid 456, state active)\n" +
            "Gateway runtime PID does not own the listening port. Other gateway process(es) are listening: 123\n",
          stderr: "",
          exitCode: 0,
          signal: null,
          startedAt: "2026-03-26T01:00:00.000Z",
          completedAt: "2026-03-26T01:00:01.000Z",
          durationMs: 1000,
          runtimeTarget: "gateway"
        };
      },
      async start() {
        throw new Error("not used");
      },
      async stop() {
        throw new Error("not used");
      },
      async restart() {
        restartCalls += 1;
        return {
          command: "openclaw gateway restart",
          args: ["gateway", "restart"],
          stdout: "unexpected",
          stderr: "",
          exitCode: 0,
          signal: null,
          startedAt: "2026-03-26T01:00:00.000Z",
          completedAt: "2026-03-26T01:00:01.000Z",
          durationMs: 1000,
          runtimeTarget: "gateway"
        };
      }
    };
    const transport = new WsBackendTransport({
      gatewayDetector: {
        async detect() {
          return {
            status: "offline",
            ok: false,
            detail: "offline",
            checkedAt: "2026-03-26T01:00:00.000Z",
            endpoint: "http://127.0.0.1:18789/tools/invoke",
            latencyMs: 5
          };
        }
      },
      gatewayCommandRunner
    });

    await (transport as unknown as {
      runRecoveryDiagnosis: (lastConnectError: string) => Promise<void>;
    }).runRecoveryDiagnosis("socket hang up");

    const snapshot = transport.getRecoverySnapshot();
    expect(restartCalls).toBe(0);
    expect(snapshot.phase).toBe("manual_attention");
    expect(snapshot.status).toBe("manual_attention");
    expect(snapshot.recentRecoveryAttempts[0]?.classification).toBe("gateway_unhealthy_unresolved");
    expect(snapshot.recentRecoveryAttempts[0]?.detail).toContain("Ambiguous OpenClaw runtime state detected");
  });

  test("moves pairing-required failures to manual attention without auto-approval", async () => {
    const transport = new WsBackendTransport();

    await (transport as unknown as {
      runRecoveryDiagnosis: (lastConnectError: string) => Promise<void>;
    }).runRecoveryDiagnosis("Connection closed during handshake (code=1008): pairing required");

    const snapshot = transport.getRecoverySnapshot();
    expect(snapshot.status).toBe("manual_attention");
    expect(snapshot.phase).toBe("manual_attention");
    expect(snapshot.recentRecoveryAttempts[0]?.classification).toBe("pairing_required_unresolved");
    expect(snapshot.recentRecoveryAttempts[0]?.detail).toContain("Automatic recovery is blocked");
  });

  test("suppresses reconnect scheduling after pairing-required failures", () => {
    const transport = new WsBackendTransport();
    (transport as unknown as { context: { backendUrl: string; hostId: string; userId: string } | null }).context = {
      backendUrl: "http://120.55.96.42:3001",
      hostId: "host-1",
      userId: "user-1"
    };
    (transport as unknown as { recordConnectFailure: (detail: string) => void }).recordConnectFailure(
      "Connection closed during handshake (code=1008): pairing required"
    );
    (transport as unknown as { scheduleReconnect: () => void }).scheduleReconnect();

    const snapshot = transport.getRecoverySnapshot();
    expect(snapshot.status).toBe("manual_attention");
    expect(snapshot.phase).toBe("manual_attention");
    expect((transport as unknown as { reconnectTimer: NodeJS.Timeout | null }).reconnectTimer).toBeNull();
  });
});
