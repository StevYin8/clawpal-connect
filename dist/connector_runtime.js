import { GatewayWatchdog, OpenClawGatewayCommandRunner } from "./gateway_watchdog.js";
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
    gatewayCommandRunner;
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
        this.gatewayCommandRunner = options.gatewayCommandRunner ?? new OpenClawGatewayCommandRunner();
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
            transportRecovery: this.backendClient.getTransportRecoverySnapshot(),
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
            const unsubscribeHostUnbind = this.backendClient.onHostUnbind(async (control) => {
                if (control.hostId !== activeHost.hostId) {
                    return;
                }
                await this.hostRegistry.unbindHost(activeHost.hostId);
                const reasonSuffix = control.reason ? ` reason=${control.reason}` : "";
                console.log(`[connector] Host ${activeHost.hostId} was unbound remotely at ${control.requestedAt}.${reasonSuffix}`);
                await stopRuntime("connector.remote_host_unbound");
            });
            const unsubscribeGatewayRestart = this.backendClient.onGatewayRestart(async (control) => {
                if (control.hostId !== activeHost.hostId) {
                    return;
                }
                await this.handleGatewayRestartControl(control);
            });
            let stopSessionActivityMonitor = () => { };
            let stopHeartbeat = () => { };
            let stopped = false;
            let stopPromise;
            const stopRuntime = async (reason) => {
                if (stopped) {
                    await stopPromise;
                    return;
                }
                stopped = true;
                stopPromise = (async () => {
                    unsubscribeForwarding();
                    unsubscribeFileForwarding();
                    unsubscribeHostUnbind();
                    unsubscribeGatewayRestart();
                    stopSessionActivityMonitor();
                    stopHeartbeat();
                    stopGatewayWatchdog();
                    await this.backendClient.disconnect(reason);
                })();
                try {
                    await stopPromise;
                }
                finally {
                    stopPromise = undefined;
                }
            };
            stopSessionActivityMonitor = sessionActivityMonitor.start((activities) => {
                runtimeStatusTracker.updateOpenClawSessionActivities(activities);
            });
            stopHeartbeat = this.heartbeatManager.start({
                hostId: activeHost.hostId,
                sendEvent: async (event) => {
                    await this.backendClient.sendEvent(event);
                },
                statusProvider: () => (runtimeStatusTracker.hasActiveWork() ? "busy" : "online"),
                agentStatusProviders: runtimeStatusTracker.getAgentStatusProviders()
            });
            return {
                host: activeHost,
                startedAt: this.now().toISOString(),
                stop: async () => {
                    await stopRuntime("connector.stop");
                }
            };
        }
        catch (error) {
            stopGatewayWatchdog();
            throw error;
        }
    }
    async handleGatewayRestartControl(control) {
        const reasonSuffix = control.reason ? ` reason=${control.reason}` : "";
        console.log(`[connector] Relay requested local gateway restart for host ${control.hostId} at ${control.requestedAt}.${reasonSuffix}`);
        try {
            const execution = await this.gatewayCommandRunner.restart();
            const summary = this.describeGatewayCommandExecution(execution);
            if (execution.exitCode === 0 && execution.signal === null) {
                console.log(`[connector] Local gateway restart succeeded: ${summary}`);
                return;
            }
            console.error(`[connector] Local gateway restart failed: ${summary}`);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[connector] Local gateway restart failed: command threw ${message}`);
        }
    }
    describeGatewayCommandExecution(execution) {
        const parts = [
            `command=${execution.command}`,
            `exitCode=${execution.exitCode === null ? "null" : execution.exitCode}`,
            `signal=${execution.signal ?? "none"}`
        ];
        const stdout = execution.stdout.trim();
        if (stdout) {
            parts.push(`stdout=${JSON.stringify(stdout)}`);
        }
        const stderr = execution.stderr.trim();
        if (stderr) {
            parts.push(`stderr=${JSON.stringify(stderr)}`);
        }
        return parts.join(", ");
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