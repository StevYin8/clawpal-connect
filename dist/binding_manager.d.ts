export interface DeviceBinding {
    deviceId: string;
    deviceName: string;
    sessionId: string;
    boundAt: string;
}
export interface BindingState {
    hostId: string;
    devices: DeviceBinding[];
    updatedAt: string;
}
export declare function resolveDefaultBindingFilePath(): string;
export declare function createEmptyBindingState(hostId: string, now?: Date): BindingState;
export declare function upsertBinding(bindings: DeviceBinding[], incoming: DeviceBinding): DeviceBinding[];
export declare function removeBinding(bindings: DeviceBinding[], deviceId: string): DeviceBinding[];
interface BindingManagerOptions {
    filePath?: string;
    now?: () => Date;
}
export declare class BindingManager {
    private readonly filePath;
    private readonly now;
    constructor(options?: BindingManagerOptions);
    getStoreFilePath(): string;
    loadState(hostId: string): Promise<BindingState>;
    bindDevice(hostId: string, binding: DeviceBinding): Promise<BindingState>;
    unbindDevice(hostId: string, deviceId: string): Promise<BindingState>;
    private readStore;
    private writeStore;
}
export {};
