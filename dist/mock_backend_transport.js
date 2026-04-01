import { randomUUID } from "node:crypto";
export function createMockForwardedRequest(input) {
    return {
        requestId: input.requestId ?? `req_${randomUUID()}`,
        hostId: input.hostId,
        userId: input.userId,
        agentId: input.agentId ?? "agent-default",
        conversationId: input.conversationId ?? `conv_${randomUUID()}`,
        message: input.message,
        createdAt: input.createdAt ?? new Date().toISOString()
    };
}
function normalizeFilePayload(operation, payload) {
    if (operation === "agents.files.list") {
        return payload ?? {};
    }
    if (operation === "agents.files.get") {
        return payload ?? { bridgePath: "" };
    }
    return payload ?? { bridgePath: "", content: "" };
}
export function createMockForwardedFileRequest(input) {
    const base = {
        requestId: input.requestId ?? `file_req_${randomUUID()}`,
        hostId: input.hostId,
        userId: input.userId,
        createdAt: input.createdAt ?? new Date().toISOString()
    };
    if (input.operation === "agents.files.list") {
        return {
            ...base,
            operation: input.operation,
            payload: normalizeFilePayload(input.operation, input.payload)
        };
    }
    if (input.operation === "agents.files.get") {
        return {
            ...base,
            operation: input.operation,
            payload: normalizeFilePayload(input.operation, input.payload)
        };
    }
    return {
        ...base,
        operation: input.operation,
        payload: normalizeFilePayload(input.operation, input.payload)
    };
}
export function createMockHostUnbindControl(input) {
    return {
        hostId: input.hostId,
        ...(input.userId ? { userId: input.userId } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
        requestedAt: input.requestedAt ?? new Date().toISOString()
    };
}
export function createMockGatewayRestartControl(input) {
    return {
        hostId: input.hostId,
        ...(input.userId ? { userId: input.userId } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
        requestedAt: input.requestedAt ?? new Date().toISOString()
    };
}
export class MockBackendTransport {
    name = "mock";
    forwardedRequestHandler = async () => {
        return;
    };
    forwardedFileRequestHandler = async () => {
        return;
    };
    hostUnbindHandler = async () => {
        return;
    };
    gatewayRestartHandler = async () => {
        return;
    };
    connected = false;
    context = null;
    sentEvents = [];
    waiters = [];
    onForwardedRequest(handler) {
        this.forwardedRequestHandler = handler;
    }
    onForwardedFileRequest(handler) {
        this.forwardedFileRequestHandler = handler;
    }
    onHostUnbind(handler) {
        this.hostUnbindHandler = handler;
    }
    onGatewayRestart(handler) {
        this.gatewayRestartHandler = handler;
    }
    async connect(context) {
        this.context = context;
        this.connected = true;
    }
    async disconnect() {
        this.connected = false;
        this.context = null;
        for (const waiter of this.waiters) {
            clearTimeout(waiter.timeout);
            waiter.reject(new Error("Mock backend transport disconnected before event arrived."));
        }
        this.waiters.length = 0;
    }
    async sendEvent(event) {
        if (!this.connected) {
            throw new Error("Mock backend transport is not connected.");
        }
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
        if (!this.connected) {
            throw new Error("Mock backend transport is not connected.");
        }
        await this.forwardedRequestHandler(request);
    }
    async forwardFileRequest(request) {
        if (!this.connected) {
            throw new Error("Mock backend transport is not connected.");
        }
        await this.forwardedFileRequestHandler(request);
    }
    async forwardHostUnbind(control) {
        if (!this.connected) {
            throw new Error("Mock backend transport is not connected.");
        }
        await this.hostUnbindHandler(control);
    }
    async forwardGatewayRestart(control) {
        if (!this.connected) {
            throw new Error("Mock backend transport is not connected.");
        }
        await this.gatewayRestartHandler(control);
    }
    waitForEvent(predicate, timeoutMs = 3_000) {
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
        const index = this.waiters.findIndex((item) => item.resolve === resolve);
        if (index >= 0) {
            this.waiters.splice(index, 1);
        }
    }
}
//# sourceMappingURL=mock_backend_transport.js.map