import { HeartbeatManager } from "./heartbeat_manager.js";
import { RuntimeWorker } from "./runtime_worker.js";
import { RuntimeStatusTracker, loadSyncedAgentIdsFromOpenClawConfig } from "./runtime_status_tracker.js";
export class ConnectorRuntime {
    hostRegistry;
    gatewayDetector;
    backendClient;
    runtimeWorker;
    heartbeatManager;
    syncedAgentIdProvider;
    now;
    constructor(options) {
        this.hostRegistry = options.hostRegistry;
        this.gatewayDetector = options.gatewayDetector;
        this.backendClient = options.backendClient;
        this.now = options.now ?? (() => new Date());
        this.syncedAgentIdProvider = options.syncedAgentIdProvider ?? loadSyncedAgentIdsFromOpenClawConfig;
        this.runtimeWorker =
            options.runtimeWorker ??
                new RuntimeWorker({
                    gatewayProbe: () => this.gatewayDetector.detect()
                });
        this.heartbeatManager = options.heartbeatManager ?? new HeartbeatManager();
    }
    async createStatusSnapshot() {
        const [gateway, registry, activeHost] = await Promise.all([
            this.gatewayDetector.detect(),
            this.hostRegistry.loadState(),
            this.hostRegistry.getActiveHost()
        ]);
        return {
            generatedAt: this.now().toISOString(),
            gateway,
            registry,
            activeHost,
            todoBoundaries: this.listTodoBoundaries()
        };
    }
    async start() {
        const activeHost = await this.hostRegistry.getActiveHost();
        if (!activeHost) {
            throw new Error("No active host binding found. Run `clawpal bind` first.");
        }
        const runtimeStatusTracker = new RuntimeStatusTracker(await this.loadSyncedAgentIds());
        await this.backendClient.connect({
            backendUrl: activeHost.backendUrl,
            hostId: activeHost.hostId,
            userId: activeHost.userId,
            ...(activeHost.connectorToken ? { connectorToken: activeHost.connectorToken } : {})
        });
        const unsubscribeForwarding = this.backendClient.onForwardedRequest(async (request) => {
            if (request.hostId !== activeHost.hostId) {
                return;
            }
            runtimeStatusTracker.markForwardedRequestStarted(request);
            try {
                await this.runtimeWorker.handleForwardedRequest(request, async (event) => {
                    await this.backendClient.sendEvent(event);
                });
            }
            finally {
                runtimeStatusTracker.markForwardedRequestCompleted(request.requestId);
            }
        });
        const stopHeartbeat = this.heartbeatManager.start({
            hostId: activeHost.hostId,
            sendEvent: async (event) => {
                await this.backendClient.sendEvent(event);
            },
            statusProvider: () => (runtimeStatusTracker.hasActiveWork() ? "busy" : "online"),
            agentStatusProviders: runtimeStatusTracker.getAgentStatusProviders()
        });
        let stopped = false;
        return {
            host: activeHost,
            startedAt: this.now().toISOString(),
            stop: async () => {
                if (stopped) {
                    return;
                }
                stopped = true;
                unsubscribeForwarding();
                stopHeartbeat();
                await this.backendClient.disconnect("connector.stop");
            }
        };
    }
    listTodoBoundaries() {
        return [
            "Official backend WebSocket/gRPC transport is not implemented in this repo yet.",
            "Host binding currently stores connector metadata locally in plain JSON.",
            "Runtime worker still uses a mock OpenClaw streaming bridge for demo flows."
        ];
    }
    async loadSyncedAgentIds() {
        try {
            return await this.syncedAgentIdProvider();
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.warn(`Failed to load synced agents from OpenClaw config: ${message}`);
            return [];
        }
    }
}
//# sourceMappingURL=connector_runtime.js.map