import { randomUUID } from "node:crypto";

import type {
  AgentFilesGetRequestPayload,
  AgentFilesListRequestPayload,
  AgentFilesOperation,
  AgentFilesSetRequestPayload,
  BackendConnectionContext,
  BackendTransport,
  ConnectorEvent,
  ForwardedFileRequest,
  ForwardedFileRequestHandler,
  ForwardedRequest,
  ForwardedRequestHandler
} from "./backend_client.js";

interface EventWaiter {
  predicate: (event: ConnectorEvent) => boolean;
  resolve: (event: ConnectorEvent) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export function createMockForwardedRequest(input: {
  hostId: string;
  userId: string;
  agentId?: string;
  message: string;
  requestId?: string;
  conversationId?: string;
  createdAt?: string;
}): ForwardedRequest {
  return {
    requestId: input.requestId ?? `req_${randomUUID()}`,
    hostId: input.hostId,
    userId: input.userId,
    agentId: input.agentId ?? "agent-default",
    conversationId: input.conversationId ?? `conv_${randomUUID()}`,
    message: input.message,
    createdAt: input.createdAt ?? new Date().toISOString()
  };
}

type MockForwardedFileRequestInput =
  | {
      hostId: string;
      userId: string;
      operation: "agents.files.list";
      payload?: AgentFilesListRequestPayload;
      requestId?: string;
      createdAt?: string;
    }
  | {
      hostId: string;
      userId: string;
      operation: "agents.files.get";
      payload: AgentFilesGetRequestPayload;
      requestId?: string;
      createdAt?: string;
    }
  | {
      hostId: string;
      userId: string;
      operation: "agents.files.set";
      payload: AgentFilesSetRequestPayload;
      requestId?: string;
      createdAt?: string;
    };

function normalizeFilePayload(
  operation: AgentFilesOperation,
  payload: AgentFilesListRequestPayload | AgentFilesGetRequestPayload | AgentFilesSetRequestPayload | undefined
): AgentFilesListRequestPayload | AgentFilesGetRequestPayload | AgentFilesSetRequestPayload {
  if (operation === "agents.files.list") {
    return payload ?? {};
  }
  if (operation === "agents.files.get") {
    return payload ?? { bridgePath: "" };
  }
  return payload ?? { bridgePath: "", content: "" };
}

export function createMockForwardedFileRequest(input: MockForwardedFileRequestInput): ForwardedFileRequest {
  const base = {
    requestId: input.requestId ?? `file_req_${randomUUID()}`,
    hostId: input.hostId,
    userId: input.userId,
    createdAt: input.createdAt ?? new Date().toISOString()
  };

  if (input.operation === "agents.files.list") {
    return {
      ...base,
      operation: input.operation,
      payload: normalizeFilePayload(input.operation, input.payload) as AgentFilesListRequestPayload
    };
  }

  if (input.operation === "agents.files.get") {
    return {
      ...base,
      operation: input.operation,
      payload: normalizeFilePayload(input.operation, input.payload) as AgentFilesGetRequestPayload
    };
  }

  return {
    ...base,
    operation: input.operation,
    payload: normalizeFilePayload(input.operation, input.payload) as AgentFilesSetRequestPayload
  };
}

export class MockBackendTransport implements BackendTransport {
  readonly name = "mock";

  private forwardedRequestHandler: ForwardedRequestHandler = async () => {
    return;
  };
  private forwardedFileRequestHandler: ForwardedFileRequestHandler = async () => {
    return;
  };
  private connected = false;
  private context: BackendConnectionContext | null = null;
  private readonly sentEvents: ConnectorEvent[] = [];
  private readonly waiters: EventWaiter[] = [];

  onForwardedRequest(handler: ForwardedRequestHandler): void {
    this.forwardedRequestHandler = handler;
  }

  onForwardedFileRequest(handler: ForwardedFileRequestHandler): void {
    this.forwardedFileRequestHandler = handler;
  }

  async connect(context: BackendConnectionContext): Promise<void> {
    this.context = context;
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.context = null;
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error("Mock backend transport disconnected before event arrived."));
    }
    this.waiters.length = 0;
  }

  async sendEvent(event: ConnectorEvent): Promise<void> {
    if (!this.connected) {
      throw new Error("Mock backend transport is not connected.");
    }

    this.sentEvents.push(event);
    this.resolveWaiters(event);
  }

  isConnected(): boolean {
    return this.connected;
  }

  getConnectionContext(): BackendConnectionContext | null {
    return this.context ? { ...this.context } : null;
  }

  getSentEvents(): ConnectorEvent[] {
    return [...this.sentEvents];
  }

  async forwardRequest(request: ForwardedRequest): Promise<void> {
    if (!this.connected) {
      throw new Error("Mock backend transport is not connected.");
    }
    await this.forwardedRequestHandler(request);
  }

  async forwardFileRequest(request: ForwardedFileRequest): Promise<void> {
    if (!this.connected) {
      throw new Error("Mock backend transport is not connected.");
    }
    await this.forwardedFileRequestHandler(request);
  }

  waitForEvent(predicate: (event: ConnectorEvent) => boolean, timeoutMs = 3_000): Promise<ConnectorEvent> {
    const matched = this.sentEvents.find(predicate);
    if (matched) {
      return Promise.resolve(matched);
    }

    return new Promise<ConnectorEvent>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.removeWaiter(resolve);
        reject(new Error(`Timed out waiting for connector event after ${timeoutMs}ms.`));
      }, timeoutMs);

      this.waiters.push({ predicate, resolve, reject, timeout });
    });
  }

  private resolveWaiters(event: ConnectorEvent): void {
    const pending = [...this.waiters];
    for (const waiter of pending) {
      if (!waiter.predicate(event)) {
        continue;
      }
      clearTimeout(waiter.timeout);
      this.removeWaiter(waiter.resolve);
      waiter.resolve(event);
    }
  }

  private removeWaiter(resolve: (event: ConnectorEvent) => void): void {
    const index = this.waiters.findIndex((item) => item.resolve === resolve);
    if (index >= 0) {
      this.waiters.splice(index, 1);
    }
  }
}
