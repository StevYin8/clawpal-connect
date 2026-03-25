#!/usr/bin/env node
import { hostname } from "node:os";
import { Command, InvalidArgumentError } from "commander";
import { syncAgentsToRelay } from "./agent_sync.js";
import { BackendClient } from "./backend_client.js";
import { ConnectorRuntime } from "./connector_runtime.js";
import { extractLocalGatewayDefaults, readOpenClawConfig } from "./openclaw_config.js";
import { describeGatewayStatus, GatewayDetector } from "./gateway_detector.js";
import { HeartbeatManager } from "./heartbeat_manager.js";
import { HostRegistry } from "./host_registry.js";
import { createMockForwardedRequest, MockBackendTransport } from "./mock_backend_transport.js";
import { startPairingSession, waitForPairingCompletion } from "./pairing_client.js";
import { DEFAULT_RUNTIME_GATEWAY_URL, DEFAULT_RUNTIME_HEARTBEAT_MS, RuntimeConfigStore } from "./runtime_config.js";
import { RuntimeWorker } from "./runtime_worker.js";
import { WsBackendTransport } from "./ws_backend_transport.js";
import { startLocalWebUi } from "./web/local_web_ui.js";
const DEFAULT_BACKEND_URL = "http://120.55.96.42:3001";
function parsePositiveInt(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new InvalidArgumentError("Value must be a positive integer.");
    }
    return parsed;
}
function parseTransport(value) {
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
        throw new InvalidArgumentError("Transport cannot be empty.");
    }
    return normalized;
}
function withRegistryOption(command) {
    return command.option("--registry-file <path>", "Host registry file path", process.env.CLAWPAL_REGISTRY_FILE ?? "");
}
function withRuntimeConfigOption(command) {
    return command.option("--runtime-config-file <path>", "Connector runtime defaults file path", process.env.CLAWPAL_RUNTIME_CONFIG_FILE ?? "");
}
function withGatewayOptions(command) {
    return withRegistryOption(command)
        .option("--gateway <url>", "OpenClaw gateway base URL", process.env.OPENCLAW_GATEWAY_URL ?? DEFAULT_RUNTIME_GATEWAY_URL)
        .option("--token <token>", "OpenClaw gateway token", process.env.OPENCLAW_GATEWAY_TOKEN ?? "")
        .option("--timeout-ms <ms>", "Gateway probe timeout in milliseconds", parsePositiveInt, 8_000);
}
function withLifecycleOptions(command) {
    return withGatewayOptions(command)
        .option("--transport <name>", "Backend transport adapter", parseTransport, "mock")
        .option("--backend-url <url>", "Official backend base URL", "http://127.0.0.1:3000")
        .option("--heartbeat-ms <ms>", "Heartbeat interval in milliseconds", parsePositiveInt, 30_000)
        .option("--web-ui", "Enable local diagnostics web UI", false)
        .option("--web-host <host>", "Local diagnostics web host", "127.0.0.1")
        .option("--web-port <port>", "Local diagnostics web port", parsePositiveInt, 8787)
        .option("--duration-ms <ms>", "Auto-stop after N milliseconds", parsePositiveInt);
}
function withPairOptions(command) {
    return withRuntimeConfigOption(withRegistryOption(command))
        .option("--backend-url <url>", "Official backend base URL", process.env.CLAWPAL_BACKEND_URL ?? DEFAULT_BACKEND_URL)
        .option("--host-name <name>", "Host display name used for pairing", process.env.CLAWPAL_HOST_NAME)
        .option("--gateway <url>", "Override OpenClaw gateway URL stored for run")
        .option("--token <token>", "Override OpenClaw gateway token stored for run")
        .option("--timeout-ms <ms>", "Gateway probe timeout stored for run", parsePositiveInt)
        .option("--heartbeat-ms <ms>", "Heartbeat interval stored for run", parsePositiveInt);
}
function withRunOptions(command) {
    return withRuntimeConfigOption(withRegistryOption(command))
        .option("--backend-url <url>", "Override backend URL (also used for first-time pairing when no local binding exists)")
        .option("--gateway <url>", "Override OpenClaw gateway URL for this run")
        .option("--token <token>", "Override OpenClaw gateway token for this run")
        .option("--timeout-ms <ms>", "Override gateway probe timeout for this run", parsePositiveInt)
        .option("--heartbeat-ms <ms>", "Override heartbeat interval for this run", parsePositiveInt)
        .option("--web-ui", "Enable local diagnostics web UI", false)
        .option("--web-host <host>", "Local diagnostics web host", "127.0.0.1")
        .option("--web-port <port>", "Local diagnostics web port", parsePositiveInt, 8787)
        .option("--duration-ms <ms>", "Auto-stop after N milliseconds", parsePositiveInt);
}
function normalizePath(path) {
    const value = path.trim();
    return value || undefined;
}
function normalizeOptional(value) {
    const normalized = value?.trim();
    return normalized ? normalized : undefined;
}
function resolveBackendUrl(value) {
    return (normalizeOptional(value) ??
        normalizeOptional(process.env.CLAWPAL_BACKEND_URL) ??
        DEFAULT_BACKEND_URL);
}
function deriveConnectorHostId() {
    const explicit = normalizeOptional(process.env.CLAWPAL_HOST_ID);
    if (explicit) {
        return explicit;
    }
    const raw = hostname().trim().toLowerCase();
    const normalized = raw
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 63);
    return normalized || "clawpal-host";
}
function buildHostRegistry(options) {
    const registryFile = normalizePath(options.registryFile);
    return new HostRegistry(registryFile ? { filePath: registryFile } : {});
}
function buildRuntimeConfigStore(options) {
    const runtimeConfigFile = normalizePath(options.runtimeConfigFile);
    return new RuntimeConfigStore(runtimeConfigFile ? { filePath: runtimeConfigFile } : {});
}
async function resolveLocalGatewayDefaults() {
    const config = await readOpenClawConfig();
    if (!config) {
        return {};
    }
    return extractLocalGatewayDefaults(config);
}
async function buildGatewayDetector(options) {
    const localDefaults = await resolveLocalGatewayDefaults();
    return new GatewayDetector({
        baseUrl: normalizeOptional(options.gateway) ??
            normalizeOptional(process.env.OPENCLAW_GATEWAY_URL) ??
            localDefaults.gatewayUrl ??
            DEFAULT_RUNTIME_GATEWAY_URL,
        token: normalizeOptional(options.token) ??
            normalizeOptional(process.env.OPENCLAW_GATEWAY_TOKEN) ??
            localDefaults.gatewayToken ??
            "",
        timeoutMs: options.timeoutMs
    });
}
function printGatewayLine(result) {
    const httpSuffix = result.httpStatus ? `, http=${result.httpStatus}` : "";
    console.log(`gateway status=${result.status}, latency=${result.latencyMs}ms${httpSuffix}\nendpoint=${result.endpoint}\ndetail=${result.detail}`);
}
function printStatusSnapshot(snapshot, registryPath) {
    printGatewayLine(snapshot.gateway);
    if (!snapshot.gateway.ok) {
        console.log(`hint=${describeGatewayStatus(snapshot.gateway.status)}`);
    }
    console.log("");
    console.log(`registry file=${registryPath}`);
    if (!snapshot.activeHost) {
        console.log("active host=none");
        console.log("hint=Run `clawpal run` to start pairing and register this connector host.");
    }
    else {
        console.log(`active host=${snapshot.activeHost.hostName} (${snapshot.activeHost.hostId})`);
        console.log(`user id=${snapshot.activeHost.userId}`);
        console.log(`backend url=${snapshot.activeHost.backendUrl}`);
        console.log(`bound at=${snapshot.activeHost.boundAt}`);
    }
    const gatewayRecovery = snapshot.gatewayRecovery;
    console.log("");
    console.log(`gateway recovery phase=${gatewayRecovery.phase}`);
    console.log(`gateway recovery failures=${gatewayRecovery.consecutiveProbeFailures}/${gatewayRecovery.consecutiveFailureThreshold}`);
    console.log(`gateway recovery restart failures=${gatewayRecovery.consecutiveRecoveryFailures}/${gatewayRecovery.maxRecoveryAttempts}`);
    if (gatewayRecovery.nextRecoveryAllowedAt) {
        console.log(`gateway recovery next retry at=${gatewayRecovery.nextRecoveryAllowedAt}`);
    }
    if (gatewayRecovery.lastRecoverySuccessAt) {
        console.log(`gateway recovery last success at=${gatewayRecovery.lastRecoverySuccessAt}`);
    }
    if (gatewayRecovery.lastRecoveryFailureAt) {
        console.log(`gateway recovery last failure at=${gatewayRecovery.lastRecoveryFailureAt}`);
    }
    const recentRecovery = gatewayRecovery.recentRecoveries[0];
    if (recentRecovery) {
        console.log(`gateway recovery latest=${recentRecovery.triggeredAt} ok=${recentRecovery.ok} detail=${recentRecovery.detail}`);
    }
    console.log("");
    console.log("TODO boundaries:");
    for (const boundary of snapshot.todoBoundaries) {
        console.log(`- ${boundary}`);
    }
}
function isRequestEvent(event) {
    return event.type !== "host.status" && event.type !== "agent.runtime.status";
}
function formatEventLine(event) {
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
    if (event.type === "agent.runtime.status") {
        return `${event.at} ${event.type} agent=${event.agentId} status=${event.displayStatus}`;
    }
    return `${event.at} ${event.type} req=${event.requestId}`;
}
function createRuntimeForMockLifecycle(options, overrides = {}) {
    if (options.transport !== "mock") {
        throw new Error("Only `--transport mock` is available in this repo right now. Official backend transport is TODO.");
    }
    const transport = new MockBackendTransport();
    const registry = buildHostRegistry(options);
    const gatewayDetector = new GatewayDetector({
        baseUrl: options.gateway,
        token: options.token,
        timeoutMs: options.timeoutMs,
    });
    const backendClient = new BackendClient({ transport });
    const runtimeWorker = new RuntimeWorker({
        gatewayProbe: overrides.forceGatewayOnline
            ? async () => ({
                status: "online",
                ok: true,
                detail: "Demo gateway probe bypass enabled.",
                checkedAt: new Date().toISOString(),
                endpoint: "demo://gateway",
                latencyMs: 0
            })
            : () => gatewayDetector.detect(),
        openClaw: {
            gatewayUrl: options.gateway,
            gatewayToken: options.token
        }
    });
    const runtime = new ConnectorRuntime({
        hostRegistry: registry,
        gatewayDetector,
        backendClient,
        heartbeatManager: new HeartbeatManager({ intervalMs: options.heartbeatMs }),
        runtimeWorker
    });
    return { transport, runtime, registry };
}
async function rebindActiveHost(registry, host, updates) {
    await registry.bindHost({
        hostId: host.hostId,
        hostName: host.hostName,
        userId: host.userId,
        backendUrl: updates.backendUrl,
        ...(updates.connectorToken ? { connectorToken: updates.connectorToken } : {}),
        ...(host.bindingCode ? { bindingCode: host.bindingCode } : {})
    });
    const refreshed = await registry.getActiveHost();
    if (!refreshed) {
        throw new Error("Failed to persist active host binding.");
    }
    return refreshed;
}
async function createRuntimeForWsLifecycle(options, overrides = {}) {
    const backendUrl = options.backendUrl.trim();
    if (!backendUrl) {
        throw new Error("--backend-url is required when using --transport ws");
    }
    const gatewayDetector = await buildGatewayDetector(options);
    const transport = new WsBackendTransport({
        gatewayDetector
    });
    const registry = buildHostRegistry(options);
    let activeHost = await registry.getActiveHost();
    if (!activeHost && overrides.autoBindDefaultHost) {
        await registry.bindHost({
            hostId: "local-host",
            hostName: "Local Host",
            userId: "demo-user",
            backendUrl
        });
        activeHost = await registry.getActiveHost();
    }
    if (!activeHost) {
        throw new Error("No active host binding found. Run `clawpal run` first.");
    }
    const envConnectorToken = normalizeOptional(process.env.CLAWPAL_CONNECTOR_TOKEN);
    const desiredConnectorToken = envConnectorToken ?? activeHost.connectorToken;
    if (activeHost.backendUrl !== backendUrl || desiredConnectorToken !== activeHost.connectorToken) {
        activeHost = await rebindActiveHost(registry, activeHost, {
            backendUrl,
            ...(desiredConnectorToken ? { connectorToken: desiredConnectorToken } : {})
        });
    }
    const agentSyncResult = await syncAgentsToRelay({
        backendUrl: activeHost.backendUrl,
        hostId: activeHost.hostId
    });
    if (agentSyncResult.synced > 0) {
        console.log(`[connector] Synced ${agentSyncResult.synced} agents from OpenClaw config to relay`);
    }
    const runtime = new ConnectorRuntime({
        hostRegistry: registry,
        gatewayDetector,
        backendClient: new BackendClient({ transport }),
        heartbeatManager: new HeartbeatManager({ intervalMs: options.heartbeatMs }),
        runtimeWorker: new RuntimeWorker({
            gatewayProbe: () => gatewayDetector.detect(),
            openClaw: {
                gatewayUrl: options.gateway,
                gatewayToken: options.token
            }
        })
    });
    return { transport, runtime, registry };
}
async function waitForShutdown(durationMs) {
    if (durationMs) {
        await new Promise((resolve) => {
            setTimeout(resolve, durationMs);
        });
        return;
    }
    await new Promise((resolve) => {
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
async function runLifecycleLoop(options) {
    const statusSnapshot = await options.runtime.createStatusSnapshot();
    printStatusSnapshot(statusSnapshot, options.registryPath);
    const running = await options.runtime.start();
    console.log("");
    console.log(`connector started for host=${running.host.hostId} via transport=${options.transport.name}`);
    let web;
    if (options.webUi) {
        const getDiagnosticsSnapshot = async () => {
            const events = options.transport.getSentEvents();
            const lastEvent = events.length > 0 ? events[events.length - 1] : undefined;
            return {
                generatedAt: new Date().toISOString(),
                status: await options.runtime.createStatusSnapshot(),
                backend: {
                    transport: options.transport.name,
                    connected: options.transport.isConnected(),
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
    }
    finally {
        if (web) {
            await web.close();
        }
        await running.stop();
    }
}
async function requestAndWaitForPairing(options) {
    if (options.reason === "no_binding") {
        console.log("No local binding found. Starting a new pairing session...");
    }
    else {
        console.log("Starting a new pairing session...");
    }
    const session = await startPairingSession({
        backendUrl: options.backendUrl,
        hostId: options.hostId,
        hostName: options.hostName
    });
    console.log(`pairing code=${session.code}`);
    if (session.expiresAt) {
        console.log(`expires at=${session.expiresAt}`);
    }
    console.log("action=Enter this code in ClawPal App to bind this connector.");
    console.log("status=Waiting for binding completion...");
    const resolved = await waitForPairingCompletion({
        session,
        onPending: ({ attempt, pollAfterMs, status }) => {
            if (attempt === 1 || attempt % 20 === 0) {
                console.log(`status=${status ?? "pending"}, retry_in=${pollAfterMs}ms`);
            }
        }
    });
    return {
        session,
        resolved
    };
}
async function persistPairingResolution(options) {
    await options.registry.bindHost({
        hostId: options.resolved.binding.hostId,
        hostName: options.resolved.binding.hostName,
        userId: options.resolved.binding.userId,
        backendUrl: options.resolved.binding.backendUrl,
        ...(options.resolved.binding.connectorToken ? { connectorToken: options.resolved.binding.connectorToken } : {}),
        bindingCode: options.resolved.binding.bindingCode
    });
    const localDefaults = await resolveLocalGatewayDefaults();
    const gatewayUrl = normalizeOptional(options.gateway) ??
        normalizeOptional(options.resolved.runtimeConfig.gatewayUrl) ??
        normalizeOptional(process.env.OPENCLAW_GATEWAY_URL) ??
        localDefaults.gatewayUrl ??
        DEFAULT_RUNTIME_GATEWAY_URL;
    const gatewayToken = normalizeOptional(options.token) ??
        normalizeOptional(options.resolved.runtimeConfig.gatewayToken) ??
        normalizeOptional(process.env.OPENCLAW_GATEWAY_TOKEN) ??
        localDefaults.gatewayToken;
    const runtimeUpdate = {
        transport: "ws",
        gatewayUrl,
        gatewayTimeoutMs: options.timeoutMs ?? options.resolved.runtimeConfig.gatewayTimeoutMs ?? 8_000,
        heartbeatMs: options.heartbeatMs ?? options.resolved.runtimeConfig.heartbeatMs ?? DEFAULT_RUNTIME_HEARTBEAT_MS,
        gatewayToken: gatewayToken ?? ""
    };
    const runtimeConfig = await options.runtimeConfigStore.updateConfig(runtimeUpdate);
    const activeHost = await options.registry.getActiveHost();
    if (!activeHost) {
        throw new Error("Failed to persist active host binding.");
    }
    return {
        activeHost,
        runtimeConfig
    };
}
async function runStatusCommand(options) {
    const transport = new MockBackendTransport();
    const runtime = new ConnectorRuntime({
        hostRegistry: buildHostRegistry(options),
        gatewayDetector: await buildGatewayDetector(options),
        backendClient: new BackendClient({ transport })
    });
    const snapshot = await runtime.createStatusSnapshot();
    printStatusSnapshot(snapshot, buildHostRegistry(options).getStoreFilePath());
    if (!snapshot.gateway.ok || !snapshot.activeHost) {
        process.exitCode = 2;
    }
}
async function runPairCommand(options) {
    const registry = buildHostRegistry(options);
    const runtimeConfigStore = buildRuntimeConfigStore(options);
    const backendUrl = resolveBackendUrl(options.backendUrl);
    const hostName = normalizeOptional(options.hostName) ?? hostname();
    const hostId = deriveConnectorHostId();
    const pairing = await requestAndWaitForPairing({
        backendUrl,
        hostId,
        hostName,
        reason: "manual"
    });
    const { activeHost, runtimeConfig } = await persistPairingResolution({
        registry,
        runtimeConfigStore,
        resolved: pairing.resolved,
        gateway: options.gateway,
        token: options.token,
        timeoutMs: options.timeoutMs,
        heartbeatMs: options.heartbeatMs,
    });
    console.log("status=Binding completed. Continuing connector startup...");
    console.log(`paired host=${activeHost.hostName} (${activeHost.hostId})`);
    console.log(`user id=${activeHost.userId}`);
    console.log(`backend url=${activeHost.backendUrl}`);
    console.log(`pair create endpoint=${pairing.session.createEndpoint}`);
    console.log(`pair status endpoint=${pairing.resolved.endpoint}`);
    console.log(`registry file=${registry.getStoreFilePath()}`);
    console.log(`runtime config=${runtimeConfigStore.getStoreFilePath()}`);
    console.log(`run defaults=transport=${runtimeConfig.transport}, gateway=${runtimeConfig.gatewayUrl}`);
    console.log("");
    await runRunCommand({
        registryFile: options.registryFile,
        runtimeConfigFile: options.runtimeConfigFile,
        backendUrl,
        ...(options.gateway ? { gateway: options.gateway } : {}),
        ...(options.token ? { token: options.token } : {}),
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.heartbeatMs ? { heartbeatMs: options.heartbeatMs } : {}),
        webUi: false,
        webHost: "127.0.0.1",
        webPort: 8787,
    });
}
async function runBindCommand(options) {
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
async function runStartCommand(options) {
    let transport;
    let runtime;
    let registryPath;
    if (options.transport === "ws") {
        const result = await createRuntimeForWsLifecycle(options, { autoBindDefaultHost: true });
        transport = result.transport;
        runtime = result.runtime;
        registryPath = result.registry.getStoreFilePath();
    }
    else {
        const result = createRuntimeForMockLifecycle(options);
        transport = result.transport;
        runtime = result.runtime;
        registryPath = result.registry.getStoreFilePath();
    }
    await runLifecycleLoop({
        runtime,
        transport,
        registryPath,
        webUi: options.webUi,
        webHost: options.webHost,
        webPort: options.webPort,
        ...(options.durationMs ? { durationMs: options.durationMs } : {})
    });
}
async function runRunCommand(options) {
    const registry = buildHostRegistry(options);
    const runtimeConfigStore = buildRuntimeConfigStore(options);
    const activeHost = await registry.getActiveHost();
    if (!activeHost) {
        throw new Error("No active host binding found. Run `clawpal pair` first.");
    }
    const runtimeConfig = await runtimeConfigStore.loadConfig();
    const localDefaults = await resolveLocalGatewayDefaults();
    const gateway = normalizeOptional(options.gateway) ??
        normalizeOptional(process.env.OPENCLAW_GATEWAY_URL) ??
        localDefaults.gatewayUrl ??
        runtimeConfig.gatewayUrl;
    const token = normalizeOptional(options.token) ??
        normalizeOptional(process.env.OPENCLAW_GATEWAY_TOKEN) ??
        localDefaults.gatewayToken ??
        runtimeConfig.gatewayToken ??
        "";
    const wsLifecycleOptions = {
        registryFile: options.registryFile,
        backendUrl: normalizeOptional(options.backendUrl) ?? activeHost.backendUrl,
        gateway,
        token,
        timeoutMs: options.timeoutMs ?? runtimeConfig.gatewayTimeoutMs,
        heartbeatMs: options.heartbeatMs ?? runtimeConfig.heartbeatMs
    };
    const result = await createRuntimeForWsLifecycle(wsLifecycleOptions, {
        autoBindDefaultHost: false
    });
    await runLifecycleLoop({
        runtime: result.runtime,
        transport: result.transport,
        registryPath: result.registry.getStoreFilePath(),
        webUi: options.webUi,
        webHost: options.webHost,
        webPort: options.webPort,
        ...(options.durationMs ? { durationMs: options.durationMs } : {})
    });
}
async function runDemoCommand(options) {
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
        throw new Error("No active host binding found. Run `clawpal run` or pass `--auto-bind`.");
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
        await transport.waitForEvent((event) => isRequestEvent(event) &&
            event.requestId === request.requestId &&
            (event.type === "message.done" || event.type === "message.error"), 5_000);
        const requestEvents = transport
            .getSentEvents()
            .filter((event) => event.type === "host.status" || (isRequestEvent(event) && event.requestId === request.requestId));
        console.log("demo event stream:");
        for (const event of requestEvents) {
            console.log(`- ${formatEventLine(event)}`);
        }
    }
    finally {
        await running.stop();
    }
}
const program = new Command();
program
    .name("clawpal")
    .description("ClawPal hosted-relay connector CLI")
    .version("0.3.0");
withGatewayOptions(program.command("status").description("Print gateway + host registry status")).action(async (options) => {
    await runStatusCommand(options);
});
withPairOptions(program.command("pair").description("Start pairing session, show code, and save binding defaults")).action(async (options) => {
    await runPairCommand(options);
});
withRunOptions(program.command("run").description("Run connector; auto-start pairing when no local binding exists")).action(async (options) => {
    await runRunCommand(options);
});
withRegistryOption(program.command("bind").description("Bind local connector host metadata (legacy advanced command)"))
    .requiredOption("--host-id <id>", "Connector host identifier", process.env.CLAWPAL_HOST_ID ?? "")
    .requiredOption("--host-name <name>", "Connector host display name", process.env.CLAWPAL_HOST_NAME ?? "")
    .requiredOption("--user-id <id>", "ClawPal user identifier", process.env.CLAWPAL_USER_ID ?? "")
    .requiredOption("--backend-url <url>", "Official backend base URL", process.env.CLAWPAL_BACKEND_URL ?? DEFAULT_BACKEND_URL)
    .option("--connector-token <token>", "Connector token placeholder", process.env.CLAWPAL_CONNECTOR_TOKEN ?? "")
    .option("--binding-code <code>", "Bind code placeholder", process.env.CLAWPAL_BIND_CODE ?? "")
    .action(async (options) => {
    await runBindCommand(options);
});
withLifecycleOptions(program.command("start").description("Start connector lifecycle loop (legacy advanced command)")).action(async (options) => {
    await runStartCommand(options);
});
withLifecycleOptions(program.command("demo").description("Run local mock relay demo (forwarded request -> streamed result)"))
    .option("--message <text>", "Demo forwarded message text", "Run local relay demo")
    .option("--conversation-id <id>", "Demo conversation id", "demo-conversation")
    .option("--no-auto-bind", "Disable demo auto-bind")
    .option("--bind-host-id <id>", "Host id used by demo auto-bind", "demo-host")
    .option("--bind-host-name <name>", "Host name used by demo auto-bind", "Demo Host")
    .option("--bind-user-id <id>", "User id used by demo auto-bind", "demo-user")
    .option("--bind-backend-url <url>", "Backend URL used by demo auto-bind", DEFAULT_BACKEND_URL)
    .action(async (options) => {
    await runDemoCommand(options);
});
program.parseAsync(process.argv).catch((error) => {
    const message = error instanceof Error ? error.message : "Unknown CLI error";
    console.error(`clawpal error: ${message}`);
    process.exit(1);
});
//# sourceMappingURL=cli.js.map