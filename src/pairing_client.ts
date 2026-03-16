import { hostname } from "node:os";

import type { RuntimeConfigUpdate } from "./runtime_config.js";

const DEFAULT_PAIR_RESOLVE_PATHS = [
  "/connector/pair/resolve",
  "/api/connector/pair/resolve",
  "/api/connectors/pair/resolve",
  "/v1/connector/pair/resolve"
] as const;

export interface PairingResolveOptions {
  backendUrl: string;
  code: string;
  hostName?: string;
  fetchImpl?: typeof fetch;
  paths?: readonly string[];
}

export interface PairingBindingConfig {
  hostId: string;
  userId: string;
  hostName: string;
  backendUrl: string;
  connectorToken?: string;
  bindingCode: string;
}

export interface PairingResolution {
  binding: PairingBindingConfig;
  runtimeConfig: RuntimeConfigUpdate;
  endpoint: string;
}

interface ResolvedPairingPayload {
  binding: PairingBindingConfig;
  runtimeConfig: RuntimeConfigUpdate;
}

interface PairingApiPayload {
  [key: string]: unknown;
}

function normalizeRequired(value: string, field: string): string {
  const next = value.trim();
  if (!next) {
    throw new Error(`${field} cannot be empty.`);
  }
  return next;
}

function normalizeCode(value: string): string {
  return normalizeRequired(value, "Pairing code").toUpperCase();
}

function parseJsonObject(input: string): PairingApiPayload | null {
  const text = input.trim();
  if (!text) {
    return null;
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed as PairingApiPayload;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

function readString(value: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const current = value[key];
    if (typeof current === "string" && current.trim()) {
      return current.trim();
    }
  }
  return undefined;
}

function readNumber(value: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const current = value[key];
    if (typeof current === "number" && Number.isFinite(current)) {
      return Math.trunc(current);
    }
  }
  return undefined;
}

function buildCandidateObjects(payload: PairingApiPayload): Record<string, unknown>[] {
  const queue: Array<Record<string, unknown>> = [payload];
  const keys = ["binding", "pairing", "result", "data", "connector", "runtime"];

  for (const key of keys) {
    const direct = asRecord(payload[key]);
    if (direct) {
      queue.push(direct);
    }
  }

  const data = asRecord(payload.data);
  if (data) {
    const nestedBinding = asRecord(data.binding);
    if (nestedBinding) {
      queue.push(nestedBinding);
    }
  }

  return queue;
}

function extractErrorMessage(parsed: PairingApiPayload | null, fallback: string): string {
  if (!parsed) {
    return fallback;
  }

  const direct = readString(parsed, ["message", "detail", "error_description"]);
  if (direct) {
    return direct;
  }

  const errorRecord = asRecord(parsed.error);
  if (errorRecord) {
    const nested = readString(errorRecord, ["message", "detail", "description"]);
    if (nested) {
      return nested;
    }
  }

  return fallback;
}

function withScheme(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

function parseBackendUrl(url: string): URL {
  return new URL(withScheme(normalizeRequired(url, "backendUrl")));
}

function resolveBindingFromPayload(
  payload: PairingApiPayload,
  options: { fallbackBackendUrl: string; code: string; hostName: string }
): ResolvedPairingPayload | null {
  const candidates = buildCandidateObjects(payload);
  const binding: PairingBindingConfig = {
    hostId: "",
    userId: "",
    hostName: options.hostName,
    backendUrl: options.fallbackBackendUrl,
    bindingCode: options.code
  };
  const runtimeConfig: RuntimeConfigUpdate = {};

  for (const candidate of candidates) {
    const hostId = readString(candidate, ["hostId", "host_id", "connectorHostId", "connector_host_id"]);
    if (hostId && !binding.hostId) {
      binding.hostId = hostId;
    }

    const userId = readString(candidate, ["userId", "user_id", "accountId", "account_id"]);
    if (userId && !binding.userId) {
      binding.userId = userId;
    }

    const hostName = readString(candidate, ["hostName", "host_name", "deviceName", "device_name"]);
    if (hostName && binding.hostName === options.hostName) {
      binding.hostName = hostName;
    }

    const backendUrl = readString(candidate, ["backendUrl", "backend_url", "relayUrl", "relay_url"]);
    if (backendUrl) {
      binding.backendUrl = backendUrl;
    }

    const connectorToken = readString(candidate, [
      "connectorToken",
      "connector_token",
      "token",
      "accessToken",
      "access_token"
    ]);
    if (connectorToken && !binding.connectorToken) {
      binding.connectorToken = connectorToken;
    }

    const gatewayUrl = readString(candidate, [
      "gatewayUrl",
      "gateway_url",
      "openclawGatewayUrl",
      "openclaw_gateway_url"
    ]);
    if (gatewayUrl && !runtimeConfig.gatewayUrl) {
      runtimeConfig.gatewayUrl = gatewayUrl;
    }

    const gatewayToken = readString(candidate, [
      "gatewayToken",
      "gateway_token",
      "openclawGatewayToken",
      "openclaw_gateway_token"
    ]);
    if (gatewayToken && !runtimeConfig.gatewayToken) {
      runtimeConfig.gatewayToken = gatewayToken;
    }

    const heartbeatMs = readNumber(candidate, ["heartbeatMs", "heartbeat_ms"]);
    if (heartbeatMs && !runtimeConfig.heartbeatMs) {
      runtimeConfig.heartbeatMs = heartbeatMs;
    }

    const gatewayTimeoutMs = readNumber(candidate, ["gatewayTimeoutMs", "gateway_timeout_ms", "timeoutMs", "timeout_ms"]);
    if (gatewayTimeoutMs && !runtimeConfig.gatewayTimeoutMs) {
      runtimeConfig.gatewayTimeoutMs = gatewayTimeoutMs;
    }
  }

  if (!binding.hostId || !binding.userId) {
    return null;
  }

  return { binding, runtimeConfig };
}

export async function resolvePairingCode(options: PairingResolveOptions): Promise<PairingResolution> {
  const backendUrl = parseBackendUrl(options.backendUrl).toString();
  const code = normalizeCode(options.code);
  const hostName = options.hostName?.trim() || hostname();
  const fetchImpl = options.fetchImpl ?? fetch;
  const paths = options.paths ?? DEFAULT_PAIR_RESOLVE_PATHS;
  let lastError: string | null = null;

  for (const path of paths) {
    const endpoint = new URL(path, backendUrl).toString();
    let parsed: PairingApiPayload | null = null;

    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          code,
          connector: {
            hostName
          }
        })
      });

      parsed = parseJsonObject(await response.text());

      if (!response.ok) {
        if (response.status === 404 || response.status === 405) {
          lastError = `Pair API path not found at ${endpoint}.`;
          continue;
        }
        throw new Error(extractErrorMessage(parsed, `Pair request failed with HTTP ${response.status}.`));
      }

      const resolution = parsed
        ? resolveBindingFromPayload(parsed, {
            fallbackBackendUrl: backendUrl,
            code,
            hostName
          })
        : null;

      if (!resolution) {
        throw new Error("Pair API response did not include hostId/userId.");
      }

      return {
        ...resolution,
        endpoint
      };
    } catch (error) {
      if (error instanceof Error) {
        lastError = error.message;
      } else {
        lastError = String(error);
      }
    }
  }

  throw new Error(lastError ?? "Failed to resolve pairing code against relay backend.");
}
