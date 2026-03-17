import type { BackendConnectionContext, BackendTransport, ConnectorEvent, ForwardedRequest, ForwardedRequestHandler } from "./backend_client.js";
export declare function createMockForwardedRequest(input: {
    hostId: string;
    userId: string;
    message: string;
    requestId?: string;
    conversationId?: string;
    createdAt?: string;
}): ForwardedRequest;
export declare class MockBackendTransport implements BackendTransport {
    readonly name = "mock";
    private forwardedRequestHandler;
    private connected;
    private context;
    private readonly sentEvents;
    private readonly waiters;
    onForwardedRequest(handler: ForwardedRequestHandler): void;
    connect(context: BackendConnectionContext): Promise<void>;
    disconnect(): Promise<void>;
    sendEvent(event: ConnectorEvent): Promise<void>;
    isConnected(): boolean;
    getConnectionContext(): BackendConnectionContext | null;
    getSentEvents(): ConnectorEvent[];
    forwardRequest(request: ForwardedRequest): Promise<void>;
    waitForEvent(predicate: (event: ConnectorEvent) => boolean, timeoutMs?: number): Promise<ConnectorEvent>;
    private resolveWaiters;
    private removeWaiter;
}
