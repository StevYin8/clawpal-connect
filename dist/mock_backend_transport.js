import { randomUUID } from "node:crypto";
export function createMockForwardedRequest(input) {
    return {
        requestId: input.requestId ?? `req_${randomUUID()}`,
        hostId: input.hostId,
        userId: input.userId,
        conversationId: input.conversationId ?? `conv_${randomUUID()}`,
        message: input.message,
        createdAt: input.createdAt ?? new Date().toISOString()
    };
}
export class MockBackendTransport {
    name = "mock";
    forwardedRequestHandler = async () => {
        return;
    };
    connected = false;
    context = null;
    sentEvents = [];
    waiters = [];
    onForwardedRequest(handler) {
        this.forwardedRequestHandler = handler;
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