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

export interface HostUnbindControl {
  hostId: string;
  userId?: string;
  reason?: string;
  requestedAt: string;
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

export type ConnectorEvent =
  | HostStatusEvent
  | MessageStartEvent
  | MessageDeltaEvent
  | MessageDoneEvent
  | MessageErrorEvent
  | AgentRuntimeStatusEvent
  | AgentFilesResponseEvent;

export type ConnectorEventInput =
  | Omit<HostStatusEvent, "at">
  | Omit<MessageStartEvent, "at">
  | Omit<MessageDeltaEvent, "at">
  | Omit<MessageDoneEvent, "at">
  | Omit<MessageErrorEvent, "at">
  | Omit<AgentRuntimeStatusEvent, "at">
  | Omit<AgentFilesResponseOkEvent, "at">
  | Omit<AgentFilesResponseErrEvent, "at">;

export type ForwardedRequestHandler = (request: ForwardedRequest) => Promise<void> | void;
export type ForwardedFileRequestHandler = (request: ForwardedFileRequest) => Promise<void> | void;
export type HostUnbindHandler = (control: HostUnbindControl) => Promise<void> | void;

export type TransportRecoveryPhase =
  | "unsupported"
  | "idle"
  | "reconnecting"
  | "diagnosing"
  | "recovering_gateway"
  | "waiting_for_pairing"
  | "relay_unreachable"
  | "manual_attention";

export type TransportRecoveryStatus =
  | "unsupported"
  | "healthy"
  | "degraded"
  | "recovering"
  | "pairing_required"
  | "relay_unreachable"
  | "manual_attention";

export type TransportRecoveryAttemptClassification =
  | "relay_unreachable"
  | "gateway_unhealthy_recovered"
  | "gateway_unhealthy_unresolved"
  | "pairing_required_approved"
  | "pairing_required_unresolved"
  | "diagnostic_error";

export interface TransportRecoveryGatewayProbe {
  status: "online" | "unauthorized" | "offline" | "error";
  ok: boolean;
  detail: string;
  checkedAt: string;
  endpoint: string;
  latencyMs: number;
  httpStatus?: number;
}

export interface TransportRecoveryAttemptRecord {
  id: number;
  trigger: "consecutive_connect_failures";
  triggeredAt: string;
  completedAt: string;
  consecutiveConnectFailures: number;
  ok: boolean;
  classification: TransportRecoveryAttemptClassification;
  detail: string;
  gatewayProbe?: TransportRecoveryGatewayProbe;
  restartCommand?: string;
  restartExitCode?: number | null;
  restartSignal?: NodeJS.Signals | null;
  restartStdout?: string;
  restartStderr?: string;
  restartError?: string;
  approvalCommand?: string;
  approvalExitCode?: number | null;
  approvalSignal?: NodeJS.Signals | null;
  approvalStdout?: string;
  approvalStderr?: string;
  approvalError?: string;
}

export interface TransportRecoverySnapshot {
  supported: boolean;
  phase: TransportRecoveryPhase;
  status: TransportRecoveryStatus;
  detail: string;
  consecutiveFailureThreshold: number;
  consecutiveConnectFailures: number;
  consecutiveGatewayRecoveryFailures: number;
  maxGatewayRecoveryAttempts: number;
  reconnectAttempts: number;
  lastConnectSuccessAt?: string;
  lastConnectFailureAt?: string;
  lastFailureDetail?: string;
  lastSuccessDetail?: string;
  lastRecoverySuccessAt?: string;
  lastRecoveryFailureAt?: string;
  lastGatewayProbe?: TransportRecoveryGatewayProbe;
  recentRecoveryAttempts: TransportRecoveryAttemptRecord[];
}

export function createUnsupportedTransportRecoverySnapshot(
  detail = "Transport does not expose recovery diagnostics."
): TransportRecoverySnapshot {
  return {
    supported: false,
    phase: "unsupported",
    status: "unsupported",
    detail,
    consecutiveFailureThreshold: 0,
    consecutiveConnectFailures: 0,
    consecutiveGatewayRecoveryFailures: 0,
    maxGatewayRecoveryAttempts: 0,
    reconnectAttempts: 0,
    recentRecoveryAttempts: []
  };
}

export interface BackendTransport {
  readonly name: string;
  connect(context: BackendConnectionContext): Promise<void>;
  disconnect(reason?: string): Promise<void>;
  onForwardedRequest(handler: ForwardedRequestHandler): void;
  onForwardedFileRequest(handler: ForwardedFileRequestHandler): void;
  onHostUnbind(handler: HostUnbindHandler): void;
  sendEvent(event: ConnectorEvent): Promise<void>;
  getRecoverySnapshot?(): TransportRecoverySnapshot;
}

interface BackendClientOptions {
  transport: BackendTransport;
  now?: () => Date;
  onUnhandledRequestError?: (error: unknown) => void;
}

export class BackendClient {
  private readonly transport: BackendTransport;
  private readonly now: () => Date;
  private readonly onUnhandledRequestError: (error: unknown) => void;
  private readonly chatRequestListeners = new Set<ForwardedRequestHandler>();
  private readonly fileRequestListeners = new Set<ForwardedFileRequestHandler>();
  private readonly hostUnbindListeners = new Set<HostUnbindHandler>();
  private connected = false;

  constructor(options: BackendClientOptions) {
    this.transport = options.transport;
    this.now = options.now ?? (() => new Date());
    this.onUnhandledRequestError =
      options.onUnhandledRequestError ??
      ((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Unhandled forwarded request error: ${message}`);
      });

    this.transport.onForwardedRequest((request) => {
      void this.dispatchForwardedRequest(request).catch((error) => {
        this.onUnhandledRequestError(error);
      });
    });
    this.transport.onForwardedFileRequest((request) => {
      void this.dispatchForwardedFileRequest(request).catch((error) => {
        this.onUnhandledRequestError(error);
      });
    });
    this.transport.onHostUnbind((control) => {
      void this.dispatchHostUnbind(control).catch((error) => {
        this.onUnhandledRequestError(error);
      });
    });
  }

  getTransportName(): string {
    return this.transport.name;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getTransportRecoverySnapshot(): TransportRecoverySnapshot {
    return this.transport.getRecoverySnapshot?.() ?? createUnsupportedTransportRecoverySnapshot();
  }

  onForwardedRequest(listener: ForwardedRequestHandler): () => void {
    this.chatRequestListeners.add(listener);
    return () => {
      this.chatRequestListeners.delete(listener);
    };
  }

  onForwardedFileRequest(listener: ForwardedFileRequestHandler): () => void {
    this.fileRequestListeners.add(listener);
    return () => {
      this.fileRequestListeners.delete(listener);
    };
  }

  onHostUnbind(listener: HostUnbindHandler): () => void {
    this.hostUnbindListeners.add(listener);
    return () => {
      this.hostUnbindListeners.delete(listener);
    };
  }

  async connect(context: BackendConnectionContext): Promise<void> {
    if (this.connected) {
      return;
    }
    await this.transport.connect(context);
    this.connected = true;
  }

  async disconnect(reason = "connector.shutdown"): Promise<void> {
    if (!this.connected) {
      return;
    }
    await this.transport.disconnect(reason);
    this.connected = false;
  }

  async sendEvent(event: ConnectorEventInput): Promise<void> {
    if (!this.connected) {
      throw new Error("Backend client is not connected.");
    }

    const envelope: ConnectorEvent = {
      ...event,
      at: this.now().toISOString()
    };
    await this.transport.sendEvent(envelope);
  }

  private async dispatchForwardedRequest(request: ForwardedRequest): Promise<void> {
    for (const listener of this.chatRequestListeners) {
      await listener(request);
    }
  }

  private async dispatchForwardedFileRequest(request: ForwardedFileRequest): Promise<void> {
    for (const listener of this.fileRequestListeners) {
      await listener(request);
    }
  }

  private async dispatchHostUnbind(control: HostUnbindControl): Promise<void> {
    for (const listener of this.hostUnbindListeners) {
      await listener(control);
    }
  }
}

// TODO(official-backend): add auth refresh and reconnect strategy once backend contracts are finalized.
