export declare const DEFAULT_RUNTIME_GATEWAY_URL = "http://127.0.0.1:18789";
export declare const DEFAULT_RUNTIME_HEARTBEAT_MS = 30000;
export interface ConnectorRuntimeConfig {
    transport: "ws";
    gatewayUrl: string;
    gatewayToken?: string;
    gatewayTimeoutMs: number;
    heartbeatMs: number;
    updatedAt: string;
}
interface RuntimeConfigStoreOptions {
    filePath?: string;
    now?: () => Date;
}
export interface RuntimeConfigUpdate {
    transport?: "ws";
    gatewayUrl?: string;
    gatewayToken?: string;
    gatewayTimeoutMs?: number;
    heartbeatMs?: number;
}
export declare function resolveDefaultRuntimeConfigFilePath(): string;
export declare function createDefaultRuntimeConfig(now?: Date): ConnectorRuntimeConfig;
export declare class RuntimeConfigStore {
    private readonly filePath;
    private readonly now;
    constructor(options?: RuntimeConfigStoreOptions);
    getStoreFilePath(): string;
    loadConfig(): Promise<ConnectorRuntimeConfig>;
    updateConfig(update: RuntimeConfigUpdate): Promise<ConnectorRuntimeConfig>;
    private readStore;
    private writeStore;
}
export {};
