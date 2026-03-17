export type HostConnectionStatus = "online" | "offline" | "busy";
export interface BackendConnectionContext {
    backendUrl: string;
    hostId: string;
    userId: string;
    connectorToken?: string;
}
export interface ForwardedRequest {
    requestId: string;
    hostId: string;
    userId: string;
    conversationId: string;
    message: string;
    createdAt: string;
}
export interface HostStatusEvent {
    type: "host.status";
    hostId: string;
    status: HostConnectionStatus;
    detail?: string;
    at: string;
}
export interface MessageStartEvent {
    type: "message.start";
    requestId: string;
    hostId: string;
    userId: string;
    conversationId: string;
    at: string;
}
export interface MessageDeltaEvent {
    type: "message.delta";
    requestId: string;
    hostId: string;
    conversationId: string;
    sequence: number;
    delta: string;
    at: string;
}
export interface MessageDoneEvent {
    type: "message.done";
    requestId: string;
    hostId: string;
    conversationId: string;
    output: string;
    at: string;
}
export interface MessageErrorEvent {
    type: "message.error";
    requestId: string;
    hostId: string;
    conversationId: string;
    code: string;
    message: string;
    at: string;
}
export type ConnectorEvent = HostStatusEvent | MessageStartEvent | MessageDeltaEvent | MessageDoneEvent | MessageErrorEvent;
export type ConnectorEventInput = Omit<HostStatusEvent, "at"> | Omit<MessageStartEvent, "at"> | Omit<MessageDeltaEvent, "at"> | Omit<MessageDoneEvent, "at"> | Omit<MessageErrorEvent, "at">;
export type ForwardedRequestHandler = (request: ForwardedRequest) => Promise<void> | void;
export interface BackendTransport {
    readonly name: string;
    connect(context: BackendConnectionContext): Promise<void>;
    disconnect(reason?: string): Promise<void>;
    onForwardedRequest(handler: ForwardedRequestHandler): void;
    sendEvent(event: ConnectorEvent): Promise<void>;
}
interface BackendClientOptions {
    transport: BackendTransport;
    now?: () => Date;
    onUnhandledRequestError?: (error: unknown) => void;
}
export declare class BackendClient {
    private readonly transport;
    private readonly now;
    private readonly onUnhandledRequestError;
    private readonly listeners;
    private connected;
    constructor(options: BackendClientOptions);
    getTransportName(): string;
    isConnected(): boolean;
    onForwardedRequest(listener: ForwardedRequestHandler): () => void;
    connect(context: BackendConnectionContext): Promise<void>;
    disconnect(reason?: string): Promise<void>;
    sendEvent(event: ConnectorEventInput): Promise<void>;
    private dispatchForwardedRequest;
}
export {};
