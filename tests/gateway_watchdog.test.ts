import { describe, expect, test } from "vitest";
import { EventEmitter } from "node:events";

import type { GatewayProbeResult } from "../src/gateway_detector.js";
import type { GatewayCommandExecution, GatewayCommandRunner, GatewayWatchdogSnapshot } from "../src/gateway_watchdog.js";
import { GatewayWatchdog, OpenClawDevicePairingCommandRunner, OpenClawGatewayCommandRunner } from "../src/gateway_watchdog.js";

function createProbe(overrides: Partial<GatewayProbeResult>): GatewayProbeResult {
  return {
    status: "offline",
    ok: false,
    detail: "Gateway probe failed.",
    checkedAt: "2026-03-24T00:00:00.000Z",
    endpoint: "http://127.0.0.1:18789/tools/invoke",
    latencyMs: 5,
    ...overrides
  };
}

function createCommandExecution(
  command: "status" | "start" | "stop" | "restart",
  overrides: Partial<GatewayCommandExecution> = {}
): GatewayCommandExecution {
  const startedAt = "2026-03-24T00:00:00.000Z";
  return {
    command: `openclaw gateway ${command}`,
    args: ["gateway", command],
    stdout: "",
    stderr: "",
    exitCode: 0,
    signal: null,
    startedAt,
    completedAt: startedAt,
    durationMs: 0,
    ...overrides
  };
}

function createSpawnResult(stdout: string) {
  return () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter & { setEncoding: (encoding: string) => void };
      stderr: EventEmitter & { setEncoding: (encoding: string) => void };
      once: (event: string, listener: (...args: any[]) => void) => any;
    };
    child.stdout = new EventEmitter() as EventEmitter & { setEncoding: (encoding: string) => void };
    child.stderr = new EventEmitter() as EventEmitter & { setEncoding: (encoding: string) => void };
    child.stdout.setEncoding = () => {};
    child.stderr.setEncoding = () => {};
    queueMicrotask(() => {
      child.stdout.emit("data", stdout);
      child.emit("close", 0, null);
    });
    return child as any;
  };
}

function cloneProbe(probe: GatewayProbeResult): GatewayProbeResult {
  return { ...probe };
}

function createSequentialDetector(sequence: GatewayProbeResult[], fallback: GatewayProbeResult): {
  detect: () => Promise<GatewayProbeResult>;
} {
  let index = 0;
  return {
    async detect() {
      const next = sequence[index] ?? fallback;
      index += 1;
      return cloneProbe(next);
    }
  };
}

class RecordingCommandRunner implements GatewayCommandRunner {
  statusCalls = 0;
  startCalls = 0;
  stopCalls = 0;
  restartCalls = 0;

  private readonly statusResults: GatewayCommandExecution[];
  private readonly restartResults: GatewayCommandExecution[];
  private readonly defaultStatusResult: GatewayCommandExecution;
  private readonly defaultRestartResult: GatewayCommandExecution;

  constructor(options: {
    statusResults?: GatewayCommandExecution[];
    restartResults?: GatewayCommandExecution[];
  } = {}) {
    this.statusResults = options.statusResults ? [...options.statusResults] : [];
    this.restartResults = options.restartResults ? [...options.restartResults] : [];
    this.defaultStatusResult = createCommandExecution("status");
    this.defaultRestartResult = createCommandExecution("restart");
  }

  async status(): Promise<GatewayCommandExecution> {
    this.statusCalls += 1;
    return this.takeNext(this.statusResults, this.defaultStatusResult);
  }

  async start(): Promise<GatewayCommandExecution> {
    this.startCalls += 1;
    return createCommandExecution("start");
  }

  async stop(): Promise<GatewayCommandExecution> {
    this.stopCalls += 1;
    return createCommandExecution("stop");
  }

  async restart(): Promise<GatewayCommandExecution> {
    this.restartCalls += 1;
    return this.takeNext(this.restartResults, this.defaultRestartResult);
  }

  private takeNext(queue: GatewayCommandExecution[], fallback: GatewayCommandExecution): GatewayCommandExecution {
    const next = queue.length > 0 ? queue.shift() : undefined;
    return { ...(next ?? fallback), args: [...(next ?? fallback).args] };
  }
}

async function waitForCondition(
  predicate: () => boolean,
  options: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 2_000;
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

describe("GatewayWatchdog", () => {
  test("restarts after consecutive gateway failures and records successful recovery", async () => {
    const offline = createProbe({ ok: false, status: "offline", detail: "offline" });
    const online = createProbe({ ok: true, status: "online", detail: "online" });
    const gatewayDetector = createSequentialDetector(
      [
        offline,
        offline,
        offline,
        offline, // confirmation probe before restart
        online // post-restart verification probe
      ],
      online
    );
    const commandRunner = new RecordingCommandRunner({
      statusResults: [createCommandExecution("status", { exitCode: 0 })],
      restartResults: [createCommandExecution("restart", { exitCode: 0 })]
    });
    const watchdog = new GatewayWatchdog({
      gatewayDetector,
      commandRunner,
      pollIntervalMs: 5,
      consecutiveFailureThreshold: 3,
      restartCooldownMs: 0,
      backoffScheduleMs: [0]
    });

    let snapshot: GatewayWatchdogSnapshot | undefined;
    const stop = watchdog.start();
    try {
      await waitForCondition(() => commandRunner.restartCalls === 1);
      await waitForCondition(() => watchdog.getSnapshot().recentRecoveries.length === 1);
      snapshot = watchdog.getSnapshot();
    } finally {
      stop();
    }

    expect(commandRunner.statusCalls).toBe(1);
    expect(commandRunner.restartCalls).toBe(1);
    expect(snapshot?.phase).toBe("monitoring");
    expect(snapshot?.consecutiveProbeFailures).toBe(0);
    expect(snapshot?.consecutiveRecoveryFailures).toBe(0);
    expect(snapshot?.recentRecoveries.length).toBe(1);
    expect(snapshot?.recentRecoveries[0]?.ok).toBe(true);
    expect(snapshot?.recentRecoveries[0]?.restart?.command).toBe("openclaw gateway restart");
  });

  test("backs off and enters manual attention after repeated failed restarts", async () => {
    const offline = createProbe({ ok: false, status: "offline", detail: "offline" });
    const gatewayDetector = createSequentialDetector([offline], offline);
    const commandRunner = new RecordingCommandRunner({
      restartResults: [
        createCommandExecution("restart", { exitCode: 1, stderr: "boom-1" }),
        createCommandExecution("restart", { exitCode: 1, stderr: "boom-2" }),
        createCommandExecution("restart", { exitCode: 1, stderr: "boom-3" })
      ]
    });
    const watchdog = new GatewayWatchdog({
      gatewayDetector,
      commandRunner,
      pollIntervalMs: 5,
      consecutiveFailureThreshold: 1,
      maxRecoveryAttempts: 3,
      restartCooldownMs: 0,
      backoffScheduleMs: [0, 20, 40]
    });

    const stop = watchdog.start();
    let finalSnapshot: GatewayWatchdogSnapshot | undefined;
    try {
      await waitForCondition(() => watchdog.getSnapshot().phase === "manual_attention");
      finalSnapshot = watchdog.getSnapshot();
      const restartCallsAfterTrip = commandRunner.restartCalls;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 40);
      });
      expect(commandRunner.restartCalls).toBe(restartCallsAfterTrip);
    } finally {
      stop();
    }

    expect(commandRunner.restartCalls).toBe(3);
    expect(finalSnapshot?.phase).toBe("manual_attention");
    expect(finalSnapshot?.consecutiveRecoveryFailures).toBe(3);
    expect(finalSnapshot?.recentRecoveries.length).toBe(3);
    expect(finalSnapshot?.recentRecoveries.every((record) => !record.ok)).toBe(true);
  });

  test("prefers node runtime restart when node service is active", async () => {
    const outputs = new Map<string, string>([
      ["gateway status", "Service: LaunchAgent (not loaded)\nRuntime: unknown\nService not installed. Run: openclaw gateway install\n"],
      ["node status", "Service: LaunchAgent (loaded)\nCommand: /opt/homebrew/bin/node /opt/homebrew/lib/node_modules/openclaw/dist/index.js node run --host 127.0.0.1 --port 18789\nRuntime: running (pid 123, state active)\n"],
      ["node restart", "Restarted LaunchAgent: gui/501/ai.openclaw.node\n"],
      ["gateway restart", "should-not-run\n"]
    ]);
    const seen: string[] = [];
    const runner = new OpenClawGatewayCommandRunner({
      spawnImpl: (_command, args) => {
        const key = `${args[0]} ${args[1]}`;
        seen.push(key);
        return createSpawnResult(outputs.get(key) ?? "")();
      }
    });

    const result = await runner.restart();

    expect(result.runtimeTarget).toBe("node");
    expect(result.command).toBe("openclaw node restart");
    expect(seen).toEqual(["gateway status", "node status", "node restart"]);
  });

  test("approves matching local node-host upgrade when pairing is pending", async () => {
    const outputs = new Map<string, string>([
      [
        "devices list --json",
        JSON.stringify({
          pending: [
            {
              requestId: "req-node-1",
              deviceId: "device-local",
              clientId: "node-host",
              role: "node",
              ts: 10
            }
          ],
          paired: [
            {
              deviceId: "device-local",
              clientId: "cli",
              role: "operator"
            }
          ]
        })
      ],
      ["devices approve req-node-1 --json", JSON.stringify({ ok: true, requestId: "req-node-1" })]
    ]);
    const seen: string[] = [];
    const runner = new OpenClawDevicePairingCommandRunner({
      spawnImpl: (_command, args) => {
        const key = args.join(" ");
        seen.push(key);
        return createSpawnResult(outputs.get(key) ?? "")();
      }
    });

    const result = await runner.approveLocalNodeUpgrade();

    expect(result?.command).toBe("openclaw devices approve req-node-1 --json");
    expect(seen).toEqual(["devices list --json", "devices approve req-node-1 --json"]);
  });
});
