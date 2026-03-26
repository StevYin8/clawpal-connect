import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";

import type { GatewayProbeResult } from "./gateway_detector.js";

type SpawnOpenClawProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcessWithoutNullStreams;

type IntervalHandle = ReturnType<typeof setInterval>;

type GatewayLifecycleCommand = "status" | "start" | "stop" | "restart";
type OpenClawRuntimeTarget = "gateway" | "node";

type GatewayRecoveryTrigger = "consecutive_probe_failures";

export type GatewayWatchdogPhase = "stopped" | "monitoring" | "recovering" | "backoff" | "manual_attention";

export interface GatewayCommandExecution {
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  runtimeTarget?: OpenClawRuntimeTarget;
}

export interface GatewayCommandRunner {
  status(): Promise<GatewayCommandExecution>;
  start(): Promise<GatewayCommandExecution>;
  stop(): Promise<GatewayCommandExecution>;
  restart(): Promise<GatewayCommandExecution>;
}

export interface PairingCommandRunner {
  approveLocalNodeUpgrade(): Promise<GatewayCommandExecution | undefined>;
}

export interface OpenClawGatewayCommandRunnerOptions {
  openClawBinary?: string;
  spawnImpl?: SpawnOpenClawProcess;
  env?: NodeJS.ProcessEnv;
}

export interface GatewayRecoveryAttemptRecord {
  id: number;
  trigger: GatewayRecoveryTrigger;
  triggeredAt: string;
  completedAt: string;
  consecutiveProbeFailures: number;
  ok: boolean;
  detail: string;
  triggerProbe: GatewayProbeResult;
  preflightStatus?: GatewayCommandExecution;
  preflightStatusError?: string;
  restart?: GatewayCommandExecution;
  restartError?: string;
  verifiedProbe?: GatewayProbeResult;
}

export interface GatewayWatchdogSnapshot {
  running: boolean;
  phase: GatewayWatchdogPhase;
  pollIntervalMs: number;
  consecutiveFailureThreshold: number;
  consecutiveProbeFailures: number;
  consecutiveRecoveryFailures: number;
  maxRecoveryAttempts: number;
  restartCooldownMs: number;
  backoffScheduleMs: number[];
  restartCommand: string;
  lastProbe?: GatewayProbeResult;
  nextRecoveryAllowedAt?: string;
  lastRecoverySuccessAt?: string;
  lastRecoveryFailureAt?: string;
  recentRecoveries: GatewayRecoveryAttemptRecord[];
}

export interface GatewayWatchdogLifecycle {
  start(): () => void;
  stop(): void;
  getSnapshot(): GatewayWatchdogSnapshot;
}

export interface GatewayWatchdogOptions {
  gatewayDetector: {
    detect(): Promise<GatewayProbeResult>;
  };
  commandRunner?: GatewayCommandRunner;
  pollIntervalMs?: number;
  consecutiveFailureThreshold?: number;
  maxRecoveryAttempts?: number;
  restartCooldownMs?: number;
  backoffScheduleMs?: number[];
  recoveryHistoryLimit?: number;
  now?: () => Date;
  onError?: (error: unknown) => void;
  setIntervalImpl?: (callback: () => void, ms: number) => IntervalHandle;
  clearIntervalImpl?: (interval: IntervalHandle) => void;
}

const DEFAULT_OPENCLAW_BINARY = "openclaw";
const DEFAULT_RUNTIME_RESTART_COMMAND = "openclaw auto-runtime restart";
const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD = 3;
const DEFAULT_MAX_RECOVERY_ATTEMPTS = 5;
const DEFAULT_RESTART_COOLDOWN_MS = 15_000;
const DEFAULT_BACKOFF_SCHEDULE_MS = [0, 30_000, 120_000, 600_000];
const DEFAULT_RECOVERY_HISTORY_LIMIT = 20;

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  const parsed = Math.trunc(value);
  return parsed > 0 ? parsed : fallback;
}

function normalizeNonNegativeInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  const parsed = Math.trunc(value);
  return parsed >= 0 ? parsed : fallback;
}

function normalizeBackoffSchedule(values: number[] | undefined): number[] {
  if (!values || values.length === 0) {
    return [...DEFAULT_BACKOFF_SCHEDULE_MS];
  }

  const normalized = values
    .map((value) => normalizeNonNegativeInt(value, 0));

  if (normalized.length === 0) {
    return [...DEFAULT_BACKOFF_SCHEDULE_MS];
  }

  return normalized;
}

function cloneGatewayProbeResult(probe: GatewayProbeResult): GatewayProbeResult {
  return { ...probe };
}

function cloneCommandExecution(result: GatewayCommandExecution): GatewayCommandExecution {
  return {
    ...result,
    args: [...result.args]
  };
}

function cloneRecoveryRecord(record: GatewayRecoveryAttemptRecord): GatewayRecoveryAttemptRecord {
  return {
    ...record,
    triggerProbe: cloneGatewayProbeResult(record.triggerProbe),
    ...(record.preflightStatus ? { preflightStatus: cloneCommandExecution(record.preflightStatus) } : {}),
    ...(record.restart ? { restart: cloneCommandExecution(record.restart) } : {}),
    ...(record.verifiedProbe ? { verifiedProbe: cloneGatewayProbeResult(record.verifiedProbe) } : {})
  };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function executionOutput(result: GatewayCommandExecution): string {
  return `${result.stdout}\n${result.stderr}`.trim();
}

function isRuntimeInstalled(result: GatewayCommandExecution): boolean {
  const output = executionOutput(result).toLowerCase();
  return !output.includes("service unit not found") && !output.includes("service not installed");
}

function isRuntimeActive(result: GatewayCommandExecution, target: OpenClawRuntimeTarget): boolean {
  const output = executionOutput(result).toLowerCase();
  const commandHint = target === "node" ? " node run" : " gateway --port";
  const hasMatchingCommand = output.includes(commandHint);
  return hasMatchingCommand && (output.includes("runtime: running") || output.includes("service: launchagent (loaded)"));
}

interface DeviceListJson {
  pending?: Array<Record<string, unknown>>;
  paired?: Array<Record<string, unknown>>;
}

function parseDeviceListJson(stdout: string): DeviceListJson | undefined {
  const normalized = stdout.trim();
  if (!normalized) {
    return undefined;
  }
  try {
    return JSON.parse(normalized) as DeviceListJson;
  } catch {
    return undefined;
  }
}

export class OpenClawGatewayCommandRunner implements GatewayCommandRunner {
  private readonly openClawBinary: string;
  private readonly spawnImpl: SpawnOpenClawProcess;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: OpenClawGatewayCommandRunnerOptions = {}) {
    this.openClawBinary = options.openClawBinary?.trim() || DEFAULT_OPENCLAW_BINARY;
    this.spawnImpl =
      options.spawnImpl ??
      ((command: string, args: readonly string[], spawnOptions: SpawnOptions) =>
        spawn(command, [...args], spawnOptions) as ChildProcessWithoutNullStreams);
    this.env = options.env ?? process.env;
  }

  async status(): Promise<GatewayCommandExecution> {
    const inspection = await this.inspectRuntimeTarget();
    return inspection.activeStatus ?? inspection.preferredStatus;
  }

  async start(): Promise<GatewayCommandExecution> {
    const inspection = await this.inspectRuntimeTarget();
    return await this.runForTarget(inspection.preferredTarget, "start");
  }

  async stop(): Promise<GatewayCommandExecution> {
    const inspection = await this.inspectRuntimeTarget();
    return await this.runForTarget(inspection.preferredTarget, "stop");
  }

  async restart(): Promise<GatewayCommandExecution> {
    const inspection = await this.inspectRuntimeTarget();
    return await this.runForTarget(inspection.preferredTarget, "restart");
  }

  private async inspectRuntimeTarget(): Promise<{
    preferredTarget: OpenClawRuntimeTarget;
    preferredStatus: GatewayCommandExecution;
    activeStatus?: GatewayCommandExecution;
  }> {
    const [gatewayStatus, nodeStatus] = await Promise.all([
      this.runForTarget("gateway", "status"),
      this.runForTarget("node", "status")
    ]);

    const gatewayActive = isRuntimeActive(gatewayStatus, "gateway");
    const nodeActive = isRuntimeActive(nodeStatus, "node");
    if (nodeActive && !gatewayActive) {
      return {
        preferredTarget: "node",
        preferredStatus: nodeStatus,
        activeStatus: nodeStatus
      };
    }
    if (gatewayActive && !nodeActive) {
      return {
        preferredTarget: "gateway",
        preferredStatus: gatewayStatus,
        activeStatus: gatewayStatus
      };
    }
    if (nodeActive) {
      return {
        preferredTarget: "node",
        preferredStatus: nodeStatus,
        activeStatus: nodeStatus
      };
    }
    if (gatewayActive) {
      return {
        preferredTarget: "gateway",
        preferredStatus: gatewayStatus,
        activeStatus: gatewayStatus
      };
    }

    const nodeInstalled = isRuntimeInstalled(nodeStatus);
    const gatewayInstalled = isRuntimeInstalled(gatewayStatus);
    if (nodeInstalled && !gatewayInstalled) {
      return {
        preferredTarget: "node",
        preferredStatus: nodeStatus
      };
    }
    if (gatewayInstalled && !nodeInstalled) {
      return {
        preferredTarget: "gateway",
        preferredStatus: gatewayStatus
      };
    }

    return {
      preferredTarget: "node",
      preferredStatus: nodeStatus
    };
  }

  private async runForTarget(target: OpenClawRuntimeTarget, command: GatewayLifecycleCommand): Promise<GatewayCommandExecution> {
    const args = [target, command];
    const startedMs = Date.now();
    const startedAt = new Date(startedMs).toISOString();

    return await new Promise<GatewayCommandExecution>((resolve, reject) => {
      const child = this.spawnImpl(this.openClawBinary, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: this.env
      });

      let stdout = "";
      let stderr = "";

      child.stdout.setEncoding("utf-8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });

      child.stderr.setEncoding("utf-8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      child.once("error", reject);
      child.once("close", (exitCode, signal) => {
        const completedMs = Date.now();
        resolve({
          command: `${this.openClawBinary} ${args.join(" ")}`,
          args: [...args],
          stdout,
          stderr,
          exitCode,
          signal,
          startedAt,
          completedAt: new Date(completedMs).toISOString(),
          durationMs: completedMs - startedMs,
          runtimeTarget: target
        });
      });
    });
  }
}

export class OpenClawDevicePairingCommandRunner implements PairingCommandRunner {
  private readonly openClawBinary: string;
  private readonly spawnImpl: SpawnOpenClawProcess;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: OpenClawGatewayCommandRunnerOptions = {}) {
    this.openClawBinary = options.openClawBinary?.trim() || DEFAULT_OPENCLAW_BINARY;
    this.spawnImpl =
      options.spawnImpl ??
      ((command: string, args: readonly string[], spawnOptions: SpawnOptions) =>
        spawn(command, [...args], spawnOptions) as ChildProcessWithoutNullStreams);
    this.env = options.env ?? process.env;
  }

  async approveLocalNodeUpgrade(): Promise<GatewayCommandExecution | undefined> {
    const listed = await this.runRaw(["devices", "list", "--json"]);
    const parsed = parseDeviceListJson(listed.stdout);
    if (!parsed) {
      return undefined;
    }

    const paired = Array.isArray(parsed.paired) ? parsed.paired : [];
    const pending = Array.isArray(parsed.pending) ? parsed.pending : [];
    const localOperatorDeviceIds = new Set(
      paired
        .filter((entry) => entry.clientId === "cli" && entry.role === "operator")
        .map((entry) => String(entry.deviceId ?? "").trim())
        .filter((value) => value.length > 0)
    );

    const candidate = pending
      .filter((entry) => entry.clientId === "node-host" && entry.role === "node")
      .filter((entry) => localOperatorDeviceIds.has(String(entry.deviceId ?? "").trim()))
      .sort((left, right) => Number(right.ts ?? 0) - Number(left.ts ?? 0))[0];

    const requestId = String(candidate?.requestId ?? "").trim();
    if (!requestId) {
      return undefined;
    }

    return await this.runRaw(["devices", "approve", requestId, "--json"]);
  }

  private async runRaw(args: string[]): Promise<GatewayCommandExecution> {
    const startedMs = Date.now();
    const startedAt = new Date(startedMs).toISOString();

    return await new Promise<GatewayCommandExecution>((resolve, reject) => {
      const child = this.spawnImpl(this.openClawBinary, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: this.env
      });

      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf-8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf-8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("close", (exitCode, signal) => {
        const completedMs = Date.now();
        resolve({
          command: `${this.openClawBinary} ${args.join(" ")}`,
          args: [...args],
          stdout,
          stderr,
          exitCode,
          signal,
          startedAt,
          completedAt: new Date(completedMs).toISOString(),
          durationMs: completedMs - startedMs
        });
      });
    });
  }
}

export class GatewayWatchdog implements GatewayWatchdogLifecycle {
  private readonly gatewayDetector: GatewayWatchdogOptions["gatewayDetector"];
  private readonly commandRunner: GatewayCommandRunner;
  private readonly pollIntervalMs: number;
  private readonly consecutiveFailureThreshold: number;
  private readonly maxRecoveryAttempts: number;
  private readonly restartCooldownMs: number;
  private readonly backoffScheduleMs: number[];
  private readonly recoveryHistoryLimit: number;
  private readonly now: () => Date;
  private readonly onError: ((error: unknown) => void) | undefined;
  private readonly setIntervalImpl: NonNullable<GatewayWatchdogOptions["setIntervalImpl"]>;
  private readonly clearIntervalImpl: NonNullable<GatewayWatchdogOptions["clearIntervalImpl"]>;

  private timer: IntervalHandle | null = null;
  private running = false;
  private isTickInProgress = false;
  private phase: GatewayWatchdogPhase = "stopped";
  private consecutiveProbeFailures = 0;
  private consecutiveRecoveryFailures = 0;
  private recoveryAttemptCounter = 0;
  private lastProbe: GatewayProbeResult | undefined;
  private nextRecoveryAllowedAtMs: number | null = null;
  private lastRecoverySuccessAt: string | undefined;
  private lastRecoveryFailureAt: string | undefined;
  private readonly recentRecoveries: GatewayRecoveryAttemptRecord[] = [];

  constructor(options: GatewayWatchdogOptions) {
    this.gatewayDetector = options.gatewayDetector;
    this.commandRunner = options.commandRunner ?? new OpenClawGatewayCommandRunner();
    this.pollIntervalMs = normalizePositiveInt(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
    this.consecutiveFailureThreshold = normalizePositiveInt(
      options.consecutiveFailureThreshold,
      DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD
    );
    this.maxRecoveryAttempts = normalizePositiveInt(options.maxRecoveryAttempts, DEFAULT_MAX_RECOVERY_ATTEMPTS);
    this.restartCooldownMs = normalizeNonNegativeInt(options.restartCooldownMs, DEFAULT_RESTART_COOLDOWN_MS);
    this.backoffScheduleMs = normalizeBackoffSchedule(options.backoffScheduleMs);
    this.recoveryHistoryLimit = normalizePositiveInt(options.recoveryHistoryLimit, DEFAULT_RECOVERY_HISTORY_LIMIT);
    this.now = options.now ?? (() => new Date());
    this.onError = options.onError;
    this.setIntervalImpl = options.setIntervalImpl ?? setInterval;
    this.clearIntervalImpl = options.clearIntervalImpl ?? clearInterval;
  }

  start(): () => void {
    if (this.running) {
      throw new Error("Gateway watchdog is already running.");
    }

    this.running = true;
    this.phase = "monitoring";
    void this.tick();
    this.timer = this.setIntervalImpl(() => {
      void this.tick();
    }, this.pollIntervalMs);

    return () => this.stop();
  }

  stop(): void {
    if (this.timer) {
      this.clearIntervalImpl(this.timer);
      this.timer = null;
    }
    this.running = false;
    this.phase = "stopped";
    this.nextRecoveryAllowedAtMs = null;
  }

  getSnapshot(): GatewayWatchdogSnapshot {
    return {
      running: this.running,
      phase: this.phase,
      pollIntervalMs: this.pollIntervalMs,
      consecutiveFailureThreshold: this.consecutiveFailureThreshold,
      consecutiveProbeFailures: this.consecutiveProbeFailures,
      consecutiveRecoveryFailures: this.consecutiveRecoveryFailures,
      maxRecoveryAttempts: this.maxRecoveryAttempts,
      restartCooldownMs: this.restartCooldownMs,
      backoffScheduleMs: [...this.backoffScheduleMs],
      restartCommand: DEFAULT_RUNTIME_RESTART_COMMAND,
      ...(this.lastProbe ? { lastProbe: cloneGatewayProbeResult(this.lastProbe) } : {}),
      ...(this.nextRecoveryAllowedAtMs !== null
        ? { nextRecoveryAllowedAt: new Date(this.nextRecoveryAllowedAtMs).toISOString() }
        : {}),
      ...(this.lastRecoverySuccessAt ? { lastRecoverySuccessAt: this.lastRecoverySuccessAt } : {}),
      ...(this.lastRecoveryFailureAt ? { lastRecoveryFailureAt: this.lastRecoveryFailureAt } : {}),
      recentRecoveries: this.recentRecoveries.map((record) => cloneRecoveryRecord(record))
    };
  }

  private async tick(): Promise<void> {
    if (!this.running || this.isTickInProgress) {
      return;
    }

    this.isTickInProgress = true;
    try {
      await this.checkGatewayHealthAndRecover();
    } catch (error) {
      this.onError?.(error);
    } finally {
      this.isTickInProgress = false;
    }
  }

  private async checkGatewayHealthAndRecover(): Promise<void> {
    const probe = await this.gatewayDetector.detect();
    this.lastProbe = cloneGatewayProbeResult(probe);

    if (probe.ok) {
      this.consecutiveProbeFailures = 0;
      if (this.phase !== "manual_attention") {
        this.phase = "monitoring";
      }
      return;
    }

    this.consecutiveProbeFailures += 1;

    if (this.phase === "manual_attention") {
      return;
    }

    if (this.consecutiveProbeFailures < this.consecutiveFailureThreshold) {
      if (this.shouldWaitForRecoveryWindow()) {
        this.phase = "backoff";
      } else if (this.phase !== "recovering") {
        this.phase = "monitoring";
      }
      return;
    }

    if (this.shouldWaitForRecoveryWindow()) {
      this.phase = "backoff";
      return;
    }

    const confirmedProbe = await this.gatewayDetector.detect();
    this.lastProbe = cloneGatewayProbeResult(confirmedProbe);
    if (confirmedProbe.ok) {
      this.consecutiveProbeFailures = 0;
      this.phase = "monitoring";
      return;
    }

    await this.attemptRecovery(confirmedProbe);
  }

  private shouldWaitForRecoveryWindow(): boolean {
    if (!this.nextRecoveryAllowedAtMs) {
      return false;
    }
    return this.now().getTime() < this.nextRecoveryAllowedAtMs;
  }

  private resolveBackoffMs(consecutiveRecoveryFailures: number): number {
    if (this.backoffScheduleMs.length === 0) {
      return 0;
    }

    const index = Math.min(consecutiveRecoveryFailures, this.backoffScheduleMs.length - 1);
    return this.backoffScheduleMs[index] ?? 0;
  }

  private async attemptRecovery(triggerProbe: GatewayProbeResult): Promise<void> {
    this.phase = "recovering";

    const triggeredAt = this.now().toISOString();
    const attemptId = this.recoveryAttemptCounter + 1;
    this.recoveryAttemptCounter = attemptId;

    let preflightStatus: GatewayCommandExecution | undefined;
    let preflightStatusError: string | undefined;
    let restart: GatewayCommandExecution | undefined;
    let restartError: string | undefined;
    let verifiedProbe: GatewayProbeResult | undefined;
    let ok = false;
    let detail = "";

    try {
      preflightStatus = await this.commandRunner.status();
    } catch (error) {
      preflightStatusError = toErrorMessage(error);
    }

    try {
      restart = await this.commandRunner.restart();
    } catch (error) {
      restartError = toErrorMessage(error);
    }

    if (restartError) {
      detail = `${restartError}`;
    } else if (!restart) {
      detail = "Runtime restart did not return an execution result.";
    } else if (restart.exitCode !== 0) {
      const signalInfo = restart.signal ? `, signal=${restart.signal}` : "";
      const stderr = restart.stderr.trim();
      detail = `${restart.command} exited with code ${String(restart.exitCode)}${signalInfo}${stderr ? `, stderr=${stderr}` : ""}`;
    } else {
      verifiedProbe = await this.gatewayDetector.detect();
      this.lastProbe = cloneGatewayProbeResult(verifiedProbe);
      ok = verifiedProbe.ok;
      detail = ok
        ? `Gateway recovered after ${restart.command}.`
        : `${restart.command} succeeded but gateway probe remains unhealthy: ${verifiedProbe.detail}`;
    }

    const completedAt = this.now().toISOString();
    this.pushRecoveryRecord({
      id: attemptId,
      trigger: "consecutive_probe_failures",
      triggeredAt,
      completedAt,
      consecutiveProbeFailures: this.consecutiveProbeFailures,
      ok,
      detail,
      triggerProbe: cloneGatewayProbeResult(triggerProbe),
      ...(preflightStatus ? { preflightStatus } : {}),
      ...(preflightStatusError ? { preflightStatusError } : {}),
      ...(restart ? { restart } : {}),
      ...(restartError ? { restartError } : {}),
      ...(verifiedProbe ? { verifiedProbe: cloneGatewayProbeResult(verifiedProbe) } : {})
    });

    const nowMs = this.now().getTime();
    if (ok) {
      this.consecutiveProbeFailures = 0;
      this.consecutiveRecoveryFailures = 0;
      this.lastRecoverySuccessAt = completedAt;
      this.nextRecoveryAllowedAtMs = nowMs + this.restartCooldownMs;
      this.phase = "monitoring";
      return;
    }

    this.consecutiveRecoveryFailures += 1;
    this.lastRecoveryFailureAt = completedAt;

    if (this.consecutiveRecoveryFailures >= this.maxRecoveryAttempts) {
      this.nextRecoveryAllowedAtMs = null;
      this.phase = "manual_attention";
      return;
    }

    const backoffMs = this.resolveBackoffMs(this.consecutiveRecoveryFailures);
    const recoveryDelayMs = Math.max(this.restartCooldownMs, backoffMs);
    this.nextRecoveryAllowedAtMs = nowMs + recoveryDelayMs;
    this.phase = "backoff";
  }

  private pushRecoveryRecord(record: GatewayRecoveryAttemptRecord): void {
    this.recentRecoveries.unshift(record);
    if (this.recentRecoveries.length > this.recoveryHistoryLimit) {
      this.recentRecoveries.length = this.recoveryHistoryLimit;
    }
  }
}
