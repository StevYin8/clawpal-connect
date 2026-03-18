import type { AgentDisplayStatus, ConnectorEventInput, HostConnectionStatus } from "./backend_client.js";
export interface AgentStatusProvider {
    agentId: string;
    displayStatus: AgentDisplayStatus;
    currentWorkTitle?: string;
    currentWorkSummary?: string;
    progressCurrent?: number;
    progressTotal?: number;
    hasPendingConfirmation?: boolean;
    hasActiveError?: boolean;
}
export interface HeartbeatStartOptions {
    hostId: string;
    sendEvent: (event: ConnectorEventInput) => Promise<void>;
    statusProvider?: () => HostConnectionStatus;
    detailProvider?: () => string | undefined;
    agentStatusProviders?: AgentStatusProvider[];
}
export interface HeartbeatManagerOptions {
    intervalMs?: number;
    onError?: (error: unknown) => void;
}
export declare class HeartbeatManager {
    private readonly intervalMs;
    private readonly onError;
    private timer;
    constructor(options?: HeartbeatManagerOptions);
    start(options: HeartbeatStartOptions): () => void;
    stop(): void;
}
