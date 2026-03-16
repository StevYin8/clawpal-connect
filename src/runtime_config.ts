import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { DEFAULT_GATEWAY_TIMEOUT_MS } from "./gateway_detector.js";

export const DEFAULT_RUNTIME_GATEWAY_URL = "http://127.0.0.1:18789";
export const DEFAULT_RUNTIME_HEARTBEAT_MS = 30_000;

export interface ConnectorRuntimeConfig {
  transport: "ws";
  gatewayUrl: string;
  gatewayToken?: string;
  gatewayTimeoutMs: number;
  heartbeatMs: number;
  updatedAt: string;
}

interface RuntimeConfigStoreFile {
  version: 1;
  config: ConnectorRuntimeConfig;
}

interface RuntimeConfigStoreOptions {
  filePath?: string;
  now?: () => Date;
}

export interface RuntimeConfigUpdate {
  transport?: "ws";
  gatewayUrl?: string;
  gatewayToken?: string;
  gatewayTimeoutMs?: number;
  heartbeatMs?: number;
}

export function resolveDefaultRuntimeConfigFilePath(): string {
  return join(homedir(), ".clawpal-connect", "runtime-config.json");
}

export function createDefaultRuntimeConfig(now = new Date()): ConnectorRuntimeConfig {
  return {
    transport: "ws",
    gatewayUrl: DEFAULT_RUNTIME_GATEWAY_URL,
    gatewayTimeoutMs: DEFAULT_GATEWAY_TIMEOUT_MS,
    heartbeatMs: DEFAULT_RUNTIME_HEARTBEAT_MS,
    updatedAt: now.toISOString()
  };
}

function normalizeOptionalToken(value?: string): string | undefined {
  const token = value?.trim();
  return token ? token : undefined;
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || !value || value <= 0) {
    return fallback;
  }
  return Math.trunc(value);
}

function normalizeGatewayUrl(value: string | undefined, fallback: string): string {
  const next = value?.trim();
  return next ? next : fallback;
}

function normalizeRuntimeConfig(
  config: Partial<ConnectorRuntimeConfig> | null | undefined,
  fallback: ConnectorRuntimeConfig
): ConnectorRuntimeConfig {
  const next: ConnectorRuntimeConfig = {
    transport: "ws",
    gatewayUrl: normalizeGatewayUrl(config?.gatewayUrl, fallback.gatewayUrl),
    gatewayTimeoutMs: normalizePositiveInt(config?.gatewayTimeoutMs, fallback.gatewayTimeoutMs),
    heartbeatMs: normalizePositiveInt(config?.heartbeatMs, fallback.heartbeatMs),
    updatedAt: typeof config?.updatedAt === "string" ? config.updatedAt : fallback.updatedAt
  };

  const token = normalizeOptionalToken(config?.gatewayToken);
  if (token) {
    next.gatewayToken = token;
  }

  return next;
}

export class RuntimeConfigStore {
  private readonly filePath: string;
  private readonly now: () => Date;

  constructor(options: RuntimeConfigStoreOptions = {}) {
    this.filePath = options.filePath ?? resolveDefaultRuntimeConfigFilePath();
    this.now = options.now ?? (() => new Date());
  }

  getStoreFilePath(): string {
    return this.filePath;
  }

  async loadConfig(): Promise<ConnectorRuntimeConfig> {
    const store = await this.readStore();
    return store.config;
  }

  async updateConfig(update: RuntimeConfigUpdate): Promise<ConnectorRuntimeConfig> {
    const current = await this.loadConfig();
    const next: ConnectorRuntimeConfig = {
      ...current,
      transport: "ws",
      gatewayUrl: normalizeGatewayUrl(update.gatewayUrl, current.gatewayUrl),
      gatewayTimeoutMs: normalizePositiveInt(update.gatewayTimeoutMs, current.gatewayTimeoutMs),
      heartbeatMs: normalizePositiveInt(update.heartbeatMs, current.heartbeatMs),
      updatedAt: this.now().toISOString()
    };

    if (Object.prototype.hasOwnProperty.call(update, "gatewayToken")) {
      const token = normalizeOptionalToken(update.gatewayToken);
      if (token) {
        next.gatewayToken = token;
      } else {
        delete next.gatewayToken;
      }
    }

    await this.writeStore({ version: 1, config: next });
    return next;
  }

  private async readStore(): Promise<RuntimeConfigStoreFile> {
    const fallback = createDefaultRuntimeConfig(this.now());
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<RuntimeConfigStoreFile>;
      if (parsed.version !== 1 || !parsed.config || typeof parsed.config !== "object") {
        return { version: 1, config: fallback };
      }

      return {
        version: 1,
        config: normalizeRuntimeConfig(parsed.config, fallback)
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, config: fallback };
      }
      throw error;
    }
  }

  private async writeStore(store: RuntimeConfigStoreFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(store, null, 2), "utf8");
  }
}
