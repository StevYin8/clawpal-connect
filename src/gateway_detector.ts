export const DEFAULT_GATEWAY_TIMEOUT_MS = 8_000;

export type GatewayStatus = "online" | "unauthorized" | "offline" | "error";

export interface GatewayProbeResult {
  status: GatewayStatus;
  ok: boolean;
  detail: string;
  checkedAt: string;
  endpoint: string;
  latencyMs: number;
  httpStatus?: number;
}

export interface GatewayDetectorOptions {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export function buildToolsInvokeUrl(baseUrl: string): URL {
  const raw = baseUrl.trim();
  if (!raw) {
    throw new Error("Gateway base URL cannot be empty.");
  }

  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  return new URL("/tools/invoke", withScheme);
}

export function classifyGatewayHttpStatus(statusCode: number): GatewayStatus {
  if (statusCode >= 200 && statusCode < 300) {
    return "online";
  }
  if (statusCode === 401 || statusCode === 403) {
    return "unauthorized";
  }
  if (statusCode === 408 || statusCode === 502 || statusCode === 503 || statusCode === 504) {
    return "offline";
  }
  return "error";
}

export function describeGatewayStatus(status: GatewayStatus): string {
  switch (status) {
    case "online":
      return "OpenClaw gateway is reachable.";
    case "unauthorized":
      return "Gateway is reachable but authorization failed.";
    case "offline":
      return "Gateway is not reachable right now.";
    case "error":
      return "Gateway returned an unexpected response.";
  }
}

interface ParsedGatewayError {
  message?: string;
}

interface ParsedGatewayPayload {
  ok?: boolean;
  error?: ParsedGatewayError;
}

function parsePayload(input: string): ParsedGatewayPayload | null {
  const text = input.trim();
  if (!text) {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    return parsed as ParsedGatewayPayload;
  } catch {
    return null;
  }
}

function extractErrorMessage(bodyText: string, fallback: string): string {
  const payload = parsePayload(bodyText);
  const message = payload?.error?.message?.trim();
  if (message) {
    return message;
  }
  if (bodyText.trim()) {
    return bodyText.trim();
  }
  return fallback;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export class GatewayDetector {
  private readonly endpoint: URL;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GatewayDetectorOptions) {
    this.endpoint = buildToolsInvokeUrl(options.baseUrl);
    this.token = options.token?.trim() ?? "";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_GATEWAY_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async detect(): Promise<GatewayProbeResult> {
    const startedAt = Date.now();
    const checkedAt = new Date(startedAt).toISOString();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json"
    };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          tool: "session_status",
          args: {}
        })
      });
      const bodyText = await response.text();
      const latencyMs = Date.now() - startedAt;

      if (!response.ok) {
        const status = classifyGatewayHttpStatus(response.status);
        const detail =
          status === "unauthorized"
            ? "Gateway token invalid or missing."
            : extractErrorMessage(bodyText, describeGatewayStatus(status));
        return {
          status,
          ok: false,
          detail,
          checkedAt,
          endpoint: this.endpoint.toString(),
          latencyMs,
          httpStatus: response.status
        };
      }

      const parsed = parsePayload(bodyText);
      if (parsed?.ok === false) {
        return {
          status: "error",
          ok: false,
          detail: extractErrorMessage(bodyText, "Gateway responded with application-level error."),
          checkedAt,
          endpoint: this.endpoint.toString(),
          latencyMs,
          httpStatus: response.status
        };
      }

      return {
        status: "online",
        ok: true,
        detail: "Gateway probe succeeded via /tools/invoke session_status.",
        checkedAt,
        endpoint: this.endpoint.toString(),
        latencyMs,
        httpStatus: response.status
      };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const detail = isAbortError(error)
        ? `Gateway probe timed out after ${this.timeoutMs}ms.`
        : error instanceof Error
          ? error.message
          : "Unknown gateway probe error.";
      return {
        status: "offline",
        ok: false,
        detail,
        checkedAt,
        endpoint: this.endpoint.toString(),
        latencyMs
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

