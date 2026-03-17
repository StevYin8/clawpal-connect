export interface RegisteredHost {
    hostId: string;
    userId: string;
    hostName: string;
    backendUrl: string;
    connectorToken?: string;
    bindingCode?: string;
    boundAt: string;
    updatedAt: string;
}
export interface HostRegistryState {
    activeHostId: string | null;
    hosts: Record<string, RegisteredHost>;
    updatedAt: string;
}
export interface BindHostRequest {
    hostId: string;
    userId: string;
    hostName: string;
    backendUrl: string;
    connectorToken?: string;
    bindingCode?: string;
}
interface HostRegistryOptions {
    filePath?: string;
    now?: () => Date;
}
export declare function resolveDefaultHostRegistryFilePath(): string;
export declare function createEmptyHostRegistryState(now?: Date): HostRegistryState;
export declare function upsertRegisteredHost(hosts: Record<string, RegisteredHost>, incoming: RegisteredHost): Record<string, RegisteredHost>;
export declare function removeRegisteredHost(hosts: Record<string, RegisteredHost>, hostId: string): Record<string, RegisteredHost>;
export declare class HostRegistry {
    private readonly filePath;
    private readonly now;
    constructor(options?: HostRegistryOptions);
    getStoreFilePath(): string;
    loadState(): Promise<HostRegistryState>;
    getActiveHost(): Promise<RegisteredHost | null>;
    bindHost(request: BindHostRequest): Promise<HostRegistryState>;
    unbindHost(hostId?: string): Promise<HostRegistryState>;
    private readStore;
    private writeStore;
}
export {};
