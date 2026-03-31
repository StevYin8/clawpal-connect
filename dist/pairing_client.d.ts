import type { RuntimeConfigUpdate } from "./runtime_config.js";
export interface PairingResolveOptions {
    backendUrl: string;
    code: string;
    hostName?: string;
    fetchImpl?: typeof fetch;
    paths?: readonly string[];
}
export interface PairingSessionStartOptions {
    backendUrl: string;
    hostId: string;
    hostName?: string;
    connectorToken?: string;
    resetOwner?: boolean;
    fetchImpl?: typeof fetch;
    paths?: readonly string[];
}
export interface PairingSession {
    sessionId: string;
    code: string;
    backendUrl: string;
    hostId: string;
    hostName: string;
    createEndpoint: string;
    statusEndpoint: string;
    expiresAt?: string;
    pollAfterMs: number;
}
export interface PairingPendingUpdate {
    attempt: number;
    endpoint: string;
    pollAfterMs: number;
    status?: string;
    message?: string;
}
export interface WaitForPairingCompletionOptions {
    session: PairingSession;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    pollAfterMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    onPending?: (update: PairingPendingUpdate) => void | Promise<void>;
}
export interface PairingBindingConfig {
    hostId: string;
    userId: string;
    hostName: string;
    backendUrl: string;
    connectorToken?: string;
    bindingCode: string;
}
export interface PairingResolution {
    binding: PairingBindingConfig;
    runtimeConfig: RuntimeConfigUpdate;
    endpoint: string;
}
export declare function startPairingSession(options: PairingSessionStartOptions): Promise<PairingSession>;
export declare function waitForPairingCompletion(options: WaitForPairingCompletionOptions): Promise<PairingResolution>;
export declare function resolvePairingCode(options: PairingResolveOptions): Promise<PairingResolution>;
