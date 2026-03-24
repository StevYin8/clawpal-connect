import { GatewayWatchdog } from "./gateway_watchdog.js";
import { HeartbeatManager } from "./heartbeat_manager.js";
import { OpenClawAgentFileBridgeService, OpenClawAgentFileRevisionConflictError } from "./openclaw_agent_file_bridge.js";
import { OpenClawSessionActivityMonitor } from "./openclaw_session_activity_monitor.js";
import { RuntimeWorker } from "./runtime_worker.js";
import { RuntimeStatusTracker, loadSyncedAgentIdsFromOpenClawConfig } from "./runtime_status_tracker.js";
export class ConnectorRuntime {
    hostRegistry;
    gatewayDetector;
    backendClient;
    runtimeWorker;
    fileBridgeService;
    heartbeatManager;
    gatewayWatchdog;
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
        this.fileBridgeService = options.fileBridgeService ?? new OpenClawAgentFileBridgeService();
        this.heartbeatManager = options.heartbeatManager ?? new HeartbeatManager();
        this.gatewayWatchdog = options.gatewayWatchdog ?? new GatewayWatchdog({
            gatewayDetector: this.gatewayDetector
        });
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
            gatewayRecovery: this.gatewayWatchdog.getSnapshot(),
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
        const stopGatewayWatchdog = this.gatewayWatchdog.start();
        try {
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
            const unsubscribeFileForwarding = this.backendClient.onForwardedFileRequest(async (request) => {
                if (request.hostId !== activeHost.hostId) {
                    return;
                }
                const response = await this.handleForwardedFileRequest(request);
                await this.backendClient.sendEvent(response);
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
                    unsubscribeFileForwarding();
                    stopSessionActivityMonitor();
                    stopHeartbeat();
                    stopGatewayWatchdog();
                    await this.backendClient.disconnect("connector.stop");
                }
            };
        }
        catch (error) {
            stopGatewayWatchdog();
            throw error;
        }
    }
    listTodoBoundaries() {
        return [
            "Official backend WebSocket/gRPC transport is not implemented in this repo yet.",
            "Host binding currently stores connector metadata locally in plain JSON.",
            "Runtime worker bridges forwarded requests to OpenClaw via Gateway/OpenResponses.",
            "OpenClaw agent file bridge is wired through relay.forward_file_request -> agents.files.response for agents.files.list/get/set."
        ];
    }
    async handleForwardedFileRequest(request) {
        try {
            const result = await this.executeForwardedFileRequest(request);
            return {
                type: "agents.files.response",
                requestId: request.requestId,
                hostId: request.hostId,
                operation: request.operation,
                ok: true,
                result
            };
        }
        catch (error) {
            return {
                type: "agents.files.response",
                requestId: request.requestId,
                hostId: request.hostId,
                operation: request.operation,
                ok: false,
                error: this.mapForwardedFileError(error)
            };
        }
    }
    async executeForwardedFileRequest(request) {
        if (request.operation === "agents.files.list") {
            return await this.fileBridgeService.listAgentFiles(request.payload);
        }
        if (request.operation === "agents.files.get") {
            return await this.fileBridgeService.readAgentFile(request.payload);
        }
        return await this.fileBridgeService.writeAgentFile(request.payload);
    }
    mapForwardedFileError(error) {
        if (error instanceof OpenClawAgentFileRevisionConflictError) {
            return {
                code: "conflict",
                message: error.message,
                details: {
                    bridgePath: error.bridgePath,
                    expectedRevision: error.expectedRevision,
                    ...(error.actualRevision ? { actualRevision: error.actualRevision } : {})
                }
            };
        }
        const message = error instanceof Error ? error.message : "Unknown connector file bridge error.";
        if (this.isFileNotFoundError(error, message)) {
            return { code: "not_found", message };
        }
        if (this.isFileValidationError(message)) {
            return { code: "validation_error", message };
        }
        if (this.isPermissionDeniedError(error)) {
            return { code: "permission_denied", message };
        }
        return { code: "internal_error", message };
    }
    isFileNotFoundError(error, message) {
        const code = error?.code;
        if (code === "ENOENT" || code === "ENOTDIR") {
            return true;
        }
        return message.toLowerCase().includes("not found");
    }
    isPermissionDeniedError(error) {
        const code = error?.code;
        return code === "EACCES" || code === "EPERM";
    }
    isFileValidationError(message) {
        const normalized = message.toLowerCase();
        return (normalized.includes("invalid bridgepath") ||
            normalized.includes("unsupported") ||
            normalized.includes("cannot be empty") ||
            normalized.includes("path escapes allowed root"));
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