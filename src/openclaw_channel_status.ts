import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ChannelConnectionSnapshot } from "./channel_connection_snapshot.js";
import { extractAgentsFromConfig, readOpenClawConfig } from "./openclaw_config.js";

const execFileAsync = promisify(execFile);

export interface AgentChannelAvailability {
  agentId: string;
  snapshot: ChannelConnectionSnapshot;
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  return undefined;
}

function buildUnavailableSnapshot(provider: string | undefined, accountId: string | undefined, detail: string): ChannelConnectionSnapshot {
  return {
    providerConnected: false,
    deliveryAvailable: false,
    ...(provider ? { provider } : {}),
    ...(accountId ? { accountId } : {}),
    detail,
  };
}

export async function probeOpenClawChannelAvailability(): Promise<Map<string, ChannelConnectionSnapshot>> {
  const config = await readOpenClawConfig();
  if (!config) {
    return new Map();
  }

  const agents = extractAgentsFromConfig(config);
  if (agents.length === 0) {
    return new Map();
  }

  let payload: unknown;
  try {
    const { stdout } = await execFileAsync("openclaw", ["channels", "status", "--probe", "--json"], {
      maxBuffer: 1024 * 1024,
    });
    payload = JSON.parse(stdout);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Map(
      agents.map((agent) => [
        agent.agentId,
        buildUnavailableSnapshot(agent.channel, agent.accountId, `openclaw channels status probe failed: ${message}`),
      ]),
    );
  }

  const root = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const channelAccountsRaw = root["channelAccounts"];
  const channelAccounts =
    channelAccountsRaw && typeof channelAccountsRaw === "object"
      ? (channelAccountsRaw as Record<string, unknown>)
      : {};

  const result = new Map<string, ChannelConnectionSnapshot>();

  for (const agent of agents) {
    const provider = normalizeText(agent.channel);
    const accountId = normalizeText(agent.accountId);
    if (!provider) {
      result.set(
        agent.agentId,
        {
          providerConnected: true,
          deliveryAvailable: true,
          ...(accountId ? { accountId } : {}),
        },
      );
      continue;
    }

    const providerEntriesRaw = channelAccounts[provider];
    const providerEntries = Array.isArray(providerEntriesRaw) ? providerEntriesRaw : [];
    const matched = providerEntries.find((entry) => {
      if (!entry || typeof entry !== "object") {
        return false;
      }
      const record = entry as Record<string, unknown>;
      if (!accountId) {
        return true;
      }
      return normalizeText(record["accountId"]) == accountId;
    });

    if (!matched || typeof matched !== "object") {
      result.set(
        agent.agentId,
        buildUnavailableSnapshot(provider, accountId, accountId ? `channel account ${accountId} not found` : "channel account not found"),
      );
      continue;
    }

    const record = matched as Record<string, unknown>;
    const configured = normalizeBoolean(record["configured"]);
    const running = normalizeBoolean(record["running"]);
    const connected = normalizeBoolean(record["connected"]);
    const tokenStatus = normalizeText(record["tokenStatus"]);
    const lastError = normalizeText(record["lastError"]);
    const reconnectAttempts = record["reconnectAttempts"];
    const reconnectText = typeof reconnectAttempts === "number" ? `reconnectAttempts=${reconnectAttempts}` : undefined;

    const providerConnected = connected ?? running ?? configured ?? false;
    const deliveryAvailable = (configured ?? false) && providerConnected && tokenStatus != "missing";
    const detailParts = [lastError, reconnectText].filter((item): item is string => typeof item === "string" && item.length > 0).join("; ");

    result.set(agent.agentId, {
      providerConnected,
      deliveryAvailable,
      provider,
      ...(accountId ? { accountId } : {}),
      ...(detailParts.length > 0 ? { detail: detailParts } : {}),
    });
  }

  return result;
}
