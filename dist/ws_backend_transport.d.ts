import type { BackendConnectionContext, BackendTransport, ConnectorEvent, ForwardedRequest, ForwardedRequestHandler } from "./backend_client.js";
export declare function resolveRelayWsBaseUrl(backendUrl: string): string;
/**
 * WebSocket-based backend transport for connecting to ClawPal relay server.
 */
export declare class WsBackendTransport implements BackendTransport {
    readonly name = "ws";
    private ws;
    private context;
    private connected;
    private forwardedRequestHandler;
    private readonly sentEvents;
    private readonly waiters;
    private reconnectAttempts;
    private maxReconnectAttempts;
    private reconnectDelayMs;
    private maxReconnectDelayMs;
    private reconnectTimer;
    private reconnecting;
    private intentionalDisconnect;
    private socketGeneration;
    private _onClose?;
    onForwardedRequest(handler: ForwardedRequestHandler): void;
    connect(context: BackendConnectionContext): Promise<void>;
    private scheduleReconnect;
    private handleRelayMessage;
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
