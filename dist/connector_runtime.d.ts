import type { AgentFilesGetRequestPayload, AgentFilesListRequestPayload, AgentFilesSetRequestPayload } from "./backend_client.js";
import { BackendClient } from "./backend_client.js";
import { GatewayDetector, type GatewayProbeResult } from "./gateway_detector.js";
import { type GatewayWatchdogLifecycle, type GatewayWatchdogSnapshot } from "./gateway_watchdog.js";
import { HeartbeatManager } from "./heartbeat_manager.js";
import { HostRegistry, type HostRegistryState, type RegisteredHost } from "./host_registry.js";
import { type SessionActivityMonitorFactory } from "./openclaw_session_activity_monitor.js";
import { RuntimeWorker } from "./runtime_worker.js";
import { type SyncedAgentIdProvider } from "./runtime_status_tracker.js";
interface ConnectorFileBridgeService {
    listAgentFiles(options: AgentFilesListRequestPayload): Promise<unknown>;
    readAgentFile(input: AgentFilesGetRequestPayload): Promise<unknown>;
    writeAgentFile(input: AgentFilesSetRequestPayload): Promise<unknown>;
}
export interface ConnectorStatusSnapshot {
    generatedAt: string;
    gateway: GatewayProbeResult;
    gatewayRecovery: GatewayWatchdogSnapshot;
    registry: HostRegistryState;
    activeHost: RegisteredHost | null;
    todoBoundaries: string[];
}
export interface RunningConnector {
    host: RegisteredHost;
    startedAt: string;
    stop: () => Promise<void>;
}
interface ConnectorRuntimeOptions {
    hostRegistry: HostRegistry;
    gatewayDetector: GatewayDetector;
    backendClient: BackendClient;
    runtimeWorker?: RuntimeWorker;
    fileBridgeService?: ConnectorFileBridgeService;
    heartbeatManager?: HeartbeatManager;
    gatewayWatchdog?: GatewayWatchdogLifecycle;
    syncedAgentIdProvider?: SyncedAgentIdProvider;
    sessionActivityMonitorFactory?: SessionActivityMonitorFactory;
    now?: () => Date;
}
export declare class ConnectorRuntime {
    private readonly hostRegistry;
    private readonly gatewayDetector;
    private readonly backendClient;
    private readonly runtimeWorker;
    private readonly fileBridgeService;
    private readonly heartbeatManager;
    private readonly gatewayWatchdog;
    private readonly syncedAgentIdProvider;
    private readonly sessionActivityMonitorFactory;
    private readonly now;
    constructor(options: ConnectorRuntimeOptions);
    createStatusSnapshot(): Promise<ConnectorStatusSnapshot>;
    start(): Promise<RunningConnector>;
    private listTodoBoundaries;
    private handleForwardedFileRequest;
    private executeForwardedFileRequest;
    private mapForwardedFileError;
    private isFileNotFoundError;
    private isPermissionDeniedError;
    private isFileValidationError;
    private loadSyncedAgentIds;
    private initializeSessionActivity;
}
export {};
