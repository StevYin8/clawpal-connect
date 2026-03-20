import { describe, expect, test } from "vitest";

import type { ForwardedFileRequest } from "../src/backend_client.js";
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
});
