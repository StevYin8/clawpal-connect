import WebSocket, { Data } from "ws";
import { randomUUID } from "node:crypto";

import type {
  BackendConnectionContext,
  BackendTransport,
  ConnectorEvent,
  ForwardedRequest,
  ForwardedRequestHandler,
  HostConnectionStatus
} from "./backend_client.js";

interface EventWaiter {
  predicate: (event: ConnectorEvent) => boolean;
  resolve: (event: ConnectorEvent) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export function resolveRelayWsBaseUrl(backendUrl: string): string {
  const normalized = backendUrl.trim();
  if (!normalized) {
    throw new Error("backendUrl cannot be empty.");
  }

  const parsed = new URL(/^https?:\/\//i.test(normalized) ? normalized : `http://${normalized}`);
  const isSecure = parsed.protocol === "https:" || parsed.protocol === "wss:";
  const wsProtocol = isSecure ? "wss:" : "ws:";

  // ClawPal relay uses 3001 for HTTP API and 8788 for WS transport.
  if (parsed.port === "3001") {
    parsed.port = "8788";
  }

  parsed.protocol = wsProtocol;
  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

/**
 * WebSocket-based backend transport for connecting to ClawPal relay server.
 */
export class WsBackendTransport implements BackendTransport {
  readonly name = "ws";

  private ws: WebSocket | null = null;
  private context: BackendConnectionContext | null = null;
  private connected = false;
  private forwardedRequestHandler: ForwardedRequestHandler = async () => {};
  private readonly sentEvents: ConnectorEvent[] = [];
  private readonly waiters: EventWaiter[] = [];
  private reconnectAttempts = 0;
  private maxReconnectAttempts = Number.POSITIVE_INFINITY;
  private reconnectDelayMs = 1000;
  private maxReconnectDelayMs = 30000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnecting = false;
  private intentionalDisconnect = false;
  private socketGeneration = 0;
  private _onClose?: (reason: string) => void;

  onForwardedRequest(handler: ForwardedRequestHandler): void {
    this.forwardedRequestHandler = handler;
  }

  async connect(context: BackendConnectionContext): Promise<void> {
    this.context = context;
    this.intentionalDisconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const existing = this.ws;
    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const wsUrl = `${resolveRelayWsBaseUrl(context.backendUrl)}/ws/connector?hostId=${encodeURIComponent(context.hostId)}&userId=${encodeURIComponent(context.userId)}`;
    const generation = ++this.socketGeneration;

    return new Promise((resolve, reject) => {
      try {
        console.log(`[ws] Connecting to ${wsUrl}...`);
        const ws = new WebSocket(wsUrl);
        this.ws = ws;
        let settled = false;
        const timeout = setTimeout(() => {
          if (settled || this.ws !== ws || this.connected) {
            return;
          }
          settled = true;
          try {
            ws.close();
          } catch {}
          reject(new Error("Connection timeout"));
        }, 10000);

        ws.on("open", () => {
          if (this.ws !== ws || generation !== this.socketGeneration) {
            try {
              ws.close(1000, "superseded");
            } catch {}
            return;
          }
          settled = true;
          clearTimeout(timeout);
          console.log("[ws] Connected to relay server");
          this.connected = true;
          this.reconnecting = false;
          this.reconnectAttempts = 0;
          resolve();
        });

        ws.on("message", (data: Data) => {
          try {
            const payload = JSON.parse(data.toString());
            this.handleRelayMessage(payload);
          } catch (err) {
            console.error("[ws] Failed to parse relay message:", err);
          }
        });

        ws.on("close", (code: number, reason: Buffer) => {
          clearTimeout(timeout);
          const reasonText = reason.toString();
          console.log(`[ws] Connection closed: code=${code}, reason=${reasonText}`);
          if (this.ws !== ws || generation !== this.socketGeneration) {
            return;
          }
          this.connected = false;
          this.ws = null;
          this._onClose?.(reasonText);
          this.scheduleReconnect();
        });

        ws.on("error", (err: Error) => {
          console.error("[ws] WebSocket error:", err.message);
          if (!settled && this.ws === ws && generation === this.socketGeneration) {
            settled = true;
            clearTimeout(timeout);
            reject(err);
          }
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.intentionalDisconnect) {
      return;
    }
    if (!this.context) {
      console.log("[ws] No context for reconnect");
      return;
    }
    if (this.reconnecting || this.reconnectTimer) {
      return;
    }

    this.reconnecting = true;
    this.reconnectAttempts++;
    const delay = Math.min(this.reconnectDelayMs * Math.pow(2, this.reconnectAttempts - 1), this.maxReconnectDelayMs);
    const maxLabel = Number.isFinite(this.maxReconnectAttempts)
      ? String(this.maxReconnectAttempts)
      : '∞';
    console.log(`[ws] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${maxLabel})`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect(this.context!);
      } catch (err) {
        console.error("[ws] Reconnect failed:", err);
        this.reconnecting = false;
        this.scheduleReconnect();
        return;
      }
      this.reconnecting = false;
    }, delay);
  }

  private handleRelayMessage(payload: Record<string, unknown>): void {
    const type = payload.type as string;

    switch (type) {
      case "message.start":
      case "message.delta":
      case "message.done":
      case "message.error":
      case "host.status": {
        const event = {
          ...payload,
          at: (payload.at as string) ?? new Date().toISOString()
        } as unknown as ConnectorEvent;
        this.resolveWaiters(event);
        break;
      }

      case "relay.forward_request":
      case "forwarded.request": {
        const request = payload.request as Record<string, unknown>;
        const forwardedRequest: ForwardedRequest = {
          requestId: (request.requestId as string) ?? randomUUID(),
          hostId: (request.hostId as string) ?? "",
          userId: (request.userId as string) ?? "",
          agentId: (request.agentId as string) ?? "",
          conversationId: (request.conversationId as string) ?? "",
          message: (request.message as string) ?? "",
          createdAt: (request.createdAt as string) ?? new Date().toISOString()
        };
        this.forwardedRequestHandler(forwardedRequest);
        break;
      }

      default:
        console.log(`[ws] Unknown message type: ${type}`);
    }
  }

  async disconnect(reason?: string): Promise<void> {
    this.maxReconnectAttempts = 0; // Prevent reconnect on intentional disconnect
    this.intentionalDisconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close(1000, reason ?? "Client disconnect");
      this.ws = null;
    }
    this.connected = false;
    this.reconnecting = false;
    this.context = null;

    for (const waiter of this.waiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error("Transport disconnected"));
    }
    this.waiters.length = 0;
  }

  async sendEvent(event: ConnectorEvent): Promise<void> {
    if (!this.connected || !this.ws) {
      throw new Error("WebSocket transport is not connected.");
    }

    const payload = {
      ...event,
      at: event.at ?? new Date().toISOString()
    };

    this.ws.send(JSON.stringify(payload));
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
    if (!this.connected || !this.ws) {
      throw new Error("WebSocket transport is not connected.");
    }

    // Note: In real implementation, relay might not need this as it already has the request
    // But keeping for compatibility with interface
    this.ws.send(
      JSON.stringify({
        type: "forwarded.request",
        request
      })
    );
  }

  waitForEvent(
    predicate: (event: ConnectorEvent) => boolean,
    timeoutMs = 3000
  ): Promise<ConnectorEvent> {
    const matched = this.sentEvents.find(predicate);
    if (matched) {
      return Promise.resolve(matched);
    }

    return new Promise<ConnectorEvent>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.removeWaiter(resolve);
        reject(
          new Error(
            `Timed out waiting for connector event after ${timeoutMs}ms.`
          )
        );
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
    const idx = this.waiters.findIndex((w) => w.resolve === resolve);
    if (idx !== -1) {
      this.waiters.splice(idx, 1);
    }
  }

  onClose(callback: (reason: string) => void): void {
    this._onClose = callback;
  }
}