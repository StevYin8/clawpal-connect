import { BackendClient } from "./backend_client.js";
import { GatewayDetector, type GatewayProbeResult } from "./gateway_detector.js";
import { HeartbeatManager } from "./heartbeat_manager.js";
import { HostRegistry, type HostRegistryState, type RegisteredHost } from "./host_registry.js";
import {
  OpenClawSessionActivityMonitor,
  type SessionActivityMonitor,
  type SessionActivityMonitorFactory
} from "./openclaw_session_activity_monitor.js";
import { RuntimeWorker } from "./runtime_worker.js";
import { RuntimeStatusTracker, loadSyncedAgentIdsFromOpenClawConfig, type SyncedAgentIdProvider } from "./runtime_status_tracker.js";

export interface ConnectorStatusSnapshot {
  generatedAt: string;
  gateway: GatewayProbeResult;
  registry: HostRegistryState;
  activeHost: RegisteredHost | null;
  todoBoundaries: string[];
}

export interface RunningConnector {
  host: RegisteredHost;
  startedAt: string;
  stop: () => Promise<void>;
}

interface ConnectorRuntimeOptions {
  hostRegistry: HostRegistry;
  gatewayDetector: GatewayDetector;
  backendClient: BackendClient;
  runtimeWorker?: RuntimeWorker;
  heartbeatManager?: HeartbeatManager;
  syncedAgentIdProvider?: SyncedAgentIdProvider;
  sessionActivityMonitorFactory?: SessionActivityMonitorFactory;
  now?: () => Date;
}

export class ConnectorRuntime {
  private readonly hostRegistry: HostRegistry;
  private readonly gatewayDetector: GatewayDetector;
  private readonly backendClient: BackendClient;
  private readonly runtimeWorker: RuntimeWorker;
  private readonly heartbeatManager: HeartbeatManager;
  private readonly syncedAgentIdProvider: SyncedAgentIdProvider;
  private readonly sessionActivityMonitorFactory: SessionActivityMonitorFactory;
  private readonly now: () => Date;

  constructor(options: ConnectorRuntimeOptions) {
    this.hostRegistry = options.hostRegistry;
    this.gatewayDetector = options.gatewayDetector;
    this.backendClient = options.backendClient;
    this.now = options.now ?? (() => new Date());
    this.syncedAgentIdProvider = options.syncedAgentIdProvider ?? loadSyncedAgentIdsFromOpenClawConfig;
    this.sessionActivityMonitorFactory =
      options.sessionActivityMonitorFactory ?? ((agentIds) => new OpenClawSessionActivityMonitor({ agentIds }));
    this.runtimeWorker =
      options.runtimeWorker ??
      new RuntimeWorker({
        gatewayProbe: () => this.gatewayDetector.detect()
      });
    this.heartbeatManager = options.heartbeatManager ?? new HeartbeatManager();
  }

  async createStatusSnapshot(): Promise<ConnectorStatusSnapshot> {
    const [gateway, registry, activeHost] = await Promise.all([
      this.gatewayDetector.detect(),
      this.hostRegistry.loadState(),
      this.hostRegistry.getActiveHost()
    ]);

    return {
      generatedAt: this.now().toISOString(),
      gateway,
      registry,
      activeHost,
      todoBoundaries: this.listTodoBoundaries()
    };
  }

  async start(): Promise<RunningConnector> {
    const activeHost = await this.hostRegistry.getActiveHost();
    if (!activeHost) {
      throw new Error("No active host binding found. Run `clawpal bind` first.");
    }

    const syncedAgentIds = await this.loadSyncedAgentIds();
    const runtimeStatusTracker = new RuntimeStatusTracker(syncedAgentIds);
    const sessionActivityMonitor = this.sessionActivityMonitorFactory(syncedAgentIds);

    await this.initializeSessionActivity(sessionActivityMonitor, runtimeStatusTracker);

    await this.backendClient.connect({
      backendUrl: activeHost.backendUrl,
      hostId: activeHost.hostId,
      userId: activeHost.userId,
      ...(activeHost.connectorToken ? { connectorToken: activeHost.connectorToken } : {})
    });

    const unsubscribeForwarding = this.backendClient.onForwardedRequest(async (request) => {
      if (request.hostId !== activeHost.hostId) {
        return;
      }

      runtimeStatusTracker.markForwardedRequestStarted(request);
      try {
        await this.runtimeWorker.handleForwardedRequest(request, async (event) => {
          await this.backendClient.sendEvent(event);
        });
      } finally {
        runtimeStatusTracker.markForwardedRequestCompleted(request.requestId);
      }
    });

    const stopSessionActivityMonitor = sessionActivityMonitor.start((activities) => {
      runtimeStatusTracker.updateOpenClawSessionActivities(activities);
    });

    const stopHeartbeat = this.heartbeatManager.start({
      hostId: activeHost.hostId,
      sendEvent: async (event) => {
        await this.backendClient.sendEvent(event);
      },
      statusProvider: () => (runtimeStatusTracker.hasActiveWork() ? "busy" : "online"),
      agentStatusProviders: runtimeStatusTracker.getAgentStatusProviders()
    });

    let stopped = false;
    return {
      host: activeHost,
      startedAt: this.now().toISOString(),
      stop: async () => {
        if (stopped) {
          return;
        }
        stopped = true;

        unsubscribeForwarding();
        stopSessionActivityMonitor();
        stopHeartbeat();
        await this.backendClient.disconnect("connector.stop");
      }
    };
  }

  private listTodoBoundaries(): string[] {
    return [
      "Official backend WebSocket/gRPC transport is not implemented in this repo yet.",
      "Host binding currently stores connector metadata locally in plain JSON.",
      "Runtime worker bridges forwarded requests to OpenClaw via Gateway/OpenResponses.",
      "OpenClaw agent file bridge service is implemented, but relay/app request wiring for agents.files.list/get/set is still pending."
    ];
  }

  private async loadSyncedAgentIds(): Promise<string[]> {
    try {
      return await this.syncedAgentIdProvider();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Failed to load synced agents from OpenClaw config: ${message}`);
      return [];
    }
  }

  private async initializeSessionActivity(
    monitor: SessionActivityMonitor,
    tracker: RuntimeStatusTracker
  ): Promise<void> {
    try {
      const activities = await monitor.refresh();
      tracker.updateOpenClawSessionActivities(activities);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Failed to load OpenClaw session activity: ${message}`);
      tracker.updateOpenClawSessionActivities([]);
    }
  }
}
