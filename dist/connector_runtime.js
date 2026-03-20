import { HeartbeatManager } from "./heartbeat_manager.js";
import { OpenClawSessionActivityMonitor } from "./openclaw_session_activity_monitor.js";
import { RuntimeWorker } from "./runtime_worker.js";
import { RuntimeStatusTracker, loadSyncedAgentIdsFromOpenClawConfig } from "./runtime_status_tracker.js";
export class ConnectorRuntime {
    hostRegistry;
    gatewayDetector;
    backendClient;
    runtimeWorker;
    heartbeatManager;
    syncedAgentIdProvider;
    sessionActivityMonitorFactory;
    now;
    constructor(options) {
        this.hostRegistry = options.hostRegistry;
        this.gatewayDetector = options.gatewayDetector;
        this.backendClient = options.backendClient;
        this.now = options.now ?? (() => new Date());
        this.syncedAgentIdProvider = options.syncedAgentIdProvider ?? loadSyncedAgentIdsFromOpenClawConfig;
        this.sessionActivityMonitorFactory =
            options.sessionActivityMonitorFactory ?? ((agentIds) => new OpenClawSessionActivityMonitor({ agentIds }));
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
        const syncedAgentIds = await this.loadSyncedAgentIds();
        const runtimeStatusTracker = new RuntimeStatusTracker(syncedAgentIds);
        const sessionActivityMonitor = this.sessionActivityMonitorFactory(syncedAgentIds);
        await this.initializeSessionActivity(sessionActivityMonitor, runtimeStatusTracker);
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
        const stopSessionActivityMonitor = sessionActivityMonitor.start((activities) => {
            runtimeStatusTracker.updateOpenClawSessionActivities(activities);
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
                stopSessionActivityMonitor();
                stopHeartbeat();
                await this.backendClient.disconnect("connector.stop");
            }
        };
    }
    listTodoBoundaries() {
        return [
            "Official backend WebSocket/gRPC transport is not implemented in this repo yet.",
            "Host binding currently stores connector metadata locally in plain JSON.",
            "Runtime worker bridges forwarded requests to OpenClaw via Gateway/OpenResponses."
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
    async initializeSessionActivity(monitor, tracker) {
        try {
            const activities = await monitor.refresh();
            tracker.updateOpenClawSessionActivities(activities);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.warn(`Failed to load OpenClaw session activity: ${message}`);
            tracker.updateOpenClawSessionActivities([]);
        }
    }
}
//# sourceMappingURL=connector_runtime.js.map