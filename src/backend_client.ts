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
  | AgentRuntimeStatusEvent;

export type ConnectorEventInput =
  | Omit<HostStatusEvent, "at">
  | Omit<MessageStartEvent, "at">
  | Omit<MessageDeltaEvent, "at">
  | Omit<MessageDoneEvent, "at">
  | Omit<MessageErrorEvent, "at">
  | Omit<AgentRuntimeStatusEvent, "at">;

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

export class BackendClient {
  private readonly transport: BackendTransport;
  private readonly now: () => Date;
  private readonly onUnhandledRequestError: (error: unknown) => void;
  private readonly listeners = new Set<ForwardedRequestHandler>();
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
  }

  getTransportName(): string {
    return this.transport.name;
  }

  isConnected(): boolean {
    return this.connected;
  }

  onForwardedRequest(listener: ForwardedRequestHandler): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
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
    for (const listener of this.listeners) {
      await listener(request);
    }
  }
}

// TODO(official-backend): add auth refresh and reconnect strategy once backend contracts are finalized.
