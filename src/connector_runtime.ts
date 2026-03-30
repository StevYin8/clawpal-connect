import type {
  AgentFilesGetRequestPayload,
  AgentFilesListRequestPayload,
  AgentFilesResponseErrEvent,
  AgentFilesResponseError,
  AgentFilesResponseOkEvent,
  AgentFilesSetRequestPayload,
  ForwardedFileRequest,
  TransportRecoverySnapshot
} from "./backend_client.js";
import { BackendClient } from "./backend_client.js";
import { GatewayDetector, type GatewayProbeResult } from "./gateway_detector.js";
import { GatewayWatchdog, type GatewayWatchdogLifecycle, type GatewayWatchdogSnapshot } from "./gateway_watchdog.js";
import { HeartbeatManager } from "./heartbeat_manager.js";
import { HostRegistry, type HostRegistryState, type RegisteredHost } from "./host_registry.js";
import {
  OpenClawAgentFileBridgeService,
  OpenClawAgentFileRevisionConflictError
} from "./openclaw_agent_file_bridge.js";
import {
  OpenClawSessionActivityMonitor,
  type SessionActivityMonitor,
  type SessionActivityMonitorFactory
} from "./openclaw_session_activity_monitor.js";
import { RuntimeWorker } from "./runtime_worker.js";
import { RuntimeStatusTracker, loadSyncedAgentIdsFromOpenClawConfig, type SyncedAgentIdProvider } from "./runtime_status_tracker.js";

interface ConnectorFileBridgeService {
  listAgentFiles(options: AgentFilesListRequestPayload): Promise<unknown>;
  readAgentFile(input: AgentFilesGetRequestPayload): Promise<unknown>;
  writeAgentFile(input: AgentFilesSetRequestPayload): Promise<unknown>;
}

export interface ConnectorStatusSnapshot {
  generatedAt: string;
  gateway: GatewayProbeResult;
  gatewayRecovery: GatewayWatchdogSnapshot;
  transportRecovery: TransportRecoverySnapshot;
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
  fileBridgeService?: ConnectorFileBridgeService;
  heartbeatManager?: HeartbeatManager;
  gatewayWatchdog?: GatewayWatchdogLifecycle;
  syncedAgentIdProvider?: SyncedAgentIdProvider;
  sessionActivityMonitorFactory?: SessionActivityMonitorFactory;
  now?: () => Date;
}

export class ConnectorRuntime {
  private readonly hostRegistry: HostRegistry;
  private readonly gatewayDetector: GatewayDetector;
  private readonly backendClient: BackendClient;
  private readonly runtimeWorker: RuntimeWorker;
  private readonly fileBridgeService: ConnectorFileBridgeService;
  private readonly heartbeatManager: HeartbeatManager;
  private readonly gatewayWatchdog: GatewayWatchdogLifecycle;
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
    this.fileBridgeService = options.fileBridgeService ?? new OpenClawAgentFileBridgeService();
    this.heartbeatManager = options.heartbeatManager ?? new HeartbeatManager();
    this.gatewayWatchdog = options.gatewayWatchdog ?? new GatewayWatchdog({
      gatewayDetector: this.gatewayDetector
    });
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
      gatewayRecovery: this.gatewayWatchdog.getSnapshot(),
      transportRecovery: this.backendClient.getTransportRecoverySnapshot(),
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
    const stopGatewayWatchdog = this.gatewayWatchdog.start();

    try {
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
      const unsubscribeFileForwarding = this.backendClient.onForwardedFileRequest(async (request) => {
        if (request.hostId !== activeHost.hostId) {
          return;
        }

        const response = await this.handleForwardedFileRequest(request);
        await this.backendClient.sendEvent(response);
      });
      const unsubscribeHostUnbind = this.backendClient.onHostUnbind(async (control) => {
        if (control.hostId !== activeHost.hostId) {
          return;
        }

        await this.hostRegistry.unbindHost(activeHost.hostId);
        const reasonSuffix = control.reason ? ` reason=${control.reason}` : "";
        console.log(
          `[connector] Host ${activeHost.hostId} was unbound remotely at ${control.requestedAt}.${reasonSuffix}`
        );
        await stopRuntime("connector.remote_host_unbound");
      });

      let stopSessionActivityMonitor = () => {};
      let stopHeartbeat = () => {};
      let stopped = false;
      let stopPromise: Promise<void> | undefined;
      const stopRuntime = async (reason: string): Promise<void> => {
        if (stopped) {
          await stopPromise;
          return;
        }
        stopped = true;

        stopPromise = (async () => {
          unsubscribeForwarding();
          unsubscribeFileForwarding();
          unsubscribeHostUnbind();
          stopSessionActivityMonitor();
          stopHeartbeat();
          stopGatewayWatchdog();
          await this.backendClient.disconnect(reason);
        })();

        try {
          await stopPromise;
        } finally {
          stopPromise = undefined;
        }
      };

      stopSessionActivityMonitor = sessionActivityMonitor.start((activities) => {
        runtimeStatusTracker.updateOpenClawSessionActivities(activities);
      });

      stopHeartbeat = this.heartbeatManager.start({
        hostId: activeHost.hostId,
        sendEvent: async (event) => {
          await this.backendClient.sendEvent(event);
        },
        statusProvider: () => (runtimeStatusTracker.hasActiveWork() ? "busy" : "online"),
        agentStatusProviders: runtimeStatusTracker.getAgentStatusProviders()
      });

      return {
        host: activeHost,
        startedAt: this.now().toISOString(),
        stop: async () => {
          await stopRuntime("connector.stop");
        }
      };
    } catch (error) {
      stopGatewayWatchdog();
      throw error;
    }
  }

  private listTodoBoundaries(): string[] {
    return [
      "Official backend WebSocket/gRPC transport is not implemented in this repo yet.",
      "Host binding currently stores connector metadata locally in plain JSON.",
      "Runtime worker bridges forwarded requests to OpenClaw via Gateway/OpenResponses.",
      "OpenClaw agent file bridge is wired through relay.forward_file_request -> agents.files.response for agents.files.list/get/set."
    ];
  }

  private async handleForwardedFileRequest(
    request: ForwardedFileRequest
  ): Promise<Omit<AgentFilesResponseOkEvent, "at"> | Omit<AgentFilesResponseErrEvent, "at">> {
    try {
      const result = await this.executeForwardedFileRequest(request);
      return {
        type: "agents.files.response",
        requestId: request.requestId,
        hostId: request.hostId,
        operation: request.operation,
        ok: true,
        result
      };
    } catch (error) {
      return {
        type: "agents.files.response",
        requestId: request.requestId,
        hostId: request.hostId,
        operation: request.operation,
        ok: false,
        error: this.mapForwardedFileError(error)
      };
    }
  }

  private async executeForwardedFileRequest(request: ForwardedFileRequest): Promise<unknown> {
    if (request.operation === "agents.files.list") {
      return await this.fileBridgeService.listAgentFiles(request.payload);
    }
    if (request.operation === "agents.files.get") {
      return await this.fileBridgeService.readAgentFile(request.payload);
    }
    return await this.fileBridgeService.writeAgentFile(request.payload);
  }

  private mapForwardedFileError(error: unknown): AgentFilesResponseError {
    if (error instanceof OpenClawAgentFileRevisionConflictError) {
      return {
        code: "conflict",
        message: error.message,
        details: {
          bridgePath: error.bridgePath,
          expectedRevision: error.expectedRevision,
          ...(error.actualRevision ? { actualRevision: error.actualRevision } : {})
        }
      };
    }

    const message = error instanceof Error ? error.message : "Unknown connector file bridge error.";
    if (this.isFileNotFoundError(error, message)) {
      return { code: "not_found", message };
    }
    if (this.isFileValidationError(message)) {
      return { code: "validation_error", message };
    }
    if (this.isPermissionDeniedError(error)) {
      return { code: "permission_denied", message };
    }

    return { code: "internal_error", message };
  }

  private isFileNotFoundError(error: unknown, message: string): boolean {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return true;
    }
    return message.toLowerCase().includes("not found");
  }

  private isPermissionDeniedError(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code === "EACCES" || code === "EPERM";
  }

  private isFileValidationError(message: string): boolean {
    const normalized = message.toLowerCase();
    return (
      normalized.includes("invalid bridgepath") ||
      normalized.includes("unsupported") ||
      normalized.includes("cannot be empty") ||
      normalized.includes("path escapes allowed root")
    );
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
