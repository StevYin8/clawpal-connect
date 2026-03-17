import { BindingManager, type BindingState } from "./binding_manager.js";
import { GatewayDetector, type GatewayProbeResult } from "./gateway_detector.js";
import { PairingClient, type PairingProvider, type PairingSession } from "./pairing_client.js";
import { QrPresenter, type QrPresentation } from "./qr_presenter.js";
export interface HostRuntimeSnapshot {
    hostId: string;
    generatedAt: string;
    gateway: GatewayProbeResult;
    pairingSession: PairingSession;
    qr: QrPresentation;
    bindings: BindingState;
    todoBoundaries: string[];
}
export interface HostRuntimeOptions {
    gatewayBaseUrl?: string;
    gatewayToken?: string;
    gatewayTimeoutMs?: number;
    hostId?: string;
    pairingTtlMinutes?: number;
    fetchImpl?: typeof fetch;
    now?: () => Date;
    pairingProvider?: PairingProvider;
    bindingFilePath?: string;
    gatewayDetector?: GatewayDetector;
    pairingClient?: PairingClient;
    qrPresenter?: QrPresenter;
    bindingManager?: BindingManager;
}
export interface HeartbeatState {
    hostId: string;
    at: string;
}
export declare class HostRuntime {
    private readonly hostId;
    private readonly now;
    private readonly gatewayDetector;
    private readonly pairingClient;
    private readonly qrPresenter;
    private readonly bindingManager;
    constructor(options?: HostRuntimeOptions);
    createSnapshot(): Promise<HostRuntimeSnapshot>;
    startHeartbeat(intervalMs?: number, onTick?: (state: HeartbeatState) => void): () => void;
    private listTodoBoundaries;
}
