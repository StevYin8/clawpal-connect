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
    agentId: string;
    conversationId: string;
    message: string;
    createdAt: string;
}
export type AgentFilesOperation = "agents.files.list" | "agents.files.get" | "agents.files.set";
export interface AgentFilesListRequestPayload {
    agentId?: string;
}
export interface AgentFilesGetRequestPayload {
    agentId?: string;
    bridgePath: string;
}
export interface AgentFilesSetRequestPayload {
    agentId?: string;
    bridgePath: string;
    content: string;
    expectedRevision?: string;
}
interface ForwardedFileRequestBase {
    requestId: string;
    hostId: string;
    userId: string;
    createdAt: string;
}
export interface ForwardedFileListRequest extends ForwardedFileRequestBase {
    operation: "agents.files.list";
    payload: AgentFilesListRequestPayload;
}
export interface ForwardedFileGetRequest extends ForwardedFileRequestBase {
    operation: "agents.files.get";
    payload: AgentFilesGetRequestPayload;
}
export interface ForwardedFileSetRequest extends ForwardedFileRequestBase {
    operation: "agents.files.set";
    payload: AgentFilesSetRequestPayload;
}
export type ForwardedFileRequest = ForwardedFileListRequest | ForwardedFileGetRequest | ForwardedFileSetRequest;
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
export interface AgentFilesResponseError {
    code: string;
    message: string;
    details?: unknown;
}
export interface AgentFilesResponseOkEvent {
    type: "agents.files.response";
    requestId: string;
    hostId: string;
    operation: AgentFilesOperation;
    ok: true;
    result: unknown;
    at: string;
}
export interface AgentFilesResponseErrEvent {
    type: "agents.files.response";
    requestId: string;
    hostId: string;
    operation: AgentFilesOperation;
    ok: false;
    error: AgentFilesResponseError;
    at: string;
}
export type AgentFilesResponseEvent = AgentFilesResponseOkEvent | AgentFilesResponseErrEvent;
export type AgentDisplayStatus = "working" | "idle" | "waiting" | "error" | "offline" | "paused";
export interface AgentRuntimeStatusEvent {
    type: "agent.runtime.status";
    agentId: string;
    hostId: string;
    displayStatus: AgentDisplayStatus;
    currentWorkTitle?: string;
    currentWorkSummary?: string;
    progressCurrent?: number;
    progressTotal?: number;
    hasPendingConfirmation?: boolean;
    hasActiveError?: boolean;
    at: string;
}
export type ConnectorEvent = HostStatusEvent | MessageStartEvent | MessageDeltaEvent | MessageDoneEvent | MessageErrorEvent | AgentRuntimeStatusEvent | AgentFilesResponseEvent;
export type ConnectorEventInput = Omit<HostStatusEvent, "at"> | Omit<MessageStartEvent, "at"> | Omit<MessageDeltaEvent, "at"> | Omit<MessageDoneEvent, "at"> | Omit<MessageErrorEvent, "at"> | Omit<AgentRuntimeStatusEvent, "at"> | Omit<AgentFilesResponseOkEvent, "at"> | Omit<AgentFilesResponseErrEvent, "at">;
export type ForwardedRequestHandler = (request: ForwardedRequest) => Promise<void> | void;
export type ForwardedFileRequestHandler = (request: ForwardedFileRequest) => Promise<void> | void;
export interface BackendTransport {
    readonly name: string;
    connect(context: BackendConnectionContext): Promise<void>;
    disconnect(reason?: string): Promise<void>;
    onForwardedRequest(handler: ForwardedRequestHandler): void;
    onForwardedFileRequest(handler: ForwardedFileRequestHandler): void;
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
    private readonly chatRequestListeners;
    private readonly fileRequestListeners;
    private connected;
    constructor(options: BackendClientOptions);
    getTransportName(): string;
    isConnected(): boolean;
    onForwardedRequest(listener: ForwardedRequestHandler): () => void;
    onForwardedFileRequest(listener: ForwardedFileRequestHandler): () => void;
    connect(context: BackendConnectionContext): Promise<void>;
    disconnect(reason?: string): Promise<void>;
    sendEvent(event: ConnectorEventInput): Promise<void>;
    private dispatchForwardedRequest;
    private dispatchForwardedFileRequest;
}
export {};
