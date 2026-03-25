import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { OpenClawGatewayCommandRunner } from "./gateway_watchdog.js";
const AGENT_FILES_OPERATIONS = [
    "agents.files.list",
    "agents.files.get",
    "agents.files.set"
];
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 30_000;
const DEFAULT_RECOVERY_CONSECUTIVE_FAILURE_THRESHOLD = 3;
const DEFAULT_MAX_GATEWAY_RECOVERY_ATTEMPTS = 5;
const DEFAULT_RECOVERY_HISTORY_LIMIT = 20;
function normalizePositiveInt(value, fallback) {
    if (value === undefined || !Number.isFinite(value)) {
        return fallback;
    }
    const parsed = Math.trunc(value);
    return parsed > 0 ? parsed : fallback;
}
function normalizeNonNegativeInt(value, fallback) {
    if (value === undefined || !Number.isFinite(value)) {
        return fallback;
    }
    const parsed = Math.trunc(value);
    return parsed >= 0 ? parsed : fallback;
}
function toErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function cloneGatewayProbe(probe) {
    return { ...probe };
}
function cloneRecoveryAttempt(record) {
    return {
        ...record,
        ...(record.gatewayProbe ? { gatewayProbe: cloneGatewayProbe(record.gatewayProbe) } : {})
    };
}
function isAgentFilesOperation(value) {
    return typeof value === "string" && AGENT_FILES_OPERATIONS.includes(value);
}
function readOptionalString(value) {
    if (typeof value !== "string") {
        return undefined;
    }
    const normalized = value.trim();
    return normalized ? normalized : undefined;
}
function readRawString(value) {
    return typeof value === "string" ? value : undefined;
}
function asRecord(value) {
    if (typeof value !== "object" || value === null) {
        return undefined;
    }
    return value;
}
export function resolveRelayWsBaseUrl(backendUrl) {
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
export class WsBackendTransport {
    name = "ws";
    gatewayDetector;
    gatewayCommandRunner;
    connectTimeoutMs;
    reconnectDelayMs;
    maxReconnectDelayMs;
    recoveryConsecutiveFailureThreshold;
    maxGatewayRecoveryAttempts;
    recoveryHistoryLimit;
    now;
    setTimeoutImpl;
    clearTimeoutImpl;
    createWebSocket;
    ws = null;
    context = null;
    connected = false;
    forwardedRequestHandler = async () => { };
    forwardedFileRequestHandler = async () => { };
    sentEvents = [];
    waiters = [];
    recoveryPhase = "idle";
    recoveryStatus = "healthy";
    recoveryDetail = "WebSocket transport is healthy.";
    consecutiveConnectFailures = 0;
    consecutiveGatewayRecoveryFailures = 0;
    lastConnectSuccessAt;
    lastConnectFailureAt;
    lastFailureDetail;
    lastSuccessDetail;
    lastRecoverySuccessAt;
    lastRecoveryFailureAt;
    lastGatewayProbe;
    recoveryAttemptCounter = 0;
    recoveryInProgress = false;
    recentRecoveryAttempts = [];
    reconnectAttempts = 0;
    maxReconnectAttempts = Number.POSITIVE_INFINITY;
    reconnectTimer = null;
    reconnecting = false;
    intentionalDisconnect = false;
    socketGeneration = 0;
    _onClose;
    constructor(options = {}) {
        this.gatewayDetector = options.gatewayDetector;
        this.gatewayCommandRunner =
            options.gatewayCommandRunner ?? (this.gatewayDetector ? new OpenClawGatewayCommandRunner() : undefined);
        this.connectTimeoutMs = normalizePositiveInt(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS);
        this.reconnectDelayMs = normalizePositiveInt(options.reconnectDelayMs, DEFAULT_RECONNECT_DELAY_MS);
        this.maxReconnectDelayMs = normalizePositiveInt(options.maxReconnectDelayMs, DEFAULT_MAX_RECONNECT_DELAY_MS);
        this.recoveryConsecutiveFailureThreshold = normalizePositiveInt(options.recoveryConsecutiveFailureThreshold, DEFAULT_RECOVERY_CONSECUTIVE_FAILURE_THRESHOLD);
        this.maxGatewayRecoveryAttempts = normalizePositiveInt(options.maxGatewayRecoveryAttempts, DEFAULT_MAX_GATEWAY_RECOVERY_ATTEMPTS);
        this.recoveryHistoryLimit = normalizePositiveInt(options.recoveryHistoryLimit, DEFAULT_RECOVERY_HISTORY_LIMIT);
        this.now = options.now ?? (() => new Date());
        this.setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
        this.clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;
        this.createWebSocket = options.createWebSocket ?? ((url) => new WebSocket(url));
    }
    onForwardedRequest(handler) {
        this.forwardedRequestHandler = handler;
    }
    onForwardedFileRequest(handler) {
        this.forwardedFileRequestHandler = handler;
    }
    async connect(context) {
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
                const failConnect = (error) => {
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
                    }
                    catch { }
                    failConnect(new Error("Connection timeout"));
                }, this.connectTimeoutMs);
                ws.on("open", () => {
                    if (this.ws !== ws || generation !== this.socketGeneration) {
                        try {
                            ws.close(1000, "superseded");
                        }
                        catch { }
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
                ws.on("message", (data) => {
                    try {
                        const payload = JSON.parse(data.toString());
                        this.handleRelayMessage(payload);
                    }
                    catch (err) {
                        console.error("[ws] Failed to parse relay message:", err);
                    }
                });
                ws.on("close", (code, reason) => {
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
                ws.on("error", (err) => {
                    console.error("[ws] WebSocket error:", err.message);
                    failConnect(err);
                });
            }
            catch (err) {
                const wrapped = err instanceof Error ? err : new Error(String(err));
                this.recordConnectFailure(wrapped.message);
                reject(wrapped);
            }
        });
    }
    scheduleReconnect() {
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
                await this.connect(this.context);
            }
            catch (err) {
                console.error("[ws] Reconnect failed:", err);
                this.reconnecting = false;
                this.scheduleReconnect();
                return;
            }
            this.reconnecting = false;
        }, delay);
    }
    getRecoverySnapshot() {
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
    markConnectSuccess(detail) {
        const now = this.now().toISOString();
        this.consecutiveConnectFailures = 0;
        this.consecutiveGatewayRecoveryFailures = 0;
        this.lastConnectSuccessAt = now;
        this.lastSuccessDetail = detail;
        this.recoveryPhase = "idle";
        this.recoveryStatus = "healthy";
        this.recoveryDetail = detail;
    }
    recordConnectFailure(detail) {
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
    toRecoveryGatewayProbe(probe) {
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
    async runRecoveryDiagnosis(lastConnectError) {
        if (this.recoveryInProgress) {
            return;
        }
        this.recoveryInProgress = true;
        const attemptId = this.recoveryAttemptCounter + 1;
        this.recoveryAttemptCounter = attemptId;
        const triggeredAt = this.now().toISOString();
        let gatewayProbe;
        let restartExecution;
        let restartError;
        let classification = "diagnostic_error";
        let ok = false;
        let detail = "";
        try {
            if (!this.gatewayDetector) {
                detail = "Gateway detector is not configured for transport diagnostics.";
                this.recoveryPhase = "manual_attention";
                this.recoveryStatus = "manual_attention";
                this.recoveryDetail = `${detail} Cannot distinguish relay outage from local gateway health.`;
            }
            else {
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
                }
                else {
                    this.recoveryPhase = "recovering_gateway";
                    this.recoveryStatus = "recovering";
                    this.recoveryDetail =
                        `Gateway probe unhealthy (${probe.detail}). Attempting local OpenClaw runtime recovery.`;
                    if (!this.gatewayCommandRunner) {
                        classification = "gateway_unhealthy_unresolved";
                        detail =
                            `Gateway probe unhealthy (${probe.detail}) but no restart command runner is configured. ` +
                                "Cannot attempt local gateway recovery.";
                    }
                    else {
                        try {
                            restartExecution = await this.gatewayCommandRunner.restart();
                        }
                        catch (error) {
                            restartError = toErrorMessage(error);
                        }
                        if (restartError) {
                            classification = "gateway_unhealthy_unresolved";
                            detail = restartError;
                        }
                        else if (!restartExecution) {
                            classification = "gateway_unhealthy_unresolved";
                            detail = "Runtime restart did not return an execution result.";
                        }
                        else if (restartExecution.exitCode !== 0) {
                            classification = "gateway_unhealthy_unresolved";
                            const signalInfo = restartExecution.signal ? `, signal=${restartExecution.signal}` : "";
                            const stderr = restartExecution.stderr.trim();
                            detail =
                                `${restartExecution.command} exited with code ${String(restartExecution.exitCode)}${signalInfo}` +
                                    `${stderr ? `, stderr=${stderr}` : ""}`;
                        }
                        else {
                            const verifiedProbe = await this.gatewayDetector.detect();
                            gatewayProbe = this.toRecoveryGatewayProbe(verifiedProbe);
                            this.lastGatewayProbe = cloneGatewayProbe(gatewayProbe);
                            if (verifiedProbe.ok) {
                                classification = "gateway_unhealthy_recovered";
                                ok = true;
                                detail = `Gateway recovered after ${restartExecution.command}. Continuing websocket reconnect.`;
                            }
                            else {
                                classification = "gateway_unhealthy_unresolved";
                                detail =
                                    `${restartExecution.command} succeeded but gateway probe remains unhealthy: ${verifiedProbe.detail}`;
                            }
                        }
                    }
                    if (ok) {
                        this.consecutiveGatewayRecoveryFailures = 0;
                        this.lastRecoverySuccessAt = this.now().toISOString();
                        this.recoveryPhase = "reconnecting";
                        this.recoveryStatus = "degraded";
                        this.recoveryDetail = detail;
                    }
                    else {
                        this.consecutiveGatewayRecoveryFailures += 1;
                        this.lastRecoveryFailureAt = this.now().toISOString();
                        if (this.consecutiveGatewayRecoveryFailures >= this.maxGatewayRecoveryAttempts) {
                            this.recoveryPhase = "manual_attention";
                            this.recoveryStatus = "manual_attention";
                            this.recoveryDetail =
                                `${detail} Reached ${this.consecutiveGatewayRecoveryFailures}/` +
                                    `${this.maxGatewayRecoveryAttempts} failed local gateway recoveries.`;
                        }
                        else {
                            this.recoveryPhase = "reconnecting";
                            this.recoveryStatus = "degraded";
                            this.recoveryDetail = `${detail} Continuing websocket reconnect attempts.`;
                        }
                    }
                }
            }
        }
        catch (error) {
            detail = `Transport recovery diagnosis failed: ${toErrorMessage(error)}`;
            this.recoveryPhase = "reconnecting";
            this.recoveryStatus = "degraded";
            this.recoveryDetail = detail;
        }
        finally {
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
                ...(restartError ? { restartError } : {})
            });
            this.recoveryInProgress = false;
        }
    }
    pushRecoveryAttempt(record) {
        this.recentRecoveryAttempts.unshift(record);
        if (this.recentRecoveryAttempts.length > this.recoveryHistoryLimit) {
            this.recentRecoveryAttempts.length = this.recoveryHistoryLimit;
        }
    }
    handleRelayMessage(payload) {
        const type = payload.type;
        switch (type) {
            case "message.start":
            case "message.delta":
            case "message.done":
            case "message.error":
            case "host.status": {
                const event = {
                    ...payload,
                    at: payload.at ?? new Date().toISOString()
                };
                this.resolveWaiters(event);
                break;
            }
            case "relay.forward_request":
            case "forwarded.request": {
                const request = payload.request;
                const forwardedRequest = {
                    requestId: request.requestId ?? randomUUID(),
                    hostId: request.hostId ?? "",
                    userId: request.userId ?? "",
                    agentId: request.agentId ?? "",
                    conversationId: request.conversationId ?? "",
                    message: request.message ?? "",
                    createdAt: request.createdAt ?? new Date().toISOString()
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
            default:
                console.log(`[ws] Unknown message type: ${type}`);
        }
    }
    parseForwardedFileRequest(payload) {
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
        const setPayload = {
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
    async disconnect(reason) {
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
    async sendEvent(event) {
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
    isConnected() {
        return this.connected;
    }
    getConnectionContext() {
        return this.context ? { ...this.context } : null;
    }
    getSentEvents() {
        return [...this.sentEvents];
    }
    async forwardRequest(request) {
        if (!this.connected || !this.ws) {
            throw new Error("WebSocket transport is not connected.");
        }
        // Note: In real implementation, relay might not need this as it already has the request
        // But keeping for compatibility with interface
        this.ws.send(JSON.stringify({
            type: "forwarded.request",
            request
        }));
    }
    waitForEvent(predicate, timeoutMs = 3000) {
        const matched = this.sentEvents.find(predicate);
        if (matched) {
            return Promise.resolve(matched);
        }
        return new Promise((resolve, reject) => {
            const timeout = this.setTimeoutImpl(() => {
                this.removeWaiter(resolve);
                reject(new Error(`Timed out waiting for connector event after ${timeoutMs}ms.`));
            }, timeoutMs);
            this.waiters.push({ predicate, resolve, reject, timeout });
        });
    }
    resolveWaiters(event) {
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
    removeWaiter(resolve) {
        const idx = this.waiters.findIndex((w) => w.resolve === resolve);
        if (idx !== -1) {
            this.waiters.splice(idx, 1);
        }
    }
    onClose(callback) {
        this._onClose = callback;
    }
}
//# sourceMappingURL=ws_backend_transport.js.map