import type { ConnectorEventInput, HostConnectionStatus } from "./backend_client.js";

export interface HeartbeatStartOptions {
  hostId: string;
  sendEvent: (event: ConnectorEventInput) => Promise<void>;
  statusProvider?: () => HostConnectionStatus;
  detailProvider?: () => string | undefined;
}

export interface HeartbeatManagerOptions {
  intervalMs?: number;
  onError?: (error: unknown) => void;
}

export class HeartbeatManager {
  private readonly intervalMs: number;
  private readonly onError: ((error: unknown) => void) | undefined;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: HeartbeatManagerOptions = {}) {
    this.intervalMs = options.intervalMs ?? 30_000;
    this.onError = options.onError;
  }

  start(options: HeartbeatStartOptions): () => void {
    if (this.timer) {
      throw new Error("Heartbeat manager is already running.");
    }

    const sendHeartbeat = async () => {
      const detail = options.detailProvider?.();
      await options.sendEvent({
        type: "host.status",
        hostId: options.hostId,
        status: options.statusProvider?.() ?? "online",
        ...(detail ? { detail } : {})
      });
    };

    void sendHeartbeat().catch((error) => {
      this.onError?.(error);
    });

    this.timer = setInterval(() => {
      void sendHeartbeat().catch((error) => {
        this.onError?.(error);
      });
    }, this.intervalMs);

    return () => this.stop();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
