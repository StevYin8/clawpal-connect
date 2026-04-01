import WebSocket, { Data } from "ws";
import { randomUUID } from "node:crypto";

import type {
  AgentFilesOperation,
  AgentFilesSetRequestPayload,
  BackendConnectionContext,
  BackendTransport,
  ConnectorEvent,
  ForwardedFileRequest,
  ForwardedFileRequestHandler,
  ForwardedRequest,
  ForwardedRequestHandler,
  GatewayRestartControl,
  GatewayRestartHandler,
  HostConnectionStatus,
  HostUnbindControl,
  HostUnbindHandler,
  TransportRecoveryAttemptRecord,
  TransportRecoveryGatewayProbe,
  TransportRecoverySnapshot
} from "./backend_client.js";
import type { GatewayProbeResult } from "./gateway_detector.js";
import {
  OpenClawDevicePairingCommandRunner,
  OpenClawGatewayCommandRunner,
  describeAmbiguousRuntimeExecution,
  type GatewayCommandExecution,
  type GatewayCommandRunner,
  type PairingCommandRunner
} from "./gateway_watchdog.js";

interface EventWaiter {
  predicate: (event: ConnectorEvent) => boolean;
  resolve: (event: ConnectorEvent) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface GatewayProbeDetector {
  detect(): Promise<GatewayProbeResult>;
}

export interface WsBackendTransportOptions {
  gatewayDetector?: GatewayProbeDetector;
  gatewayCommandRunner?: GatewayCommandRunner;
  pairingCommandRunner?: PairingCommandRunner;
  connectTimeoutMs?: number;
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  recoveryConsecutiveFailureThreshold?: number;
  maxGatewayRecoveryAttempts?: number;
  recoveryHistoryLimit?: number;
  now?: () => Date;
  setTimeoutImpl?: (callback: () => void, ms: number) => NodeJS.Timeout;
  clearTimeoutImpl?: (timer: NodeJS.Timeout) => void;
  createWebSocket?: (url: string) => WebSocket;
}

const AGENT_FILES_OPERATIONS: readonly AgentFilesOperation[] = [
  "agents.files.list",
  "agents.files.get",
  "agents.files.set"
];
const HOST_UNBIND_MESSAGE_TYPES = new Set([
  "relay.host_unbind",
  "relay.host.unbind",
  "relay.control.host_unbind"
]);
const HOST_UNBIND_CONTROL_TYPES = new Set(["host_unbind", "host.unbind"]);
const GATEWAY_RESTART_MESSAGE_TYPES = new Set([
  "relay.gateway_restart",
  "relay.gateway.restart",
  "relay.control.gateway_restart"
]);
const GATEWAY_RESTART_CONTROL_TYPES = new Set(["gateway_restart", "gateway.restart"]);
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 30_000;
const DEFAULT_RECOVERY_CONSECUTIVE_FAILURE_THRESHOLD = 3;
const DEFAULT_MAX_GATEWAY_RECOVERY_ATTEMPTS = 5;
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

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPairingRequiredError(detail: string): boolean {
  const normalized = detail.toLowerCase();
  return normalized.includes("pairing required") || normalized.includes("role-upgrade") || normalized.includes("not paired");
}

function cloneGatewayProbe(probe: TransportRecoveryGatewayProbe): TransportRecoveryGatewayProbe {
  return { ...probe };
}

function cloneRecoveryAttempt(record: TransportRecoveryAttemptRecord): TransportRecoveryAttemptRecord {
  return {
    ...record,
    ...(record.gatewayProbe ? { gatewayProbe: cloneGatewayProbe(record.gatewayProbe) } : {})
  };
}

function isAgentFilesOperation(value: unknown): value is AgentFilesOperation {
  return typeof value === "string" && AGENT_FILES_OPERATIONS.includes(value as AgentFilesOperation);
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function readRawString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function resolveRelayWsBaseUrl(backendUrl: string): string {
  const normalized = backendUrl.trim();
  if (!normalized) {
    throw new Error("backendUrl cannot be empty.");
  }

  const parsed = new URL(/^https?:\/\//i.test(normalized) ? normalized : `http://${normalized}`);
  const isSecure = parsed.protocol === "https:" || parsed.protocol === "wss:";
  const wsProtocol = isSecure ? "wss:" : "ws:";

  // ClawPal relay uses 3001 for HTTP API and 8788 for WS transport.
  if (parsed.port === "3001") {
    parsed.port = "8788";
  }

  parsed.protocol = wsProtocol;
  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

/**
 * WebSocket-based backend transport for connecting to ClawPal relay server.
 */
export class WsBackendTransport implements BackendTransport {
  readonly name = "ws";

  private readonly gatewayDetector: GatewayProbeDetector | undefined;
  private readonly gatewayCommandRunner: GatewayCommandRunner | undefined;
  private readonly pairingCommandRunner: PairingCommandRunner | undefined;
  private readonly connectTimeoutMs: number;
  private readonly reconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;
  private readonly recoveryConsecutiveFailureThreshold: number;
  private readonly maxGatewayRecoveryAttempts: number;
  private readonly recoveryHistoryLimit: number;
  private readonly now: () => Date;
  private readonly setTimeoutImpl: NonNullable<WsBackendTransportOptions["setTimeoutImpl"]>;
  private readonly clearTimeoutImpl: NonNullable<WsBackendTransportOptions["clearTimeoutImpl"]>;
  private readonly createWebSocket: NonNullable<WsBackendTransportOptions["createWebSocket"]>;

  private ws: WebSocket | null = null;
  private context: BackendConnectionContext | null = null;
  private connected = false;
  private forwardedRequestHandler: ForwardedRequestHandler = async () => {};
  private forwardedFileRequestHandler: ForwardedFileRequestHandler = async () => {};
  private hostUnbindHandler: HostUnbindHandler = async () => {};
  private gatewayRestartHandler: GatewayRestartHandler = async () => {};
  private readonly sentEvents: ConnectorEvent[] = [];
  private readonly waiters: EventWaiter[] = [];
  private recoveryPhase: TransportRecoverySnapshot["phase"] = "idle";
  private recoveryStatus: TransportRecoverySnapshot["status"] = "healthy";
  private recoveryDetail = "WebSocket transport is healthy.";
  private consecutiveConnectFailures = 0;
  private consecutiveGatewayRecoveryFailures = 0;
  private lastConnectSuccessAt: string | undefined;
  private lastConnectFailureAt: string | undefined;
  private lastFailureDetail: string | undefined;
  private lastSuccessDetail: string | undefined;
  private lastRecoverySuccessAt: string | undefined;
  private lastRecoveryFailureAt: string | undefined;
  private lastGatewayProbe: TransportRecoveryGatewayProbe | undefined;
  private recoveryAttemptCounter = 0;
  private recoveryInProgress = false;
  private readonly recentRecoveryAttempts: TransportRecoveryAttemptRecord[] = [];
  private reconnectAttempts = 0;
  private maxReconnectAttempts = Number.POSITIVE_INFINITY;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnecting = false;
  private intentionalDisconnect = false;
  private socketGeneration = 0;
  private _onClose?: (reason: string) => void;

  constructor(options: WsBackendTransportOptions = {}) {
    this.gatewayDetector = options.gatewayDetector;
    this.gatewayCommandRunner =
      options.gatewayCommandRunner ?? (this.gatewayDetector ? new OpenClawGatewayCommandRunner() : undefined);
    this.pairingCommandRunner = options.pairingCommandRunner ?? new OpenClawDevicePairingCommandRunner();
    this.connectTimeoutMs = normalizePositiveInt(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS);
    this.reconnectDelayMs = normalizePositiveInt(options.reconnectDelayMs, DEFAULT_RECONNECT_DELAY_MS);
    this.maxReconnectDelayMs = normalizePositiveInt(options.maxReconnectDelayMs, DEFAULT_MAX_RECONNECT_DELAY_MS);
    this.recoveryConsecutiveFailureThreshold = normalizePositiveInt(
      options.recoveryConsecutiveFailureThreshold,
      DEFAULT_RECOVERY_CONSECUTIVE_FAILURE_THRESHOLD
    );
    this.maxGatewayRecoveryAttempts = normalizePositiveInt(
      options.maxGatewayRecoveryAttempts,
      DEFAULT_MAX_GATEWAY_RECOVERY_ATTEMPTS
    );
    this.recoveryHistoryLimit = normalizePositiveInt(options.recoveryHistoryLimit, DEFAULT_RECOVERY_HISTORY_LIMIT);
    this.now = options.now ?? (() => new Date());
    this.setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
    this.clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;
    this.createWebSocket = options.createWebSocket ?? ((url) => new WebSocket(url));
  }

  onForwardedRequest(handler: ForwardedRequestHandler): void {
    this.forwardedRequestHandler = handler;
  }

  onForwardedFileRequest(handler: ForwardedFileRequestHandler): void {
    this.forwardedFileRequestHandler = handler;
  }

  onHostUnbind(handler: HostUnbindHandler): void {
    this.hostUnbindHandler = handler;
  }

  onGatewayRestart(handler: GatewayRestartHandler): void {
    this.gatewayRestartHandler = handler;
  }

  async connect(context: BackendConnectionContext): Promise<void> {
    this.context = context;
    this.intentionalDisconnect = false;
    if (this.reconnectTimer) {
      this.clearTimeoutImpl(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const existing = this.ws;
    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const wsUrl = `${resolveRelayWsBaseUrl(context.backendUrl)}/ws/connector?hostId=${encodeURIComponent(context.hostId)}&userId=${encodeURIComponent(context.userId)}`;
    const generation = ++this.socketGeneration;

    return new Promise((resolve, reject) => {
      try {
        console.log(`[ws] Connecting to ${wsUrl}...`);
        const ws = this.createWebSocket(wsUrl);
        this.ws = ws;
        let settled = false;
        const failConnect = (error: Error): void => {
          if (settled || this.ws !== ws || generation !== this.socketGeneration) {
            return;
          }
          settled = true;
          this.clearTimeoutImpl(timeout);
          this.recordConnectFailure(error.message);
          reject(error);
        };
        const timeout = this.setTimeoutImpl(() => {
          if (settled || this.ws !== ws || this.connected) {
            return;
          }
          try {
            ws.close();
          } catch {}
          failConnect(new Error("Connection timeout"));
        }, this.connectTimeoutMs);

        ws.on("open", () => {
          if (this.ws !== ws || generation !== this.socketGeneration) {
            try {
              ws.close(1000, "superseded");
            } catch {}
            return;
          }
          settled = true;
          this.clearTimeoutImpl(timeout);
          console.log("[ws] Connected to relay server");
          this.connected = true;
          this.reconnecting = false;
          this.reconnectAttempts = 0;
          this.markConnectSuccess("Connected to relay server.");
          resolve();
        });

        ws.on("message", (data: Data) => {
          try {
            const payload = JSON.parse(data.toString());
            this.handleRelayMessage(payload);
          } catch (err) {
            console.error("[ws] Failed to parse relay message:", err);
          }
        });

        ws.on("close", (code: number, reason: Buffer) => {
          this.clearTimeoutImpl(timeout);
          const reasonText = reason.toString();
          console.log(`[ws] Connection closed: code=${code}, reason=${reasonText}`);
          if (this.ws !== ws || generation !== this.socketGeneration) {
            return;
          }
          if (!settled) {
            const closeError = reasonText || `Connection closed during handshake (code=${code}).`;
            failConnect(new Error(closeError));
          }
          this.connected = false;
          this.ws = null;
          this._onClose?.(reasonText);
          this.scheduleReconnect();
        });

        ws.on("error", (err: Error) => {
          console.error("[ws] WebSocket error:", err.message);
          failConnect(err);
        });
      } catch (err) {
        const wrapped = err instanceof Error ? err : new Error(String(err));
        this.recordConnectFailure(wrapped.message);
        reject(wrapped);
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.intentionalDisconnect) {
      return;
    }
    if (!this.context) {
      console.log("[ws] No context for reconnect");
      return;
    }
    if (this.reconnecting || this.reconnectTimer) {
      return;
    }

    this.reconnecting = true;
    this.reconnectAttempts++;
    const delay = Math.min(this.reconnectDelayMs * Math.pow(2, this.reconnectAttempts - 1), this.maxReconnectDelayMs);
    const maxLabel = Number.isFinite(this.maxReconnectAttempts)
      ? String(this.maxReconnectAttempts)
      : '∞';
    if (this.recoveryPhase === "idle") {
      this.recoveryPhase = "reconnecting";
      this.recoveryStatus = "degraded";
      this.recoveryDetail = "WebSocket disconnected. Attempting reconnect with exponential backoff.";
    }
    console.log(`[ws] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${maxLabel})`);

    this.reconnectTimer = this.setTimeoutImpl(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect(this.context!);
      } catch (err) {
        console.error("[ws] Reconnect failed:", err);
        this.reconnecting = false;
        this.scheduleReconnect();
        return;
      }
      this.reconnecting = false;
    }, delay);
  }

  getRecoverySnapshot(): TransportRecoverySnapshot {
    return {
      supported: true,
      phase: this.recoveryPhase,
      status: this.recoveryStatus,
      detail: this.recoveryDetail,
      consecutiveFailureThreshold: this.recoveryConsecutiveFailureThreshold,
      consecutiveConnectFailures: this.consecutiveConnectFailures,
      consecutiveGatewayRecoveryFailures: this.consecutiveGatewayRecoveryFailures,
      maxGatewayRecoveryAttempts: this.maxGatewayRecoveryAttempts,
      reconnectAttempts: this.reconnectAttempts,
      ...(this.lastConnectSuccessAt ? { lastConnectSuccessAt: this.lastConnectSuccessAt } : {}),
      ...(this.lastConnectFailureAt ? { lastConnectFailureAt: this.lastConnectFailureAt } : {}),
      ...(this.lastFailureDetail ? { lastFailureDetail: this.lastFailureDetail } : {}),
      ...(this.lastSuccessDetail ? { lastSuccessDetail: this.lastSuccessDetail } : {}),
      ...(this.lastRecoverySuccessAt ? { lastRecoverySuccessAt: this.lastRecoverySuccessAt } : {}),
      ...(this.lastRecoveryFailureAt ? { lastRecoveryFailureAt: this.lastRecoveryFailureAt } : {}),
      ...(this.lastGatewayProbe ? { lastGatewayProbe: cloneGatewayProbe(this.lastGatewayProbe) } : {}),
      recentRecoveryAttempts: this.recentRecoveryAttempts.map((record) => cloneRecoveryAttempt(record))
    };
  }

  private markConnectSuccess(detail: string): void {
    const now = this.now().toISOString();
    this.consecutiveConnectFailures = 0;
    this.consecutiveGatewayRecoveryFailures = 0;
    this.lastConnectSuccessAt = now;
    this.lastSuccessDetail = detail;
    this.recoveryPhase = "idle";
    this.recoveryStatus = "healthy";
    this.recoveryDetail = detail;
  }

  private recordConnectFailure(detail: string): void {
    const normalizedDetail = detail.trim() || "Unknown WebSocket connect error.";
    this.consecutiveConnectFailures += 1;
    this.lastConnectFailureAt = this.now().toISOString();
    this.lastFailureDetail = normalizedDetail;

    if (this.consecutiveConnectFailures < this.recoveryConsecutiveFailureThreshold) {
      this.recoveryPhase = "reconnecting";
      this.recoveryStatus = "degraded";
      this.recoveryDetail =
        `WebSocket connect failed (${normalizedDetail}). Retrying ` +
        `(${this.consecutiveConnectFailures}/${this.recoveryConsecutiveFailureThreshold} before diagnosis).`;
      return;
    }

    if (this.recoveryInProgress) {
      this.recoveryPhase = "diagnosing";
      this.recoveryStatus = "degraded";
      this.recoveryDetail =
        `WebSocket connect failures reached ${this.consecutiveConnectFailures}. ` +
        `Diagnosis already running. Last error: ${normalizedDetail}`;
      return;
    }

    this.recoveryPhase = "diagnosing";
    this.recoveryStatus = "degraded";
    this.recoveryDetail =
      `WebSocket connect failed ${this.consecutiveConnectFailures} times consecutively. ` +
      `Diagnosing local gateway and relay connectivity. Last error: ${normalizedDetail}`;
    void this.runRecoveryDiagnosis(normalizedDetail);
  }

  private toRecoveryGatewayProbe(probe: GatewayProbeResult): TransportRecoveryGatewayProbe {
    return {
      status: probe.status,
      ok: probe.ok,
      detail: probe.detail,
      checkedAt: probe.checkedAt,
      endpoint: probe.endpoint,
      latencyMs: probe.latencyMs,
      ...(probe.httpStatus !== undefined ? { httpStatus: probe.httpStatus } : {})
    };
  }

  private async runRecoveryDiagnosis(lastConnectError: string): Promise<void> {
    if (this.recoveryInProgress) {
      return;
    }

    this.recoveryInProgress = true;
    const attemptId = this.recoveryAttemptCounter + 1;
    this.recoveryAttemptCounter = attemptId;
    const triggeredAt = this.now().toISOString();

    let gatewayProbe: TransportRecoveryGatewayProbe | undefined;
    let restartExecution: GatewayCommandExecution | undefined;
    let restartError: string | undefined;
    let approvalExecution: GatewayCommandExecution | undefined;
    let approvalError: string | undefined;
    let classification: TransportRecoveryAttemptRecord["classification"] = "diagnostic_error";
    let ok = false;
    let detail = "";

    try {
      if (isPairingRequiredError(lastConnectError)) {
        this.recoveryPhase = "waiting_for_pairing";
        this.recoveryStatus = "pairing_required";
        this.recoveryDetail =
          `Detected pairing/role-upgrade requirement from transport error: ${lastConnectError}. ` +
          "Attempting local node-host approval.";

        if (!this.pairingCommandRunner) {
          classification = "pairing_required_unresolved";
          detail = "Pairing approval runner is not configured.";
        } else {
          try {
            approvalExecution = await this.pairingCommandRunner.approveLocalNodeUpgrade();
          } catch (error) {
            approvalError = toErrorMessage(error);
          }

          if (approvalError) {
            classification = "pairing_required_unresolved";
            detail = approvalError;
          } else if (!approvalExecution) {
            classification = "pairing_required_unresolved";
            detail =
              "Detected pairing required, but no matching local node-host pending request was found for auto-approval.";
          } else if (approvalExecution.exitCode !== 0) {
            classification = "pairing_required_unresolved";
            const signalInfo = approvalExecution.signal ? `, signal=${approvalExecution.signal}` : "";
            const stderr = approvalExecution.stderr.trim();
            detail = `${approvalExecution.command} exited with code ${String(approvalExecution.exitCode)}${signalInfo}${stderr ? `, stderr=${stderr}` : ""}`;
          } else {
            classification = "pairing_required_approved";
            ok = true;
            detail = `${approvalExecution.command} succeeded. Continuing websocket reconnect.`;
          }
        }

        if (ok) {
          this.consecutiveGatewayRecoveryFailures = 0;
          this.lastRecoverySuccessAt = this.now().toISOString();
          this.recoveryPhase = "reconnecting";
          this.recoveryStatus = "degraded";
          this.recoveryDetail = detail;
        } else {
          this.consecutiveGatewayRecoveryFailures += 1;
          this.lastRecoveryFailureAt = this.now().toISOString();
          if (this.consecutiveGatewayRecoveryFailures >= this.maxGatewayRecoveryAttempts) {
            this.recoveryPhase = "manual_attention";
            this.recoveryStatus = "manual_attention";
            this.recoveryDetail =
              `${detail} Reached ${this.consecutiveGatewayRecoveryFailures}/` +
              `${this.maxGatewayRecoveryAttempts} failed pairing recoveries.`;
          } else {
            this.recoveryPhase = "waiting_for_pairing";
            this.recoveryStatus = "pairing_required";
            this.recoveryDetail = `${detail} Continuing websocket reconnect attempts.`;
          }
        }
      } else if (!this.gatewayDetector) {
        detail = "Gateway detector is not configured for transport diagnostics.";
        this.recoveryPhase = "manual_attention";
        this.recoveryStatus = "manual_attention";
        this.recoveryDetail = `${detail} Cannot distinguish relay outage from local gateway health.`;
      } else {
        const probe = await this.gatewayDetector.detect();
        gatewayProbe = this.toRecoveryGatewayProbe(probe);
        this.lastGatewayProbe = cloneGatewayProbe(gatewayProbe);

        if (probe.ok) {
          classification = "relay_unreachable";
          detail =
            `Gateway probe is healthy (${probe.detail}), but websocket connect is still failing. ` +
            `Relay/backend connectivity appears unreachable. Last transport error: ${lastConnectError}`;
          this.recoveryPhase = "relay_unreachable";
          this.recoveryStatus = "relay_unreachable";
          this.recoveryDetail = detail;
        } else {
          this.recoveryPhase = "recovering_gateway";
          this.recoveryStatus = "recovering";
          this.recoveryDetail =
            `Gateway probe unhealthy (${probe.detail}). Attempting local OpenClaw runtime recovery.`;

          let forceManualAttention = false;
          if (!this.gatewayCommandRunner) {
            classification = "gateway_unhealthy_unresolved";
            detail =
              `Gateway probe unhealthy (${probe.detail}) but no restart command runner is configured. ` +
              "Cannot attempt local gateway recovery.";
          } else {
            let preflightStatus: GatewayCommandExecution | undefined;
            try {
              preflightStatus = await this.gatewayCommandRunner.status();
            } catch (error) {
              restartError = toErrorMessage(error);
            }

            const ambiguousPreflight = describeAmbiguousRuntimeExecution(preflightStatus);
            if (ambiguousPreflight) {
              classification = "gateway_unhealthy_unresolved";
              detail = ambiguousPreflight;
              forceManualAttention = true;
            } else {
              try {
                restartExecution = await this.gatewayCommandRunner.restart();
              } catch (error) {
                restartError = toErrorMessage(error);
              }

              const ambiguousRestart = describeAmbiguousRuntimeExecution(restartExecution);
              if (ambiguousRestart) {
                classification = "gateway_unhealthy_unresolved";
                detail = ambiguousRestart;
                forceManualAttention = true;
              } else if (restartError) {
                classification = "gateway_unhealthy_unresolved";
                detail = restartError;
              } else if (!restartExecution) {
                classification = "gateway_unhealthy_unresolved";
                detail = "Runtime restart did not return an execution result.";
              } else if (restartExecution.exitCode !== 0) {
                classification = "gateway_unhealthy_unresolved";
                const signalInfo = restartExecution.signal ? `, signal=${restartExecution.signal}` : "";
                const stderr = restartExecution.stderr.trim();
                detail =
                  `${restartExecution.command} exited with code ${String(restartExecution.exitCode)}${signalInfo}` +
                  `${stderr ? `, stderr=${stderr}` : ""}`;
              } else {
                const verifiedProbe = await this.gatewayDetector.detect();
                gatewayProbe = this.toRecoveryGatewayProbe(verifiedProbe);
                this.lastGatewayProbe = cloneGatewayProbe(gatewayProbe);
                if (verifiedProbe.ok) {
                  classification = "gateway_unhealthy_recovered";
                  ok = true;
                  detail = `Gateway recovered after ${restartExecution.command}. Continuing websocket reconnect.`;
                } else {
                  classification = "gateway_unhealthy_unresolved";
                  detail =
                    `${restartExecution.command} succeeded but gateway probe remains unhealthy: ${verifiedProbe.detail}`;
                }
              }
            }
          }

          if (ok) {
            this.consecutiveGatewayRecoveryFailures = 0;
            this.lastRecoverySuccessAt = this.now().toISOString();
            this.recoveryPhase = "reconnecting";
            this.recoveryStatus = "degraded";
            this.recoveryDetail = detail;
          } else {
            this.consecutiveGatewayRecoveryFailures += 1;
            this.lastRecoveryFailureAt = this.now().toISOString();
            if (forceManualAttention || this.consecutiveGatewayRecoveryFailures >= this.maxGatewayRecoveryAttempts) {
              this.recoveryPhase = "manual_attention";
              this.recoveryStatus = "manual_attention";
              this.recoveryDetail = forceManualAttention
                ? detail
                : `${detail} Reached ${this.consecutiveGatewayRecoveryFailures}/${this.maxGatewayRecoveryAttempts} failed local gateway recoveries.`;
            } else {
              this.recoveryPhase = "reconnecting";
              this.recoveryStatus = "degraded";
              this.recoveryDetail = `${detail} Continuing websocket reconnect attempts.`;
            }
          }
        }
      }
    } catch (error) {
      detail = `Transport recovery diagnosis failed: ${toErrorMessage(error)}`;
      this.recoveryPhase = "reconnecting";
      this.recoveryStatus = "degraded";
      this.recoveryDetail = detail;
    } finally {
      const completedAt = this.now().toISOString();
      this.pushRecoveryAttempt({
        id: attemptId,
        trigger: "consecutive_connect_failures",
        triggeredAt,
        completedAt,
        consecutiveConnectFailures: this.consecutiveConnectFailures,
        ok,
        classification,
        detail,
        ...(gatewayProbe ? { gatewayProbe: cloneGatewayProbe(gatewayProbe) } : {}),
        ...(restartExecution
          ? {
              restartCommand: restartExecution.command,
              restartExitCode: restartExecution.exitCode,
              restartSignal: restartExecution.signal,
              restartStdout: restartExecution.stdout,
              restartStderr: restartExecution.stderr
            }
          : {}),
        ...(restartError ? { restartError } : {}),
        ...(approvalExecution
          ? {
              approvalCommand: approvalExecution.command,
              approvalExitCode: approvalExecution.exitCode,
              approvalSignal: approvalExecution.signal,
              approvalStdout: approvalExecution.stdout,
              approvalStderr: approvalExecution.stderr
            }
          : {}),
        ...(approvalError ? { approvalError } : {})
      });
      this.recoveryInProgress = false;
    }
  }

  private pushRecoveryAttempt(record: TransportRecoveryAttemptRecord): void {
    this.recentRecoveryAttempts.unshift(record);
    if (this.recentRecoveryAttempts.length > this.recoveryHistoryLimit) {
      this.recentRecoveryAttempts.length = this.recoveryHistoryLimit;
    }
  }

  private handleRelayMessage(payload: Record<string, unknown>): void {
    const type = payload.type as string;

    switch (type) {
      case "message.start":
      case "message.delta":
      case "message.done":
      case "message.error":
      case "host.status": {
        const event = {
          ...payload,
          at: (payload.at as string) ?? new Date().toISOString()
        } as unknown as ConnectorEvent;
        this.resolveWaiters(event);
        break;
      }

      case "relay.forward_request":
      case "forwarded.request": {
        const request = payload.request as Record<string, unknown>;
        const forwardedRequest: ForwardedRequest = {
          requestId: (request.requestId as string) ?? randomUUID(),
          hostId: (request.hostId as string) ?? "",
          userId: (request.userId as string) ?? "",
          agentId: (request.agentId as string) ?? "",
          conversationId: (request.conversationId as string) ?? "",
          message: (request.message as string) ?? "",
          createdAt: (request.createdAt as string) ?? new Date().toISOString()
        };
        this.forwardedRequestHandler(forwardedRequest);
        break;
      }

      case "relay.forward_file_request": {
        const forwardedFileRequest = this.parseForwardedFileRequest(payload);
        if (!forwardedFileRequest) {
          console.log("[ws] Invalid relay.forward_file_request payload; skipping.");
          break;
        }
        this.forwardedFileRequestHandler(forwardedFileRequest);
        break;
      }

      default: {
        const hostUnbindControl = this.parseHostUnbindControl(type, payload);
        if (hostUnbindControl) {
          this.hostUnbindHandler(hostUnbindControl);
          break;
        }
        const gatewayRestartControl = this.parseGatewayRestartControl(type, payload);
        if (gatewayRestartControl) {
          this.gatewayRestartHandler(gatewayRestartControl);
          break;
        }
        console.log(`[ws] Unknown message type: ${type}`);
      }
    }
  }

  private parseForwardedFileRequest(payload: Record<string, unknown>): ForwardedFileRequest | undefined {
    const request = asRecord(payload.request);
    if (!request) {
      return undefined;
    }

    const operation = request.operation;
    if (!isAgentFilesOperation(operation)) {
      return undefined;
    }

    const requestId = readOptionalString(request.requestId) ?? randomUUID();
    const hostId = readOptionalString(request.hostId) ?? "";
    const userId = readOptionalString(request.userId) ?? "";
    const createdAt = readOptionalString(request.createdAt) ?? new Date().toISOString();
    const payloadRecord = asRecord(request.payload) ?? {};

    if (operation === "agents.files.list") {
      const agentId = readOptionalString(payloadRecord.agentId);
      return {
        requestId,
        hostId,
        userId,
        operation,
        payload: agentId ? { agentId } : {},
        createdAt
      };
    }

    if (operation === "agents.files.get") {
      const bridgePath = readRawString(payloadRecord.bridgePath) ?? "";
      const agentId = readOptionalString(payloadRecord.agentId);
      return {
        requestId,
        hostId,
        userId,
        operation,
        payload: {
          bridgePath,
          ...(agentId ? { agentId } : {})
        },
        createdAt
      };
    }

    const bridgePath = readRawString(payloadRecord.bridgePath) ?? "";
    const content = readRawString(payloadRecord.content) ?? "";
    const agentId = readOptionalString(payloadRecord.agentId);
    const expectedRevision = readOptionalString(payloadRecord.expectedRevision);
    const setPayload: AgentFilesSetRequestPayload = {
      bridgePath,
      content,
      ...(agentId ? { agentId } : {}),
      ...(expectedRevision ? { expectedRevision } : {})
    };

    return {
      requestId,
      hostId,
      userId,
      operation,
      payload: setPayload,
      createdAt
    };
  }

  private parseHostUnbindControl(type: string, payload: Record<string, unknown>): HostUnbindControl | undefined {
    const controlEnvelope = asRecord(payload.control) ?? asRecord(payload.payload) ?? {};
    const controlType = readOptionalString(payload.controlType) ?? readOptionalString(controlEnvelope.type);
    const matchesType = HOST_UNBIND_MESSAGE_TYPES.has(type);
    const matchesControlType =
      type === "relay.control" && controlType !== undefined && HOST_UNBIND_CONTROL_TYPES.has(controlType);
    if (!matchesType && !matchesControlType) {
      return undefined;
    }

    const hostId = readOptionalString(controlEnvelope.hostId) ?? readOptionalString(payload.hostId);
    if (!hostId) {
      return undefined;
    }

    const userId = readOptionalString(controlEnvelope.userId) ?? readOptionalString(payload.userId);
    const reason = readOptionalString(controlEnvelope.reason) ?? readOptionalString(payload.reason);
    const requestedAt =
      readOptionalString(controlEnvelope.requestedAt) ??
      readOptionalString(controlEnvelope.createdAt) ??
      readOptionalString(payload.at) ??
      new Date().toISOString();

    return {
      hostId,
      ...(userId ? { userId } : {}),
      ...(reason ? { reason } : {}),
      requestedAt
    };
  }

  private parseGatewayRestartControl(type: string, payload: Record<string, unknown>): GatewayRestartControl | undefined {
    const controlEnvelope = asRecord(payload.control) ?? asRecord(payload.payload) ?? {};
    const controlType = readOptionalString(payload.controlType) ?? readOptionalString(controlEnvelope.type);
    const matchesType = GATEWAY_RESTART_MESSAGE_TYPES.has(type);
    const matchesControlType =
      type === "relay.control" && controlType !== undefined && GATEWAY_RESTART_CONTROL_TYPES.has(controlType);
    if (!matchesType && !matchesControlType) {
      return undefined;
    }

    const hostId = readOptionalString(controlEnvelope.hostId) ?? readOptionalString(payload.hostId);
    if (!hostId) {
      return undefined;
    }

    const userId = readOptionalString(controlEnvelope.userId) ?? readOptionalString(payload.userId);
    const reason = readOptionalString(controlEnvelope.reason) ?? readOptionalString(payload.reason);
    const requestedAt =
      readOptionalString(controlEnvelope.requestedAt) ??
      readOptionalString(controlEnvelope.createdAt) ??
      readOptionalString(payload.at) ??
      new Date().toISOString();

    return {
      hostId,
      ...(userId ? { userId } : {}),
      ...(reason ? { reason } : {}),
      requestedAt
    };
  }

  async disconnect(reason?: string): Promise<void> {
    this.maxReconnectAttempts = 0; // Prevent reconnect on intentional disconnect
    this.intentionalDisconnect = true;
    if (this.reconnectTimer) {
      this.clearTimeoutImpl(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close(1000, reason ?? "Client disconnect");
      this.ws = null;
    }
    this.connected = false;
    this.reconnecting = false;
    this.context = null;

    for (const waiter of this.waiters) {
      this.clearTimeoutImpl(waiter.timeout);
      waiter.reject(new Error("Transport disconnected"));
    }
    this.waiters.length = 0;
  }

  async sendEvent(event: ConnectorEvent): Promise<void> {
    if (!this.connected || !this.ws) {
      throw new Error("WebSocket transport is not connected.");
    }

    const payload = {
      ...event,
      at: event.at ?? new Date().toISOString()
    };

    this.ws.send(JSON.stringify(payload));
    this.sentEvents.push(event);
    this.resolveWaiters(event);
  }

  isConnected(): boolean {
    return this.connected;
  }

  getConnectionContext(): BackendConnectionContext | null {
    return this.context ? { ...this.context } : null;
  }

  getSentEvents(): ConnectorEvent[] {
    return [...this.sentEvents];
  }

  async forwardRequest(request: ForwardedRequest): Promise<void> {
    if (!this.connected || !this.ws) {
      throw new Error("WebSocket transport is not connected.");
    }

    // Note: In real implementation, relay might not need this as it already has the request
    // But keeping for compatibility with interface
    this.ws.send(
      JSON.stringify({
        type: "forwarded.request",
        request
      })
    );
  }

  waitForEvent(
    predicate: (event: ConnectorEvent) => boolean,
    timeoutMs = 3000
  ): Promise<ConnectorEvent> {
    const matched = this.sentEvents.find(predicate);
    if (matched) {
      return Promise.resolve(matched);
    }

    return new Promise<ConnectorEvent>((resolve, reject) => {
      const timeout = this.setTimeoutImpl(() => {
        this.removeWaiter(resolve);
        reject(
          new Error(
            `Timed out waiting for connector event after ${timeoutMs}ms.`
          )
        );
      }, timeoutMs);

      this.waiters.push({ predicate, resolve, reject, timeout });
    });
  }

  private resolveWaiters(event: ConnectorEvent): void {
    const pending = [...this.waiters];
    for (const waiter of pending) {
      if (!waiter.predicate(event)) {
        continue;
      }
      this.clearTimeoutImpl(waiter.timeout);
      this.removeWaiter(waiter.resolve);
      waiter.resolve(event);
    }
  }

  private removeWaiter(resolve: (event: ConnectorEvent) => void): void {
    const idx = this.waiters.findIndex((w) => w.resolve === resolve);
    if (idx !== -1) {
      this.waiters.splice(idx, 1);
    }
  }

  onClose(callback: (reason: string) => void): void {
    this._onClose = callback;
  }
}
