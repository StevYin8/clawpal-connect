import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, test } from "vitest";

import { BackendClient, type GatewayProbeResult } from "../src/index.js";
import { MockBackendTransport, createMockForwardedRequest } from "../src/mock_backend_transport.js";
import { createOpenClawRequestExecutor, RuntimeWorker } from "../src/runtime_worker.js";

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

describe("createOpenClawRequestExecutor", () => {
  test("streams OpenResponses SSE deltas", async () => {
    const executor = createOpenClawRequestExecutor({
      gatewayUrl: "http://127.0.0.1:18789",
      fetchImpl: async () =>
        new Response(
          [
            "event: response.created",
            "data: {\"type\":\"response.created\"}",
            "",
            "event: response.output_text.delta",
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello \"}",
            "",
            "event: response.output_text.delta",
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"openclaw\"}",
            "",
            "data: [DONE]",
            ""
          ].join("\n"),
          {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream"
            }
          }
        ),
      spawnImpl: () => {
        throw new Error("fallback should not run for SSE success");
      }
    });

    const request = createMockForwardedRequest({
      hostId: "host-1",
      userId: "user-1",
      agentId: "agent-a",
      conversationId: "conv-1",
      requestId: "req-sse",
      message: "test"
    });

    const chunks: string[] = [];
    for await (const chunk of executor(request)) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["hello ", "openclaw"]);
  });

  test("falls back to OpenClaw gateway RPC when OpenResponses endpoint is unavailable", async () => {
    let command = "";
    let args: string[] = [];
    const executor = createOpenClawRequestExecutor({
      gatewayUrl: "http://127.0.0.1:19001",
      gatewayToken: "token-123",
      openClawBinary: "openclaw-custom",
      fetchImpl: async () =>
        new Response("Not Found", {
          status: 404,
          headers: {
            "Content-Type": "text/plain"
          }
        }),
      spawnImpl: (nextCommand, nextArgs) => {
        command = nextCommand;
        args = [...nextArgs];

        const child = new EventEmitter() as ChildProcessWithoutNullStreams;
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        (child as unknown as { stdout: PassThrough }).stdout = stdout;
        (child as unknown as { stderr: PassThrough }).stderr = stderr;

        process.nextTick(() => {
          stdout.write(
            JSON.stringify({
              runId: "req-fallback",
              status: "ok",
              result: {
                payloads: [{ text: "fallback output" }]
              }
            })
          );
          stdout.end();
          stderr.end();
          child.emit("close", 0, null);
        });

        return child;
      }
    });

    const request = createMockForwardedRequest({
      hostId: "host-1",
      userId: "user-1",
      agentId: "agent-a",
      conversationId: "conv-1",
      requestId: "req-fallback",
      message: "fallback test"
    });

    const chunks: string[] = [];
    for await (const chunk of executor(request)) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["fallback output"]);
    expect(command).toBe("openclaw-custom");
    expect(args).toContain("gateway");
    expect(args).toContain("call");
    expect(args).toContain("agent");
    expect(args).toContain("--expect-final");
    expect(args).toContain("--json");
    expect(args).toContain("--token");
    expect(args).toContain("token-123");
    expect(args).toContain("--url");
    expect(args).toContain("ws://127.0.0.1:19001");

    const paramsIndex = args.indexOf("--params");
    const rawParams = paramsIndex >= 0 ? args[paramsIndex + 1] : undefined;
    expect(rawParams).toBeTruthy();
    const parsedParams = JSON.parse(rawParams ?? "{}") as Record<string, unknown>;
    expect(parsedParams.idempotencyKey).toBe("req-fallback");
    expect(parsedParams.sessionKey).toBe("relay:host-1:user-1:conv-1");
    expect(parsedParams.agentId).toBe("agent-a");
  });
});
