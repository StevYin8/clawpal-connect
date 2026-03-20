import WebSocket from "ws";
import { randomUUID } from "node:crypto";
const AGENT_FILES_OPERATIONS = [
    "agents.files.list",
    "agents.files.get",
    "agents.files.set"
];
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
    ws = null;
    context = null;
    connected = false;
    forwardedRequestHandler = async () => { };
    forwardedFileRequestHandler = async () => { };
    sentEvents = [];
    waiters = [];
    reconnectAttempts = 0;
    maxReconnectAttempts = Number.POSITIVE_INFINITY;
    reconnectDelayMs = 1000;
    maxReconnectDelayMs = 30000;
    reconnectTimer = null;
    reconnecting = false;
    intentionalDisconnect = false;
    socketGeneration = 0;
    _onClose;
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
            clearTimeout(this.reconnectTimer);
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
                const ws = new WebSocket(wsUrl);
                this.ws = ws;
                let settled = false;
                const timeout = setTimeout(() => {
                    if (settled || this.ws !== ws || this.connected) {
                        return;
                    }
                    settled = true;
                    try {
                        ws.close();
                    }
                    catch { }
                    reject(new Error("Connection timeout"));
                }, 10000);
                ws.on("open", () => {
                    if (this.ws !== ws || generation !== this.socketGeneration) {
                        try {
                            ws.close(1000, "superseded");
                        }
                        catch { }
                        return;
                    }
                    settled = true;
                    clearTimeout(timeout);
                    console.log("[ws] Connected to relay server");
                    this.connected = true;
                    this.reconnecting = false;
                    this.reconnectAttempts = 0;
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
                    clearTimeout(timeout);
                    const reasonText = reason.toString();
                    console.log(`[ws] Connection closed: code=${code}, reason=${reasonText}`);
                    if (this.ws !== ws || generation !== this.socketGeneration) {
                        return;
                    }
                    this.connected = false;
                    this.ws = null;
                    this._onClose?.(reasonText);
                    this.scheduleReconnect();
                });
                ws.on("error", (err) => {
                    console.error("[ws] WebSocket error:", err.message);
                    if (!settled && this.ws === ws && generation === this.socketGeneration) {
                        settled = true;
                        clearTimeout(timeout);
                        reject(err);
                    }
                });
            }
            catch (err) {
                reject(err);
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
        console.log(`[ws] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${maxLabel})`);
        this.reconnectTimer = setTimeout(async () => {
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
            clearTimeout(this.reconnectTimer);
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
            clearTimeout(waiter.timeout);
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
            const timeout = setTimeout(() => {
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
            clearTimeout(waiter.timeout);
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