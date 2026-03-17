export class BackendClient {
    transport;
    now;
    onUnhandledRequestError;
    listeners = new Set();
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
    }
    getTransportName() {
        return this.transport.name;
    }
    isConnected() {
        return this.connected;
    }
    onForwardedRequest(listener) {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
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
        for (const listener of this.listeners) {
            await listener(request);
        }
    }
}
// TODO(official-backend): add auth refresh and reconnect strategy once backend contracts are finalized.
//# sourceMappingURL=backend_client.js.map