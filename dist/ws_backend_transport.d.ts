import WebSocket from "ws";
import type { BackendConnectionContext, BackendTransport, ConnectorEvent, ForwardedFileRequestHandler, ForwardedRequest, ForwardedRequestHandler, HostUnbindHandler, TransportRecoverySnapshot } from "./backend_client.js";
import type { GatewayProbeResult } from "./gateway_detector.js";
import { type GatewayCommandRunner } from "./gateway_watchdog.js";
interface GatewayProbeDetector {
    detect(): Promise<GatewayProbeResult>;
}
export interface WsBackendTransportOptions {
    gatewayDetector?: GatewayProbeDetector;
    gatewayCommandRunner?: GatewayCommandRunner;
    connectTimeoutMs?: number;
    reconnectDelayMs?: number;
    maxReconnectDelayMs?: number;
    recoveryConsecutiveFailureThreshold?: number;
    maxGatewayRecoveryAttempts?: number;
    recoveryHistoryLimit?: number;
    now?: () => Date;
    setTimeoutImpl?: (callback: () => void, ms: number) => NodeJS.Timeout;
    clearTimeoutImpl?: (timer: NodeJS.Timeout) => void;
    createWebSocket?: (url: string) => WebSocket;
}
export declare function resolveRelayWsBaseUrl(backendUrl: string): string;
/**
 * WebSocket-based backend transport for connecting to ClawPal relay server.
 */
export declare class WsBackendTransport implements BackendTransport {
    readonly name = "ws";
    private readonly gatewayDetector;
    private readonly gatewayCommandRunner;
    private readonly connectTimeoutMs;
    private readonly reconnectDelayMs;
    private readonly maxReconnectDelayMs;
    private readonly recoveryConsecutiveFailureThreshold;
    private readonly maxGatewayRecoveryAttempts;
    private readonly recoveryHistoryLimit;
    private readonly now;
    private readonly setTimeoutImpl;
    private readonly clearTimeoutImpl;
    private readonly createWebSocket;
    private ws;
    private context;
    private connected;
    private forwardedRequestHandler;
    private forwardedFileRequestHandler;
    private hostUnbindHandler;
    private readonly sentEvents;
    private readonly waiters;
    private recoveryPhase;
    private recoveryStatus;
    private recoveryDetail;
    private consecutiveConnectFailures;
    private consecutiveGatewayRecoveryFailures;
    private lastConnectSuccessAt;
    private lastConnectFailureAt;
    private lastFailureDetail;
    private lastSuccessDetail;
    private lastRecoverySuccessAt;
    private lastRecoveryFailureAt;
    private lastGatewayProbe;
    private recoveryAttemptCounter;
    private recoveryInProgress;
    private readonly recentRecoveryAttempts;
    private reconnectAttempts;
    private maxReconnectAttempts;
    private reconnectTimer;
    private reconnecting;
    private intentionalDisconnect;
    private socketGeneration;
    private _onClose?;
    constructor(options?: WsBackendTransportOptions);
    onForwardedRequest(handler: ForwardedRequestHandler): void;
    onForwardedFileRequest(handler: ForwardedFileRequestHandler): void;
    onHostUnbind(handler: HostUnbindHandler): void;
    connect(context: BackendConnectionContext): Promise<void>;
    private scheduleReconnect;
    getRecoverySnapshot(): TransportRecoverySnapshot;
    private markConnectSuccess;
    private recordConnectFailure;
    private toRecoveryGatewayProbe;
    private runRecoveryDiagnosis;
    private pushRecoveryAttempt;
    private handleRelayMessage;
    private parseForwardedFileRequest;
    private parseHostUnbindControl;
    disconnect(reason?: string): Promise<void>;
    sendEvent(event: ConnectorEvent): Promise<void>;
    isConnected(): boolean;
    getConnectionContext(): BackendConnectionContext | null;
    getSentEvents(): ConnectorEvent[];
    forwardRequest(request: ForwardedRequest): Promise<void>;
    waitForEvent(predicate: (event: ConnectorEvent) => boolean, timeoutMs?: number): Promise<ConnectorEvent>;
    private resolveWaiters;
    private removeWaiter;
    onClose(callback: (reason: string) => void): void;
}
export {};
