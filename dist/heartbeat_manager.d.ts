import type { ConnectorEventInput, HostConnectionStatus } from "./backend_client.js";
export interface HeartbeatStartOptions {
    hostId: string;
    sendEvent: (event: ConnectorEventInput) => Promise<void>;
    statusProvider?: () => HostConnectionStatus;
    detailProvider?: () => string | undefined;
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
