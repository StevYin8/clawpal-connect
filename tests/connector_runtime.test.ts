import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { BackendClient, ConnectorRuntime, GatewayDetector, HeartbeatManager, HostRegistry, RuntimeWorker } from "../src/index.js";
import { createMockForwardedRequest, MockBackendTransport } from "../src/mock_backend_transport.js";
import type { GatewayProbeResult } from "../src/gateway_detector.js";
import type { HeartbeatStartOptions } from "../src/heartbeat_manager.js";

class RecordingHeartbeatManager extends HeartbeatManager {
  lastStartOptions: HeartbeatStartOptions | undefined;

  override start(options: HeartbeatStartOptions): () => void {
    this.lastStartOptions = options;
    return () => {};
  }
}

async function waitForCondition(
  predicate: () => boolean,
  options: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 1_500;
  const intervalMs = options.intervalMs ?? 10;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }

  throw new Error(`Timed out waiting for condition after ${timeoutMs}ms.`);
}

describe("ConnectorRuntime", () => {
  test("wires synced agent runtime status providers and updates request activity", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "clawpal-connector-runtime-"));
    const registryPath = join(tempDir, "host-registry.json");
    const registry = new HostRegistry({ filePath: registryPath });
    await registry.bindHost({
      hostId: "host-1",
      userId: "user-1",
      hostName: "Host 1",
      backendUrl: "https://relay.example"
    });

    const transport = new MockBackendTransport();
    const backendClient = new BackendClient({ transport });
    const gatewayDetector = new GatewayDetector({
      baseUrl: "http://127.0.0.1:18789",
      fetchImpl: async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
    });

    let releaseExecution: (() => void) | undefined;
    const executionGate = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    const runtimeWorker = new RuntimeWorker({
      gatewayProbe: async (): Promise<GatewayProbeResult> => ({
        status: "online",
        ok: true,
        detail: "ok",
        checkedAt: "2026-03-18T00:00:00.000Z",
        endpoint: "demo://gateway",
        latencyMs: 0
      }),
      executeRequest: async function* () {
        await executionGate;
        yield "done";
      }
    });

    const heartbeatManager = new RecordingHeartbeatManager();
    const runtime = new ConnectorRuntime({
      hostRegistry: registry,
      gatewayDetector,
      backendClient,
      runtimeWorker,
      heartbeatManager,
      syncedAgentIdProvider: async () => ["agent-a", "agent-b"]
    });

    let running: Awaited<ReturnType<ConnectorRuntime["start"]>> | undefined;
    try {
      running = await runtime.start();

      const startOptions = heartbeatManager.lastStartOptions;
      expect(startOptions).toBeDefined();

      const providers = startOptions?.agentStatusProviders ?? [];
      expect(providers.map((provider) => provider.agentId)).toEqual(["agent-a", "agent-b"]);
      expect(providers.every((provider) => provider.displayStatus === "idle")).toBe(true);

      const request = createMockForwardedRequest({
        hostId: "host-1",
        userId: "user-1",
        requestId: "req-1",
        conversationId: "conv-1",
        message: "Summarize logs for March incident"
      });
      const forwardPromise = transport.forwardRequest(request);

      await waitForCondition(() => providers.every((provider) => provider.displayStatus === "working"));
      expect(providers[0]?.currentWorkTitle).toContain("Summarize logs for March incident");
      expect(providers[0]?.currentWorkSummary).toContain("Summarize logs for March incident");

      releaseExecution?.();
      await forwardPromise;

      await waitForCondition(() => providers.every((provider) => provider.displayStatus === "idle"));
      expect(providers[0]?.currentWorkTitle).toBeUndefined();
      expect(providers[0]?.currentWorkSummary).toBeUndefined();
    } finally {
      releaseExecution?.();
      await running?.stop();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
