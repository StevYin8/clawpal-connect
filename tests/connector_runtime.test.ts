import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import {
  BackendClient,
  ConnectorRuntime,
  GatewayDetector,
  type GatewayWatchdogLifecycle,
  type GatewayWatchdogSnapshot,
  HeartbeatManager,
  HostRegistry,
  OpenClawAgentFileRevisionConflictError,
  RuntimeWorker
} from "../src/index.js";
import {
  createMockForwardedFileRequest,
  createMockHostUnbindControl,
  createMockForwardedRequest,
  createMockGatewayRestartControl,
  createMockHostUnbindControl,
  MockBackendTransport
} from "../src/mock_backend_transport.js";
import type { GatewayProbeResult } from "../src/gateway_detector.js";
import type { GatewayCommandRunner } from "../src/gateway_watchdog.js";
import type { HeartbeatStartOptions } from "../src/heartbeat_manager.js";
import type { OpenClawAgentActivity, SessionActivityMonitor } from "../src/openclaw_session_activity_monitor.js";

class RecordingHeartbeatManager extends HeartbeatManager {
  lastStartOptions: HeartbeatStartOptions | undefined;

  override start(options: HeartbeatStartOptions): () => void {
    this.lastStartOptions = options;
    return () => {};
  }
}

class ControlledSessionActivityMonitor implements SessionActivityMonitor {
  private onUpdate: ((activities: OpenClawAgentActivity[]) => void) | undefined;
  private current: OpenClawAgentActivity[];

  constructor(initialActivities: OpenClawAgentActivity[] = []) {
    this.current = initialActivities;
  }

  async refresh(): Promise<OpenClawAgentActivity[]> {
    return this.current;
  }

  start(onUpdate: (activities: OpenClawAgentActivity[]) => void): () => void {
    this.onUpdate = onUpdate;
    return () => {
      this.onUpdate = undefined;
    };
  }

  emit(activities: OpenClawAgentActivity[]): void {
    this.current = activities;
    this.onUpdate?.(activities);
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
        agentId: "agent-a",
        requestId: "req-1",
        conversationId: "conv-1",
        message: "Summarize logs for March incident"
      });
      const forwardPromise = transport.forwardRequest(request);

      await waitForCondition(() => providers[0]?.displayStatus === "working");
      expect(providers[0]?.currentWorkTitle).toContain("Summarize logs for March incident");
      expect(providers[0]?.currentWorkSummary).toContain("Summarize logs for March incident");
      expect(providers[1]?.displayStatus).toBe("idle");

      releaseExecution?.();
      await forwardPromise;

      await waitForCondition(() => providers.every((provider) => provider.displayStatus === "idle"));
      expect(providers[0]?.currentWorkTitle).toBeUndefined();
      expect(providers[0]?.currentWorkSummary).toBeUndefined();
      expect(providers[1]?.currentWorkTitle).toBeUndefined();
      expect(providers[1]?.currentWorkSummary).toBeUndefined();
    } finally {
      releaseExecution?.();
      await running?.stop();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("applies local OpenClaw session activity and updates heartbeat status provider", async () => {
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

    const sessionActivityMonitor = new ControlledSessionActivityMonitor([
      {
        agentId: "agent-a",
        isActive: true,
        signal: "lock",
        title: "Cron 任务执行中",
        summary: "Cron 任务执行中"
      }
    ]);

    const heartbeatManager = new RecordingHeartbeatManager();
    const runtime = new ConnectorRuntime({
      hostRegistry: registry,
      gatewayDetector,
      backendClient,
      heartbeatManager,
      syncedAgentIdProvider: async () => ["agent-a"],
      sessionActivityMonitorFactory: () => sessionActivityMonitor
    });

    let running: Awaited<ReturnType<ConnectorRuntime["start"]>> | undefined;
    try {
      running = await runtime.start();

      const startOptions = heartbeatManager.lastStartOptions;
      expect(startOptions).toBeDefined();
      expect(startOptions?.statusProvider?.()).toBe("busy");

      const provider = startOptions?.agentStatusProviders?.[0];
      expect(provider?.displayStatus).toBe("working");
      expect(provider?.currentWorkTitle).toBe("Cron 任务执行中");
      expect(provider?.currentWorkSummary).toBe("Cron 任务执行中");

      sessionActivityMonitor.emit([
        {
          agentId: "agent-a",
          isActive: false,
          signal: "inactive"
        }
      ]);

      await waitForCondition(() => provider?.displayStatus === "idle");
      expect(startOptions?.statusProvider?.()).toBe("online");
      expect(provider?.currentWorkTitle).toBeUndefined();
      expect(provider?.currentWorkSummary).toBeUndefined();
    } finally {
      await running?.stop();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("routes forwarded file requests through file bridge service and emits agents.files.response", async () => {
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

    let runtimeWorkerCalls = 0;
    const runtimeWorker = new RuntimeWorker({
      gatewayProbe: async (): Promise<GatewayProbeResult> => ({
        status: "online",
        ok: true,
        detail: "ok",
        checkedAt: "2026-03-20T00:00:00.000Z",
        endpoint: "demo://gateway",
        latencyMs: 0
      }),
      executeRequest: async function* () {
        runtimeWorkerCalls += 1;
        yield "chat path";
      }
    });

    const fileBridgeService = {
      async listAgentFiles(_options: { agentId?: string }) {
        return {
          agentId: "main",
          stateDir: "/tmp/.openclaw",
          configPath: "/tmp/.openclaw/openclaw.json",
          workspaceDir: "/tmp/.openclaw/workspace",
          files: []
        };
      },
      async readAgentFile(input: { agentId?: string; bridgePath: string }) {
        return {
          file: {
            bridgePath: input.bridgePath,
            absolutePath: `/tmp/.openclaw/workspace/${input.bridgePath}`,
            domain: "workspace",
            category: "soul",
            exists: true,
            writable: true
          },
          content: "# Soul",
          revision: "rev-1"
        };
      },
      async writeAgentFile(input: { agentId?: string; bridgePath: string; content: string }) {
        return {
          file: {
            bridgePath: input.bridgePath,
            absolutePath: `/tmp/.openclaw/workspace/${input.bridgePath}`,
            domain: "workspace",
            category: "soul",
            exists: true,
            writable: true
          },
          revision: `rev-${input.content.length}`
        };
      }
    };

    const runtime = new ConnectorRuntime({
      hostRegistry: registry,
      gatewayDetector,
      backendClient,
      runtimeWorker,
      fileBridgeService
    });

    let running: Awaited<ReturnType<ConnectorRuntime["start"]>> | undefined;
    try {
      running = await runtime.start();

      await transport.forwardFileRequest(
        createMockForwardedFileRequest({
          hostId: "host-1",
          userId: "user-1",
          requestId: "req-file-1",
          operation: "agents.files.get",
          payload: {
            agentId: "main",
            bridgePath: "workspace/SOUL.md"
          }
        })
      );

      await waitForCondition(() =>
        transport
          .getSentEvents()
          .some((event) => event.type === "agents.files.response" && event.requestId === "req-file-1")
      );

      const response = transport
        .getSentEvents()
        .find((event) => event.type === "agents.files.response" && event.requestId === "req-file-1");
      expect(response?.type).toBe("agents.files.response");
      if (response?.type === "agents.files.response") {
        expect(response.operation).toBe("agents.files.get");
        expect(response.ok).toBe(true);
        if (response.ok) {
          expect(response.result).toEqual({
            file: {
              bridgePath: "workspace/SOUL.md",
              absolutePath: "/tmp/.openclaw/workspace/workspace/SOUL.md",
              domain: "workspace",
              category: "soul",
              exists: true,
              writable: true
            },
            content: "# Soul",
            revision: "rev-1"
          });
        }
      }

      expect(runtimeWorkerCalls).toBe(0);
    } finally {
      await running?.stop();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("maps file bridge revision conflicts to agents.files.response conflict errors", async () => {
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

    const fileBridgeService = {
      async listAgentFiles(_options: { agentId?: string }) {
        return {
          agentId: "main",
          stateDir: "/tmp/.openclaw",
          configPath: "/tmp/.openclaw/openclaw.json",
          workspaceDir: "/tmp/.openclaw/workspace",
          files: []
        };
      },
      async readAgentFile(input: { agentId?: string; bridgePath: string }) {
        return {
          file: {
            bridgePath: input.bridgePath,
            absolutePath: `/tmp/.openclaw/workspace/${input.bridgePath}`,
            domain: "workspace",
            category: "memory",
            exists: true,
            writable: true
          },
          content: "seed",
          revision: "rev-seed"
        };
      },
      async writeAgentFile(_input: { agentId?: string; bridgePath: string; content: string; expectedRevision?: string }) {
        throw new OpenClawAgentFileRevisionConflictError({
          bridgePath: "workspace/MEMORY.md",
          expectedRevision: "rev-old",
          actualRevision: "rev-new"
        });
      }
    };

    const runtime = new ConnectorRuntime({
      hostRegistry: registry,
      gatewayDetector,
      backendClient,
      fileBridgeService
    });

    let running: Awaited<ReturnType<ConnectorRuntime["start"]>> | undefined;
    try {
      running = await runtime.start();

      await transport.forwardFileRequest(
        createMockForwardedFileRequest({
          hostId: "host-1",
          userId: "user-1",
          requestId: "req-file-conflict",
          operation: "agents.files.set",
          payload: {
            agentId: "main",
            bridgePath: "workspace/MEMORY.md",
            content: "v2",
            expectedRevision: "rev-old"
          }
        })
      );

      await waitForCondition(() =>
        transport
          .getSentEvents()
          .some((event) => event.type === "agents.files.response" && event.requestId === "req-file-conflict")
      );

      const response = transport
        .getSentEvents()
        .find((event) => event.type === "agents.files.response" && event.requestId === "req-file-conflict");
      expect(response?.type).toBe("agents.files.response");
      if (response?.type === "agents.files.response") {
        expect(response.operation).toBe("agents.files.set");
        expect(response.ok).toBe(false);
        if (!response.ok) {
          expect(response.error.code).toBe("conflict");
          expect(response.error.details).toEqual({
            bridgePath: "workspace/MEMORY.md",
            expectedRevision: "rev-old",
            actualRevision: "rev-new"
          });
        }
      }
    } finally {
      await running?.stop();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("unbinds active host and disconnects when relay sends host unbind control", async () => {
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
    const runtime = new ConnectorRuntime({
      hostRegistry: registry,
      gatewayDetector,
      backendClient
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let running: Awaited<ReturnType<ConnectorRuntime["start"]>> | undefined;
    try {
      running = await runtime.start();
      expect(transport.isConnected()).toBe(true);

      await transport.forwardHostUnbind(
        createMockHostUnbindControl({
          hostId: "host-1",
          userId: "user-1",
          reason: "host_deleted",
          requestedAt: "2026-03-30T10:00:00.000Z"
        })
      );

      await waitForCondition(() => !transport.isConnected());

      const state = await registry.loadState();
      expect(state.activeHostId).toBeNull();
      expect(state.hosts["host-1"]).toBeUndefined();
      expect(
        logSpy.mock.calls.some((call) => call.some((arg) => String(arg).includes("was unbound remotely")))
      ).toBe(true);
    } finally {
      await running?.stop();
      logSpy.mockRestore();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("ignores host unbind controls for other hosts", async () => {
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
    const runtime = new ConnectorRuntime({
      hostRegistry: registry,
      gatewayDetector,
      backendClient
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let running: Awaited<ReturnType<ConnectorRuntime["start"]>> | undefined;
    try {
      running = await runtime.start();
      expect(transport.isConnected()).toBe(true);

      await transport.forwardHostUnbind(
        createMockHostUnbindControl({
          hostId: "host-other",
          requestedAt: "2026-03-30T10:05:00.000Z"
        })
      );

      expect(transport.isConnected()).toBe(true);
      const state = await registry.loadState();
      expect(state.activeHostId).toBe("host-1");
      expect(state.hosts["host-1"]?.hostId).toBe("host-1");
      expect(
        logSpy.mock.calls.some((call) => call.some((arg) => String(arg).includes("was unbound remotely")))
      ).toBe(false);
    } finally {
      await running?.stop();
      logSpy.mockRestore();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("starts and stops gateway watchdog with connector lifecycle", async () => {
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

    const lifecycleEvents: string[] = [];
    const gatewayRecoverySnapshot: GatewayWatchdogSnapshot = {
      running: false,
      phase: "stopped",
      pollIntervalMs: 10_000,
      consecutiveFailureThreshold: 3,
      consecutiveProbeFailures: 0,
      consecutiveRecoveryFailures: 0,
      maxRecoveryAttempts: 5,
      restartCooldownMs: 15_000,
      backoffScheduleMs: [0, 30_000, 120_000, 600_000],
      restartCommand: "openclaw gateway restart",
      recentRecoveries: []
    };
    const gatewayWatchdog: GatewayWatchdogLifecycle = {
      start() {
        lifecycleEvents.push("start");
        return () => {
          lifecycleEvents.push("stop");
        };
      },
      stop() {
        lifecycleEvents.push("stop-direct");
      },
      getSnapshot() {
        return gatewayRecoverySnapshot;
      }
    };

    const runtime = new ConnectorRuntime({
      hostRegistry: registry,
      gatewayDetector,
      backendClient,
      gatewayWatchdog
    });

    let running: Awaited<ReturnType<ConnectorRuntime["start"]>> | undefined;
    try {
      const snapshot = await runtime.createStatusSnapshot();
      expect(snapshot.gatewayRecovery.phase).toBe("stopped");
      expect(snapshot.gatewayRecovery.restartCommand).toBe("openclaw gateway restart");

      running = await runtime.start();
      expect(lifecycleEvents).toEqual(["start"]);

      await running.stop();
      running = undefined;
      expect(lifecycleEvents).toEqual(["start", "stop"]);
    } finally {
      await running?.stop();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
