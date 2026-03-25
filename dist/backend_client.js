export function createUnsupportedTransportRecoverySnapshot(detail = "Transport does not expose recovery diagnostics.") {
    return {
        supported: false,
        phase: "unsupported",
        status: "unsupported",
        detail,
        consecutiveFailureThreshold: 0,
        consecutiveConnectFailures: 0,
        consecutiveGatewayRecoveryFailures: 0,
        maxGatewayRecoveryAttempts: 0,
        reconnectAttempts: 0,
        recentRecoveryAttempts: []
    };
}
export class BackendClient {
    transport;
    now;
    onUnhandledRequestError;
    chatRequestListeners = new Set();
    fileRequestListeners = new Set();
    connected = false;
    constructor(options) {
        this.transport = options.transport;
        this.now = options.now ?? (() => new Date());
        this.onUnhandledRequestError =
            options.onUnhandledRequestError ??
                ((error) => {
                    const message = error instanceof Error ? error.message : String(error);
                    console.error(`Unhandled forwarded request error: ${message}`);
                });
        this.transport.onForwardedRequest((request) => {
            void this.dispatchForwardedRequest(request).catch((error) => {
                this.onUnhandledRequestError(error);
            });
        });
        this.transport.onForwardedFileRequest((request) => {
            void this.dispatchForwardedFileRequest(request).catch((error) => {
                this.onUnhandledRequestError(error);
            });
        });
    }
    getTransportName() {
        return this.transport.name;
    }
    isConnected() {
        return this.connected;
    }
    getTransportRecoverySnapshot() {
        return this.transport.getRecoverySnapshot?.() ?? createUnsupportedTransportRecoverySnapshot();
    }
    onForwardedRequest(listener) {
        this.chatRequestListeners.add(listener);
        return () => {
            this.chatRequestListeners.delete(listener);
        };
    }
    onForwardedFileRequest(listener) {
        this.fileRequestListeners.add(listener);
        return () => {
            this.fileRequestListeners.delete(listener);
        };
    }
    async connect(context) {
        if (this.connected) {
            return;
        }
        await this.transport.connect(context);
        this.connected = true;
    }
    async disconnect(reason = "connector.shutdown") {
        if (!this.connected) {
            return;
        }
        await this.transport.disconnect(reason);
        this.connected = false;
    }
    async sendEvent(event) {
        if (!this.connected) {
            throw new Error("Backend client is not connected.");
        }
        const envelope = {
            ...event,
            at: this.now().toISOString()
        };
        await this.transport.sendEvent(envelope);
    }
    async dispatchForwardedRequest(request) {
        for (const listener of this.chatRequestListeners) {
            await listener(request);
        }
    }
    async dispatchForwardedFileRequest(request) {
        for (const listener of this.fileRequestListeners) {
            await listener(request);
        }
    }
}
// TODO(official-backend): add auth refresh and reconnect strategy once backend contracts are finalized.
//# sourceMappingURL=backend_client.js.map