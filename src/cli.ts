#!/usr/bin/env node
import { Command, InvalidArgumentError } from "commander";

import { syncAgentsToRelay } from "./agent_sync.js";
import type { BackendConnectionContext, ConnectorEvent } from "./backend_client.js";
import { BackendClient } from "./backend_client.js";
import { ConnectorRuntime } from "./connector_runtime.js";
import { describeGatewayStatus, GatewayDetector } from "./gateway_detector.js";
import { HeartbeatManager } from "./heartbeat_manager.js";
import { HostRegistry } from "./host_registry.js";
import { createMockForwardedRequest, MockBackendTransport } from "./mock_backend_transport.js";
import { RuntimeWorker } from "./runtime_worker.js";
import { WsBackendTransport } from "./ws_backend_transport.js";
import { startLocalWebUi, type ConnectorDiagnosticsSnapshot } from "./web/local_web_ui.js";

interface RegistryCliOptions {
  registryFile: string;
}

interface GatewayCliOptions extends RegistryCliOptions {
  gateway: string;
  token: string;
  timeoutMs: number;
}

interface BindCliOptions extends RegistryCliOptions {
  hostId: string;
  hostName: string;
  userId: string;
  backendUrl: string;
  connectorToken?: string;
  bindingCode?: string;
}

interface StartCliOptions extends GatewayCliOptions {
  transport: string;
  backendUrl: string;
  heartbeatMs: number;
  webUi: boolean;
  webHost: string;
  webPort: number;
  durationMs?: number;
}

interface DemoCliOptions extends StartCliOptions {
  message: string;
  conversationId: string;
  autoBind: boolean;
  bindHostId: string;
  bindHostName: string;
  bindUserId: string;
  bindBackendUrl: string;
}

function parsePositiveInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("Value must be a positive integer.");
  }
  return parsed;
}

function parseTransport(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    throw new InvalidArgumentError("Transport cannot be empty.");
  }
  return normalized;
}

function withRegistryOption(command: Command): Command {
  return command.option(
    "--registry-file <path>",
    "Host registry file path",
    process.env.CLAWPAL_REGISTRY_FILE ?? ""
  );
}

function withGatewayOptions(command: Command): Command {
  return withRegistryOption(command)
    .option(
      "--gateway <url>",
      "OpenClaw gateway base URL",
      process.env.OPENCLAW_GATEWAY_URL ?? "http://127.0.0.1:3456"
    )
    .option("--token <token>", "OpenClaw gateway token", process.env.OPENCLAW_GATEWAY_TOKEN ?? "")
    .option("--timeout-ms <ms>", "Gateway probe timeout in milliseconds", parsePositiveInt, 8_000);
}

function withLifecycleOptions(command: Command): Command {
  return withGatewayOptions(command)
    .option("--transport <name>", "Backend transport adapter", parseTransport, "mock")
    .option("--backend-url <url>", "Official backend base URL", "http://127.0.0.1:3000")
    .option("--heartbeat-ms <ms>", "Heartbeat interval in milliseconds", parsePositiveInt, 30_000)
    .option("--web-ui", "Enable local diagnostics web UI", false)
    .option("--web-host <host>", "Local diagnostics web host", "127.0.0.1")
    .option("--web-port <port>", "Local diagnostics web port", parsePositiveInt, 8787)
    .option("--duration-ms <ms>", "Auto-stop after N milliseconds", parsePositiveInt);
}

function normalizeRegistryPath(path: string): string | undefined {
  const value = path.trim();
  return value || undefined;
}

function buildHostRegistry(options: RegistryCliOptions): HostRegistry {
  const registryFile = normalizeRegistryPath(options.registryFile);
  return new HostRegistry(registryFile ? { filePath: registryFile } : {});
}

function buildGatewayDetector(options: GatewayCliOptions): GatewayDetector {
  return new GatewayDetector({
    baseUrl: options.gateway,
    token: options.token,
    timeoutMs: options.timeoutMs
  });
}

function printGatewayLine(result: {
  status: string;
  detail: string;
  endpoint: string;
  latencyMs: number;
  httpStatus?: number;
}): void {
  const httpSuffix = result.httpStatus ? `, http=${result.httpStatus}` : "";
  console.log(
    `gateway status=${result.status}, latency=${result.latencyMs}ms${httpSuffix}\nendpoint=${result.endpoint}\ndetail=${result.detail}`
  );
}

function printStatusSnapshot(
  snapshot: Awaited<ReturnType<ConnectorRuntime["createStatusSnapshot"]>>,
  registryPath: string
): void {
  printGatewayLine(snapshot.gateway);
  if (!snapshot.gateway.ok) {
    console.log(`hint=${describeGatewayStatus(snapshot.gateway.status)}`);
  }

  console.log("");
  console.log(`registry file=${registryPath}`);
  if (!snapshot.activeHost) {
    console.log("active host=none");
    console.log("hint=Run `clawpal-connect bind` to register this connector host.");
  } else {
    console.log(`active host=${snapshot.activeHost.hostName} (${snapshot.activeHost.hostId})`);
    console.log(`user id=${snapshot.activeHost.userId}`);
    console.log(`backend url=${snapshot.activeHost.backendUrl}`);
    console.log(`bound at=${snapshot.activeHost.boundAt}`);
  }

  console.log("");
  console.log("TODO boundaries:");
  for (const boundary of snapshot.todoBoundaries) {
    console.log(`- ${boundary}`);
  }
}

function isRequestEvent(
  event: ConnectorEvent
): event is Exclude<ConnectorEvent, { type: "host.status" }> {
  return event.type !== "host.status";
}

function formatEventLine(event: ConnectorEvent): string {
  if (event.type === "host.status") {
    return `${event.at} ${event.type} status=${event.status} host=${event.hostId}`;
  }

  if (event.type === "message.delta") {
    return `${event.at} ${event.type} req=${event.requestId} seq=${event.sequence} delta=${JSON.stringify(event.delta)}`;
  }

  if (event.type === "message.done") {
    return `${event.at} ${event.type} req=${event.requestId} output=${JSON.stringify(event.output)}`;
  }

  if (event.type === "message.error") {
    return `${event.at} ${event.type} req=${event.requestId} code=${event.code} message=${JSON.stringify(event.message)}`;
  }

  return `${event.at} ${event.type} req=${event.requestId}`;
}

function createRuntimeForMockLifecycle(options: StartCliOptions): {
  transport: MockBackendTransport;
  runtime: ConnectorRuntime;
  registry: HostRegistry;
};

function createRuntimeForMockLifecycle(
  options: StartCliOptions,
  overrides: { forceGatewayOnline?: boolean }
): {
  transport: MockBackendTransport;
  runtime: ConnectorRuntime;
  registry: HostRegistry;
};

function createRuntimeForMockLifecycle(
  options: StartCliOptions,
  overrides: { forceGatewayOnline?: boolean } = {}
): {
  transport: MockBackendTransport;
  runtime: ConnectorRuntime;
  registry: HostRegistry;
} {
  if (options.transport !== "mock") {
    throw new Error("Only `--transport mock` is available in this repo right now. Official backend transport is TODO.");
  }

  const transport = new MockBackendTransport();
  const registry = buildHostRegistry(options);
  const gatewayDetector = buildGatewayDetector(options);
  const backendClient = new BackendClient({ transport });
  const runtimeWorker = overrides.forceGatewayOnline
    ? new RuntimeWorker({
        gatewayProbe: async () => ({
          status: "online",
          ok: true,
          detail: "Demo gateway probe bypass enabled.",
          checkedAt: new Date().toISOString(),
          endpoint: "demo://gateway",
          latencyMs: 0
        })
      })
    : undefined;
  const runtime = new ConnectorRuntime({
    hostRegistry: registry,
    gatewayDetector,
    backendClient,
    heartbeatManager: new HeartbeatManager({ intervalMs: options.heartbeatMs }),
    ...(runtimeWorker ? { runtimeWorker } : {})
  });

  return { transport, runtime, registry };
}

async function createRuntimeForWsLifecycle(
  options: StartCliOptions
): Promise<{
  transport: WsBackendTransport;
  runtime: ConnectorRuntime;
}> {
  if (!options.backendUrl) {
    throw new Error("--backend-url is required when using --transport ws");
  }

  const transport = new WsBackendTransport();
  const registry = buildHostRegistry(options);
  const gatewayDetector = buildGatewayDetector(options);

  // Get active host from registry or create default
  let activeHost = await registry.getActiveHost();
  if (!activeHost) {
    // Auto-bind a default host for demo purposes
    await registry.bindHost({
      hostId: "local-host",
      hostName: "Local Host",
      userId: "demo-user",
      backendUrl: options.backendUrl
    });
    activeHost = await registry.getActiveHost();
  }

  if (!activeHost) {
    throw new Error("Failed to get or create active host");
  }

  const backendClient = new BackendClient({ transport });

  // Connect to backend
  const connectContext: BackendConnectionContext = {
    backendUrl: options.backendUrl,
    hostId: activeHost.hostId,
    userId: activeHost.userId
  };
  if (process.env.CLAWPAL_CONNECTOR_TOKEN) {
    connectContext.connectorToken = process.env.CLAWPAL_CONNECTOR_TOKEN;
  }
  await transport.connect(connectContext);

  // Sync agents from OpenClaw config to relay
  const agentSyncResult = await syncAgentsToRelay({
    backendUrl: options.backendUrl,
    hostId: activeHost.hostId
  });
  if (agentSyncResult.synced > 0) {
    console.log(`[connector] Synced ${agentSyncResult.synced} agents from OpenClaw config to relay`);
  }

  const runtime = new ConnectorRuntime({
    hostRegistry: registry,
    gatewayDetector,
    backendClient,
    heartbeatManager: new HeartbeatManager({ intervalMs: options.heartbeatMs })
  });

  return { transport, runtime };
}

async function waitForShutdown(durationMs?: number): Promise<void> {
  if (durationMs) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, durationMs);
    });
    return;
  }

  await new Promise<void>((resolve) => {
    let closed = false;
    const finish = () => {
      if (closed) {
        return;
      }
      closed = true;
      resolve();
    };

    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}

async function runStatusCommand(options: GatewayCliOptions): Promise<void> {
  const transport = new MockBackendTransport();
  const runtime = new ConnectorRuntime({
    hostRegistry: buildHostRegistry(options),
    gatewayDetector: buildGatewayDetector(options),
    backendClient: new BackendClient({ transport })
  });

  const snapshot = await runtime.createStatusSnapshot();
  printStatusSnapshot(snapshot, buildHostRegistry(options).getStoreFilePath());

  if (!snapshot.gateway.ok || !snapshot.activeHost) {
    process.exitCode = 2;
  }
}

async function runBindCommand(options: BindCliOptions): Promise<void> {
  const registry = buildHostRegistry(options);
  const next = await registry.bindHost({
    hostId: options.hostId,
    hostName: options.hostName,
    userId: options.userId,
    backendUrl: options.backendUrl,
    ...(options.connectorToken?.trim() ? { connectorToken: options.connectorToken } : {}),
    ...(options.bindingCode?.trim() ? { bindingCode: options.bindingCode } : {})
  });

  const activeHost = next.activeHostId ? next.hosts[next.activeHostId] : null;
  if (!activeHost) {
    throw new Error("Failed to persist active host binding.");
  }

  console.log(`bound host=${activeHost.hostName} (${activeHost.hostId})`);
  console.log(`user id=${activeHost.userId}`);
  console.log(`backend url=${activeHost.backendUrl}`);
  console.log(`registry file=${registry.getStoreFilePath()}`);
  console.log("todo=official backend bind token issuance is not implemented in this repo yet.");
}

async function runStartCommand(options: StartCliOptions): Promise<void> {
  let transport;
  let runtime;

  if (options.transport === "ws") {
    const result = await createRuntimeForWsLifecycle(options);
    transport = result.transport;
    runtime = result.runtime;
  } else {
    const result = createRuntimeForMockLifecycle(options);
    transport = result.transport;
    runtime = result.runtime;
  }

  const statusSnapshot = await runtime.createStatusSnapshot();
  printStatusSnapshot(statusSnapshot, buildHostRegistry(options).getStoreFilePath());

  const running = await runtime.start();
  console.log("");
  console.log(`connector started for host=${running.host.hostId} via transport=${transport.name}`);

  let web: Awaited<ReturnType<typeof startLocalWebUi>> | undefined;
  if (options.webUi) {
    const getDiagnosticsSnapshot = (): ConnectorDiagnosticsSnapshot => {
      const events = transport.getSentEvents();
      const lastEvent = events.length > 0 ? events[events.length - 1] : undefined;
      return {
        generatedAt: new Date().toISOString(),
        status: statusSnapshot,
        backend: {
          transport: transport.name,
          connected: transport.isConnected(),
          sentEvents: events.length,
          ...(lastEvent ? { lastEvent } : {})
        }
      };
    };

    web = await startLocalWebUi(getDiagnosticsSnapshot, {
      host: options.webHost,
      port: options.webPort
    });
    console.log(`diagnostics web ui=${web.url}`);
  }

  console.log("Press Ctrl+C to stop.");

  try {
    await waitForShutdown(options.durationMs);
  } finally {
    if (web) {
      await web.close();
    }
    await running.stop();
  }
}

async function runDemoCommand(options: DemoCliOptions): Promise<void> {
  const { transport, runtime, registry } = createRuntimeForMockLifecycle(options, {
    forceGatewayOnline: true
  });

  let activeHost = await registry.getActiveHost();
  if (!activeHost && options.autoBind) {
    await registry.bindHost({
      hostId: options.bindHostId,
      hostName: options.bindHostName,
      userId: options.bindUserId,
      backendUrl: options.bindBackendUrl
    });
    activeHost = await registry.getActiveHost();
    console.log(`auto-bound demo host=${options.bindHostName} (${options.bindHostId})`);
  }

  if (!activeHost) {
    throw new Error("No active host binding found. Run `clawpal-connect bind` or pass `--auto-bind`.");
  }

  const running = await runtime.start();

  const request = createMockForwardedRequest({
    hostId: activeHost.hostId,
    userId: activeHost.userId,
    conversationId: options.conversationId,
    message: options.message
  });

  console.log(`demo forwarded request id=${request.requestId}`);
  console.log(`demo message=${JSON.stringify(request.message)}`);

  try {
    await transport.forwardRequest(request);
    await transport.waitForEvent(
      (event) =>
        isRequestEvent(event) &&
        event.requestId === request.requestId &&
        (event.type === "message.done" || event.type === "message.error"),
      5_000
    );

    const requestEvents = transport
      .getSentEvents()
      .filter((event) => event.type === "host.status" || (isRequestEvent(event) && event.requestId === request.requestId));

    console.log("demo event stream:");
    for (const event of requestEvents) {
      console.log(`- ${formatEventLine(event)}`);
    }
  } finally {
    await running.stop();
  }
}

const program = new Command();
program
  .name("clawpal-connect")
  .description("ClawPal hosted-relay connector CLI (official-backend transport still TODO)")
  .version("0.2.0");

withGatewayOptions(program.command("status").description("Print gateway + host registry status")).action(
  async (options: GatewayCliOptions) => {
    await runStatusCommand(options);
  }
);

withRegistryOption(program.command("bind").description("Bind local connector host metadata"))
  .requiredOption("--host-id <id>", "Connector host identifier", process.env.CLAWPAL_HOST_ID ?? "")
  .requiredOption("--host-name <name>", "Connector host display name", process.env.CLAWPAL_HOST_NAME ?? "")
  .requiredOption("--user-id <id>", "ClawPal user identifier", process.env.CLAWPAL_USER_ID ?? "")
  .requiredOption(
    "--backend-url <url>",
    "Official backend base URL",
    process.env.CLAWPAL_BACKEND_URL ?? "https://relay.clawpal.example"
  )
  .option("--connector-token <token>", "Connector token placeholder", process.env.CLAWPAL_CONNECTOR_TOKEN ?? "")
  .option("--binding-code <code>", "Bind code placeholder", process.env.CLAWPAL_BIND_CODE ?? "")
  .action(async (options: BindCliOptions) => {
    await runBindCommand(options);
  });

withLifecycleOptions(program.command("start").description("Start connector lifecycle loop")).action(
  async (options: StartCliOptions) => {
    await runStartCommand(options);
  }
);

withLifecycleOptions(
  program.command("demo").description("Run local mock relay demo (forwarded request -> streamed result)")
)
  .option("--message <text>", "Demo forwarded message text", "Run local relay demo")
  .option("--conversation-id <id>", "Demo conversation id", "demo-conversation")
  .option("--no-auto-bind", "Disable demo auto-bind")
  .option("--bind-host-id <id>", "Host id used by demo auto-bind", "demo-host")
  .option("--bind-host-name <name>", "Host name used by demo auto-bind", "Demo Host")
  .option("--bind-user-id <id>", "User id used by demo auto-bind", "demo-user")
  .option(
    "--bind-backend-url <url>",
    "Backend URL used by demo auto-bind",
    "https://relay.clawpal.example"
  )
  .action(async (options: DemoCliOptions) => {
    await runDemoCommand(options);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown CLI error";
  console.error(`clawpal-connect error: ${message}`);
  process.exit(1);
});
