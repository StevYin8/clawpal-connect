import type { AgentFilesGetRequestPayload, AgentFilesListRequestPayload, AgentFilesSetRequestPayload, BackendConnectionContext, BackendTransport, ConnectorEvent, ForwardedFileRequest, ForwardedFileRequestHandler, ForwardedRequest, ForwardedRequestHandler, HostUnbindControl, HostUnbindHandler } from "./backend_client.js";
export declare function createMockForwardedRequest(input: {
    hostId: string;
    userId: string;
    agentId?: string;
    message: string;
    requestId?: string;
    conversationId?: string;
    createdAt?: string;
}): ForwardedRequest;
type MockForwardedFileRequestInput = {
    hostId: string;
    userId: string;
    operation: "agents.files.list";
    payload?: AgentFilesListRequestPayload;
    requestId?: string;
    createdAt?: string;
} | {
    hostId: string;
    userId: string;
    operation: "agents.files.get";
    payload: AgentFilesGetRequestPayload;
    requestId?: string;
    createdAt?: string;
} | {
    hostId: string;
    userId: string;
    operation: "agents.files.set";
    payload: AgentFilesSetRequestPayload;
    requestId?: string;
    createdAt?: string;
};
export declare function createMockForwardedFileRequest(input: MockForwardedFileRequestInput): ForwardedFileRequest;
export declare function createMockHostUnbindControl(input: {
    hostId: string;
    userId?: string;
    reason?: string;
    requestedAt?: string;
}): HostUnbindControl;
export declare class MockBackendTransport implements BackendTransport {
    readonly name = "mock";
    private forwardedRequestHandler;
    private forwardedFileRequestHandler;
    private hostUnbindHandler;
    private connected;
    private context;
    private readonly sentEvents;
    private readonly waiters;
    onForwardedRequest(handler: ForwardedRequestHandler): void;
    onForwardedFileRequest(handler: ForwardedFileRequestHandler): void;
    onHostUnbind(handler: HostUnbindHandler): void;
    connect(context: BackendConnectionContext): Promise<void>;
    disconnect(): Promise<void>;
    sendEvent(event: ConnectorEvent): Promise<void>;
    isConnected(): boolean;
    getConnectionContext(): BackendConnectionContext | null;
    getSentEvents(): ConnectorEvent[];
    forwardRequest(request: ForwardedRequest): Promise<void>;
    forwardFileRequest(request: ForwardedFileRequest): Promise<void>;
    forwardHostUnbind(control: HostUnbindControl): Promise<void>;
    waitForEvent(predicate: (event: ConnectorEvent) => boolean, timeoutMs?: number): Promise<ConnectorEvent>;
    private resolveWaiters;
    private removeWaiter;
}
export {};
