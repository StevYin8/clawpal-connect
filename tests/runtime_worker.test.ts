import { describe, expect, test } from "vitest";

import { BackendClient, type GatewayProbeResult } from "../src/index.js";
import { MockBackendTransport, createMockForwardedRequest } from "../src/mock_backend_transport.js";
import { RuntimeWorker } from "../src/runtime_worker.js";

function isRequestEvent(
  event: Awaited<ReturnType<MockBackendTransport["getSentEvents"]>>[number]
): event is Exclude<Awaited<ReturnType<MockBackendTransport["getSentEvents"]>>[number], { type: "host.status" }> {
  return event.type !== "host.status";
}

describe("RuntimeWorker with backend client + mock transport", () => {
  test("streams message start/delta/done for forwarded requests", async () => {
    const transport = new MockBackendTransport();
    const backendClient = new BackendClient({ transport, now: () => new Date("2026-03-11T00:00:00.000Z") });
    const worker = new RuntimeWorker({
      gatewayProbe: async (): Promise<GatewayProbeResult> => ({
        status: "online",
        ok: true,
        detail: "ok",
        checkedAt: "2026-03-11T00:00:00.000Z",
        endpoint: "http://127.0.0.1:3456/tools/invoke",
        latencyMs: 2,
        httpStatus: 200
      }),
      executeRequest: async function* () {
        yield "hello ";
        yield "relay";
      }
    });

    backendClient.onForwardedRequest(async (request) => {
      await worker.handleForwardedRequest(request, (event) => backendClient.sendEvent(event));
    });

    await backendClient.connect({
      backendUrl: "https://relay.clawpal.example",
      hostId: "host-1",
      userId: "user-1"
    });

    const request = createMockForwardedRequest({
      hostId: "host-1",
      userId: "user-1",
      conversationId: "conv-1",
      requestId: "req-1",
      message: "run"
    });

    await transport.forwardRequest(request);
    await transport.waitForEvent(
      (event) => isRequestEvent(event) && event.requestId === request.requestId && event.type === "message.done"
    );

    const events = transport.getSentEvents().filter((event) => isRequestEvent(event) && event.requestId === request.requestId);
    expect(events.map((event) => event.type)).toEqual([
      "message.start",
      "message.delta",
      "message.delta",
      "message.done"
    ]);

    const done = events.find((event) => event.type === "message.done");
    expect(done && done.type === "message.done" ? done.output : "").toBe("hello relay");

    await backendClient.disconnect();
  });

  test("emits message.error when gateway is offline", async () => {
    const transport = new MockBackendTransport();
    const backendClient = new BackendClient({ transport, now: () => new Date("2026-03-11T00:00:00.000Z") });
    const worker = new RuntimeWorker({
      gatewayProbe: async (): Promise<GatewayProbeResult> => ({
        status: "offline",
        ok: false,
        detail: "connection refused",
        checkedAt: "2026-03-11T00:00:00.000Z",
        endpoint: "http://127.0.0.1:3456/tools/invoke",
        latencyMs: 5
      })
    });

    backendClient.onForwardedRequest(async (request) => {
      await worker.handleForwardedRequest(request, (event) => backendClient.sendEvent(event));
    });

    await backendClient.connect({
      backendUrl: "https://relay.clawpal.example",
      hostId: "host-1",
      userId: "user-1"
    });

    const request = createMockForwardedRequest({
      hostId: "host-1",
      userId: "user-1",
      requestId: "req-offline",
      conversationId: "conv-1",
      message: "run"
    });

    await transport.forwardRequest(request);
    await transport.waitForEvent(
      (event) => isRequestEvent(event) && event.requestId === request.requestId && event.type === "message.error"
    );

    const events = transport.getSentEvents().filter((event) => isRequestEvent(event) && event.requestId === request.requestId);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("message.error");
    if (events[0]?.type === "message.error") {
      expect(events[0].code).toBe("gateway_offline");
    }

    await backendClient.disconnect();
  });
});
