import type { AgentDisplayStatus, ConnectorEventInput, HostConnectionStatus } from "./backend_client.js";

export interface AgentStatusProvider {
  agentId: string;
  displayStatus: AgentDisplayStatus;
  currentWorkTitle?: string;
  currentWorkSummary?: string;
  progressCurrent?: number;
  progressTotal?: number;
  hasPendingConfirmation?: boolean;
  hasActiveError?: boolean;
}

export interface HeartbeatStartOptions {
  hostId: string;
  sendEvent: (event: ConnectorEventInput) => Promise<void>;
  statusProvider?: () => HostConnectionStatus;
  detailProvider?: () => string | undefined;
  agentStatusProviders?: AgentStatusProvider[];
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

      // Send agent runtime status for each provider
      const agentProviders = options.agentStatusProviders ?? [];
      for (const provider of agentProviders) {
        await options.sendEvent({
          type: "agent.runtime.status",
          agentId: provider.agentId,
          hostId: options.hostId,
          displayStatus: provider.displayStatus,
          ...(provider.currentWorkTitle ? { currentWorkTitle: provider.currentWorkTitle } : {}),
          ...(provider.currentWorkSummary ? { currentWorkSummary: provider.currentWorkSummary } : {}),
          ...(typeof provider.progressCurrent === "number" ? { progressCurrent: provider.progressCurrent } : {}),
          ...(typeof provider.progressTotal === "number" ? { progressTotal: provider.progressTotal } : {}),
          ...(provider.hasPendingConfirmation ? { hasPendingConfirmation: provider.hasPendingConfirmation } : {}),
          ...(provider.hasActiveError ? { hasActiveError: provider.hasActiveError } : {})
        });
      }
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
