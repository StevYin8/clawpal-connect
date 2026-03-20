import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";

import type { ConnectorEventInput, ForwardedRequest } from "./backend_client.js";
import type { GatewayProbeResult } from "./gateway_detector.js";
import {
  readOpenClawConfig,
  resolveOpenClawAgentResolution,
  type OpenClawConfig
} from "./openclaw_config.js";

export type RuntimeEventEmitter = (event: ConnectorEventInput) => Promise<void>;

export type RequestExecutor = (request: ForwardedRequest) => AsyncIterable<string>;

type SpawnOpenClawProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcessWithoutNullStreams;

export interface OpenClawRequestExecutorOptions {
  gatewayUrl?: string;
  gatewayToken?: string;
  openClawBinary?: string;
  fetchImpl?: typeof fetch;
  spawnImpl?: SpawnOpenClawProcess;
  readOpenClawConfigImpl?: () => Promise<OpenClawConfig | null>;
  env?: NodeJS.ProcessEnv;
}

export interface RuntimeWorkerOptions {
  gatewayProbe?: () => Promise<GatewayProbeResult>;
  executeRequest?: RequestExecutor;
  openClaw?: OpenClawRequestExecutorOptions;
}

const DEFAULT_OPENCLAW_GATEWAY_URL = "http://127.0.0.1:18789";
const DEFAULT_OPENCLAW_BINARY = "openclaw";
const OPENRESPONSES_FALLBACK_HTTP_STATUSES = new Set([404, 405, 501]);
const OPENCLAW_AGENT_TIMEOUT_SECONDS = 600;

interface CliCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

interface OpenClawBridgeResolvedOptions {
  gatewayUrl: string;
  gatewayToken?: string;
  openClawBinary: string;
  fetchImpl: typeof fetch;
  spawnImpl: SpawnOpenClawProcess;
  readOpenClawConfigImpl: () => Promise<OpenClawConfig | null>;
  env: NodeJS.ProcessEnv;
}

interface ResolvedAgentInvocationContext {
  mode: "explicit" | "bindings-only" | "unconfigured";
  model: string;
  sessionKey: string;
  gatewayAgentId?: string;
  channel?: string;
  accountId?: string;
}

class OpenClawHttpError extends Error {
  readonly status: number;
  readonly bodyText: string;

  constructor(status: number, message: string, bodyText: string) {
    super(message);
    this.name = "OpenClawHttpError";
    this.status = status;
    this.bodyText = bodyText;
  }
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function resolveGatewayHttpBaseUrl(rawUrl: string): string {
  const normalized = rawUrl.trim();
  const withScheme = /^(https?|wss?):\/\//i.test(normalized) ? normalized : `http://${normalized}`;
  const parsed = new URL(withScheme);
  if (parsed.protocol === "ws:") {
    parsed.protocol = "http:";
  } else if (parsed.protocol === "wss:") {
    parsed.protocol = "https:";
  }
  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function resolveGatewayWsUrl(rawUrl: string): string {
  const normalized = rawUrl.trim();
  const withScheme = /^(https?|wss?):\/\//i.test(normalized) ? normalized : `http://${normalized}`;
  const parsed = new URL(withScheme);
  if (parsed.protocol === "http:") {
    parsed.protocol = "ws:";
  } else if (parsed.protocol === "https:") {
    parsed.protocol = "wss:";
  }
  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function buildOpenResponsesUrl(gatewayUrl: string): string {
  return new URL("/v1/responses", resolveGatewayHttpBaseUrl(gatewayUrl)).toString();
}

function buildOpenClawSessionKey(request: ForwardedRequest): string {
  const conversationId = normalizeOptionalString(request.conversationId) ?? `request-${request.requestId}`;
  return `relay:${request.hostId}:${request.userId}:${conversationId}`;
}

function normalizeOpenClawAgentId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9#@._+-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");

  return normalized || undefined;
}

function buildAgentScopedSessionKey(baseSessionKey: string, agentId: string): string {
  const normalizedAgentId = normalizeOpenClawAgentId(agentId);
  if (!normalizedAgentId) {
    return baseSessionKey;
  }

  const trimmedBase = baseSessionKey.trim();
  if (/^agent:[^:]+:/i.test(trimmedBase)) {
    return trimmedBase;
  }

  return `agent:${normalizedAgentId}:${trimmedBase}`;
}

function shouldFallbackToGatewayCall(error: OpenClawHttpError): boolean {
  if (OPENRESPONSES_FALLBACK_HTTP_STATUSES.has(error.status)) {
    return true;
  }

  if (error.status !== 400) {
    return false;
  }

  const combined = `${error.message}\n${error.bodyText}`.toLowerCase();
  return combined.includes("unknown agent");
}

function extractErrorMessageFromJson(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const record = toRecord(parsed);
    if (!record) {
      return undefined;
    }

    const error = toRecord(record.error);
    const message = normalizeOptionalString(error?.message);
    if (message) {
      return message;
    }
  } catch {}

  return undefined;
}

function extractPayloadTexts(payloads: unknown): string {
  if (!Array.isArray(payloads)) {
    return "";
  }

  const parts: string[] = [];
  for (const payload of payloads) {
    const record = toRecord(payload);
    const text = asString(record?.text);
    if (text !== undefined) {
      parts.push(text);
    }
  }
  return parts.join("\n\n");
}

function extractOpenResponsesOutputText(payload: unknown): string {
  const root = toRecord(payload);
  if (!root) {
    return "";
  }

  const output = root.output;
  if (!Array.isArray(output)) {
    return "";
  }

  const parts: string[] = [];
  for (const item of output) {
    const itemRecord = toRecord(item);
    if (!itemRecord || itemRecord.type !== "message") {
      continue;
    }
    const content = itemRecord.content;
    if (!Array.isArray(content)) {
      continue;
    }

    for (const chunk of content) {
      const chunkRecord = toRecord(chunk);
      if (!chunkRecord || chunkRecord.type !== "output_text") {
        continue;
      }
      const text = asString(chunkRecord.text);
      if (text !== undefined) {
        parts.push(text);
      }
    }
  }

  return parts.join("\n\n");
}

function extractGatewayCallText(payload: unknown): string {
  const root = toRecord(payload);
  if (!root) {
    return "";
  }

  const result = toRecord(root.result);
  const directPayloadText = extractPayloadTexts(root.payloads);
  if (directPayloadText) {
    return directPayloadText;
  }

  const resultPayloadText = extractPayloadTexts(result?.payloads);
  if (resultPayloadText) {
    return resultPayloadText;
  }

  const resultResponseText = extractOpenResponsesOutputText(result);
  if (resultResponseText) {
    return resultResponseText;
  }

  const directResponseText = extractOpenResponsesOutputText(root);
  if (directResponseText) {
    return directResponseText;
  }

  return normalizeOptionalString(root.summary) ?? "";
}

function parseJsonFromOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error("OpenClaw CLI produced empty stdout.");
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {}

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    const candidate = trimmed.slice(start, end + 1);
    try {
      return JSON.parse(candidate) as unknown;
    } catch {}
  }

  throw new Error(`OpenClaw CLI stdout did not contain valid JSON: ${trimmed}`);
}

async function resolveAgentInvocationContext(
  request: ForwardedRequest,
  options: OpenClawBridgeResolvedOptions
): Promise<ResolvedAgentInvocationContext> {
  const requestedAgentId = normalizeOpenClawAgentId(request.agentId);
  const fallbackModelAgentId = requestedAgentId ?? "main";
  const baseSessionKey = buildOpenClawSessionKey(request);

  if (!requestedAgentId) {
    return {
      mode: "unconfigured",
      model: `openclaw:${fallbackModelAgentId}`,
      sessionKey: baseSessionKey
    };
  }

  let config: OpenClawConfig | null = null;
  try {
    config = await options.readOpenClawConfigImpl();
  } catch {
    config = null;
  }

  if (!config) {
    return {
      mode: "unconfigured",
      model: `openclaw:${requestedAgentId}`,
      sessionKey: baseSessionKey,
      gatewayAgentId: requestedAgentId
    };
  }

  const resolution = resolveOpenClawAgentResolution(config, requestedAgentId);
  if (resolution.mode === "bindings-only") {
    return {
      mode: "bindings-only",
      model: `openclaw:${resolution.agentId}`,
      sessionKey: buildAgentScopedSessionKey(baseSessionKey, resolution.agentId),
      ...(resolution.binding?.match?.channel ? { channel: resolution.binding.match.channel } : {}),
      ...(resolution.binding?.match?.accountId ? { accountId: resolution.binding.match.accountId } : {})
    };
  }

  return {
    mode: resolution.mode,
    model: `openclaw:${resolution.agentId || requestedAgentId}`,
    sessionKey: baseSessionKey,
    gatewayAgentId: resolution.agentId || requestedAgentId
  };
}

function resolveOpenClawBridgeOptions(options: OpenClawRequestExecutorOptions = {}): OpenClawBridgeResolvedOptions {
  const env = options.env ?? process.env;
  const gatewayUrl =
    normalizeOptionalString(options.gatewayUrl) ??
    normalizeOptionalString(env.OPENCLAW_GATEWAY_URL) ??
    DEFAULT_OPENCLAW_GATEWAY_URL;
  const gatewayToken =
    normalizeOptionalString(options.gatewayToken) ??
    normalizeOptionalString(env.OPENCLAW_GATEWAY_TOKEN);
  const openClawBinary = normalizeOptionalString(options.openClawBinary) ?? DEFAULT_OPENCLAW_BINARY;

  return {
    gatewayUrl,
    ...(gatewayToken ? { gatewayToken } : {}),
    openClawBinary,
    fetchImpl: options.fetchImpl ?? fetch,
    spawnImpl:
      options.spawnImpl ??
      ((command: string, args: readonly string[], spawnOptions: SpawnOptions) =>
        spawn(command, [...args], spawnOptions) as ChildProcessWithoutNullStreams),
    readOpenClawConfigImpl: options.readOpenClawConfigImpl ?? readOpenClawConfig,
    env
  };
}

async function runOpenClawGatewayCall(
  request: ForwardedRequest,
  context: ResolvedAgentInvocationContext,
  options: OpenClawBridgeResolvedOptions
): Promise<CliCommandResult> {
  const commandParams: Record<string, unknown> = {
    message: request.message,
    deliver: false,
    idempotencyKey: request.requestId,
    sessionKey: context.sessionKey
  };
  if (context.gatewayAgentId) {
    commandParams.agentId = context.gatewayAgentId;
  }
  if (context.channel) {
    commandParams.channel = context.channel;
  }
  if (context.accountId) {
    commandParams.accountId = context.accountId;
  }

  const args: string[] = [
    "gateway",
    "call",
    "agent",
    "--expect-final",
    "--json",
    "--timeout",
    String(OPENCLAW_AGENT_TIMEOUT_SECONDS * 1000),
    "--params",
    JSON.stringify(commandParams),
    "--url",
    resolveGatewayWsUrl(options.gatewayUrl)
  ];

  if (options.gatewayToken) {
    args.push("--token", options.gatewayToken);
  }

  return await new Promise<CliCommandResult>((resolve, reject) => {
    const child = options.spawnImpl(options.openClawBinary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      resolve({
        stdout,
        stderr,
        exitCode,
        signal
      });
    });
  });
}

async function* streamOpenResponses(
  request: ForwardedRequest,
  context: ResolvedAgentInvocationContext,
  options: OpenClawBridgeResolvedOptions
): AsyncGenerator<string> {
  const body = {
    model: context.model,
    input: request.message,
    stream: true,
    user: `${request.hostId}:${request.userId}:${normalizeOptionalString(request.conversationId) ?? request.requestId}`
  };

  const headers: Record<string, string> = {
    Accept: "text/event-stream, application/json",
    "Content-Type": "application/json",
    "x-openclaw-session-key": context.sessionKey
  };
  if (options.gatewayToken) {
    headers.Authorization = `Bearer ${options.gatewayToken}`;
  }

  const response = await options.fetchImpl(buildOpenResponsesUrl(options.gatewayUrl), {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const bodyText = await response.text();
    const detail =
      extractErrorMessageFromJson(bodyText) ??
      normalizeOptionalString(bodyText) ??
      `OpenResponses request failed with HTTP ${response.status}.`;
    throw new OpenClawHttpError(response.status, detail, bodyText);
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("text/event-stream")) {
    const text = await response.text();
    const parsed = (() => {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return undefined;
      }
    })();

    const output =
      (parsed ? extractOpenResponsesOutputText(parsed) : "") || normalizeOptionalString(text) || "";
    if (output) {
      yield output;
    }
    return;
  }

  if (!response.body) {
    throw new Error("OpenResponses stream body was empty.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let streamBuffer = "";
  let currentEventType = "";
  let currentDataLines: string[] = [];
  let streamClosed = false;
  let sawDelta = false;

  const flushEvent = (): string | undefined => {
    const eventType = currentEventType;
    const dataText = currentDataLines.join("\n");
    currentEventType = "";
    currentDataLines = [];

    const trimmedData = dataText.trim();
    if (!trimmedData) {
      return undefined;
    }
    if (trimmedData === "[DONE]") {
      streamClosed = true;
      return undefined;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmedData) as unknown;
    } catch {
      return undefined;
    }

    if (eventType === "response.output_text.delta") {
      const delta = asString(toRecord(parsed)?.delta);
      if (delta !== undefined) {
        sawDelta = true;
        return delta;
      }
      return undefined;
    }

    if (eventType === "response.output_text.done") {
      if (sawDelta) {
        return undefined;
      }
      const doneText = asString(toRecord(parsed)?.text);
      if (doneText !== undefined) {
        sawDelta = true;
        return doneText;
      }
      return undefined;
    }

    if (eventType === "response.completed") {
      if (sawDelta) {
        return undefined;
      }
      const responseText = extractOpenResponsesOutputText(toRecord(parsed)?.response);
      if (responseText) {
        sawDelta = true;
        return responseText;
      }
      return undefined;
    }

    if (eventType === "response.failed") {
      const failed = toRecord(parsed)?.response;
      const failedMessage =
        normalizeOptionalString(toRecord(toRecord(failed)?.error)?.message) ??
        "OpenResponses reported a failed run.";
      throw new Error(failedMessage);
    }

    return undefined;
  };

  const processChunk = (chunk: string): string[] => {
    streamBuffer += chunk;
    const output: string[] = [];

    while (!streamClosed) {
      const newlineIndex = streamBuffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }

      let line = streamBuffer.slice(0, newlineIndex);
      streamBuffer = streamBuffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }

      if (!line) {
        const emitted = flushEvent();
        if (emitted) {
          output.push(emitted);
        }
        continue;
      }

      if (line.startsWith(":")) {
        continue;
      }

      const separatorIndex = line.indexOf(":");
      const field = separatorIndex === -1 ? line : line.slice(0, separatorIndex);
      const value = separatorIndex === -1 ? "" : line.slice(separatorIndex + 1).trimStart();

      if (field === "event") {
        currentEventType = value;
      } else if (field === "data") {
        currentDataLines.push(value);
      }
    }

    return output;
  };

  while (!streamClosed) {
    const { done, value } = await reader.read();
    if (done) {
      const flushed = processChunk(`${decoder.decode()}\n`);
      for (const delta of flushed) {
        yield delta;
      }
      const finalDelta = flushEvent();
      if (finalDelta) {
        yield finalDelta;
      }
      break;
    }

    const chunk = decoder.decode(value, { stream: true });
    const deltas = processChunk(chunk);
    for (const delta of deltas) {
      yield delta;
    }
  }
}

export function createOpenClawRequestExecutor(options: OpenClawRequestExecutorOptions = {}): RequestExecutor {
  const resolved = resolveOpenClawBridgeOptions(options);

  return async function* openClawRequestExecutor(request: ForwardedRequest): AsyncGenerator<string> {
    const context = await resolveAgentInvocationContext(request, resolved);
    const shouldUseOpenResponses = context.mode !== "bindings-only";

    if (shouldUseOpenResponses) {
      try {
        yield* streamOpenResponses(request, context, resolved);
        return;
      } catch (error) {
        if (!(error instanceof OpenClawHttpError) || !shouldFallbackToGatewayCall(error)) {
          throw error;
        }
      }
    }

    const fallbackResult = await runOpenClawGatewayCall(request, context, resolved);
    if (fallbackResult.exitCode !== 0) {
      const stderr = normalizeOptionalString(fallbackResult.stderr) ?? "no stderr";
      throw new Error(
        `OpenClaw gateway RPC fallback failed (exit=${String(fallbackResult.exitCode)} signal=${String(fallbackResult.signal)}): ${stderr}`
      );
    }

    const parsed = parseJsonFromOutput(fallbackResult.stdout);
    const output = extractGatewayCallText(parsed);
    if (output) {
      yield output;
    }
  };
}

function mapGatewayFailureCode(status: GatewayProbeResult["status"]): string {
  switch (status) {
    case "offline":
      return "gateway_offline";
    case "unauthorized":
      return "gateway_unauthorized";
    case "error":
      return "gateway_error";
    case "online":
      return "gateway_unknown";
  }
}

export class RuntimeWorker {
  private readonly gatewayProbe: () => Promise<GatewayProbeResult>;
  private readonly executeRequest: RequestExecutor;

  constructor(options: RuntimeWorkerOptions = {}) {
    this.gatewayProbe =
      options.gatewayProbe ??
      (async () => ({
        status: "online",
        ok: true,
        detail: "Gateway probe bypassed in runtime worker.",
        checkedAt: new Date().toISOString(),
        endpoint: "mock://gateway",
        latencyMs: 0
      }));
    this.executeRequest = options.executeRequest ?? createOpenClawRequestExecutor(options.openClaw);
  }

  async handleForwardedRequest(request: ForwardedRequest, emit: RuntimeEventEmitter): Promise<void> {
    const gateway = await this.gatewayProbe();

    if (!gateway.ok) {
      await emit({
        type: "message.error",
        requestId: request.requestId,
        hostId: request.hostId,
        conversationId: request.conversationId,
        code: mapGatewayFailureCode(gateway.status),
        message: `OpenClaw gateway unavailable: ${gateway.detail}`
      });
      return;
    }

    await emit({
      type: "message.start",
      requestId: request.requestId,
      hostId: request.hostId,
      userId: request.userId,
      conversationId: request.conversationId
    });

    let output = "";
    let sequence = 0;

    try {
      for await (const chunk of this.executeRequest(request)) {
        if (!chunk) {
          continue;
        }

        sequence += 1;
        output += chunk;
        await emit({
          type: "message.delta",
          requestId: request.requestId,
          hostId: request.hostId,
          conversationId: request.conversationId,
          sequence,
          delta: chunk
        });
      }

      await emit({
        type: "message.done",
        requestId: request.requestId,
        hostId: request.hostId,
        conversationId: request.conversationId,
        output
      });
    } catch (error) {
      await emit({
        type: "message.error",
        requestId: request.requestId,
        hostId: request.hostId,
        conversationId: request.conversationId,
        code: "runtime_execution_failed",
        message: error instanceof Error ? error.message : "Unknown runtime worker error"
      });
    }
  }
}
