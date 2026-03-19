import { BackendClient } from "./backend_client.js";
import { GatewayDetector, type GatewayProbeResult } from "./gateway_detector.js";
import { HeartbeatManager } from "./heartbeat_manager.js";
import { HostRegistry, type HostRegistryState, type RegisteredHost } from "./host_registry.js";
import { type SessionActivityMonitorFactory } from "./openclaw_session_activity_monitor.js";
import { RuntimeWorker } from "./runtime_worker.js";
import { type SyncedAgentIdProvider } from "./runtime_status_tracker.js";
export interface ConnectorStatusSnapshot {
    generatedAt: string;
    gateway: GatewayProbeResult;
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
    heartbeatManager?: HeartbeatManager;
    syncedAgentIdProvider?: SyncedAgentIdProvider;
    sessionActivityMonitorFactory?: SessionActivityMonitorFactory;
    now?: () => Date;
}
export declare class ConnectorRuntime {
    private readonly hostRegistry;
    private readonly gatewayDetector;
    private readonly backendClient;
    private readonly runtimeWorker;
    private readonly heartbeatManager;
    private readonly syncedAgentIdProvider;
    private readonly sessionActivityMonitorFactory;
    private readonly now;
    constructor(options: ConnectorRuntimeOptions);
    createStatusSnapshot(): Promise<ConnectorStatusSnapshot>;
    start(): Promise<RunningConnector>;
    private listTodoBoundaries;
    private loadSyncedAgentIds;
    private initializeSessionActivity;
}
export {};
