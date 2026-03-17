export class HeartbeatManager {
    intervalMs;
    onError;
    timer = null;
    constructor(options = {}) {
        this.intervalMs = options.intervalMs ?? 30_000;
        this.onError = options.onError;
    }
    start(options) {
        if (this.timer) {
            throw new Error("Heartbeat manager is already running.");
        }
        const sendHeartbeat = async () => {
            const detail = options.detailProvider?.();
            await options.sendEvent({
                type: "host.status",
                hostId: options.hostId,
                status: options.statusProvider?.() ?? "online",
                ...(detail ? { detail } : {})
            });
        };
        void sendHeartbeat().catch((error) => {
            this.onError?.(error);
        });
        this.timer = setInterval(() => {
            void sendHeartbeat().catch((error) => {
                this.onError?.(error);
            });
        }, this.intervalMs);
        return () => this.stop();
    }
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
}
//# sourceMappingURL=heartbeat_manager.js.map