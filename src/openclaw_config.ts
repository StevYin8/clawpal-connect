import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface OpenClawBinding {
  agentId: string;
  match: {
    channel?: string;
    accountId?: string;
  };
}

export interface OpenClawAgentEntry {
  id?: string;
  default?: boolean;
  workspace?: string;
}

export interface OpenClawConfig {
  bindings: OpenClawBinding[];
  gateway?: {
    port?: number;
    auth?: {
      token?: string;
    };
  };
  agents?: {
    list?: OpenClawAgentEntry[];
    defaults?: {
      model?: {
        primary?: string;
        fallbacks?: string[];
      };
    };
  };
  models?: {
    providers?: Record<string, {
      models?: Array<{
        id: string;
        name: string;
      }>;
    }>;
  };
}

export interface AgentInfo {
  agentId: string;
  name: string;
  model: string;
  channel?: string | undefined;
}

export type OpenClawAgentResolutionMode = "explicit" | "bindings-only" | "unconfigured";

export interface OpenClawAgentResolution {
  agentId: string;
  mode: OpenClawAgentResolutionMode;
  binding?: OpenClawBinding;
}

const OPENCLAW_CONFIG_PATH = join(homedir(), ".openclaw", "openclaw.json");

export async function readOpenClawConfig(): Promise<OpenClawConfig | null> {
  try {
    const content = await readFile(OPENCLAW_CONFIG_PATH, "utf-8");
    return parseOpenClawConfig(content);
  } catch {
    return null;
  }
}

function parseOpenClawConfig(content: string): OpenClawConfig {
  const normalized = content
    .replace(/^\uFEFF/, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,\s*([}\]])/g, "$1");

  return JSON.parse(normalized) as OpenClawConfig;
}

export async function writeOpenClawConfig(config: OpenClawConfig): Promise<void> {
  await writeFile(OPENCLAW_CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

function normalizeAgentId(value: unknown): string | undefined {
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

function listExplicitAgentIds(config: OpenClawConfig): Set<string> {
  const explicitAgentIds = new Set<string>();

  const entries = config.agents?.list;
  if (!Array.isArray(entries)) {
    return explicitAgentIds;
  }

  for (const entry of entries) {
    const agentId = normalizeAgentId(entry?.id);
    if (!agentId) {
      continue;
    }
    explicitAgentIds.add(agentId);
  }

  return explicitAgentIds;
}

function findRouteBindingByAgentId(config: OpenClawConfig, agentId: string): OpenClawBinding | undefined {
  for (const binding of config.bindings ?? []) {
    const normalizedBindingAgentId = normalizeAgentId(binding.agentId);
    if (!normalizedBindingAgentId || normalizedBindingAgentId !== agentId) {
      continue;
    }
    return binding;
  }
  return undefined;
}

export function resolveOpenClawAgentResolution(config: OpenClawConfig, agentId: string): OpenClawAgentResolution {
  const normalizedAgentId = normalizeAgentId(agentId) ?? "";
  if (!normalizedAgentId) {
    return {
      agentId: normalizedAgentId,
      mode: "unconfigured"
    };
  }

  const explicitAgentIds = listExplicitAgentIds(config);
  if (explicitAgentIds.has(normalizedAgentId)) {
    return {
      agentId: normalizedAgentId,
      mode: "explicit"
    };
  }

  const binding = findRouteBindingByAgentId(config, normalizedAgentId);
  if (binding) {
    return {
      agentId: normalizedAgentId,
      mode: "bindings-only",
      binding
    };
  }

  return {
    agentId: normalizedAgentId,
    mode: "unconfigured"
  };
}

export function extractAgentsFromConfig(config: OpenClawConfig): AgentInfo[] {
  const agents: AgentInfo[] = [];
  
  if (!config.bindings) return agents;

  const primaryModel = config.agents?.defaults?.model?.primary ?? "unknown";
  
  for (const binding of config.bindings) {
    agents.push({
      agentId: binding.agentId,
      name: binding.agentId, // Use agentId as name
      model: primaryModel,
      channel: binding.match?.channel
    });
  }

  return agents;
}

export interface LocalGatewayDefaults {
  gatewayUrl?: string;
  gatewayToken?: string;
}

export function extractLocalGatewayDefaults(config: OpenClawConfig): LocalGatewayDefaults {
  const port = config.gateway?.port;
  const token = config.gateway?.auth?.token?.trim();

  return {
    ...(typeof port === "number" && Number.isFinite(port)
      ? { gatewayUrl: `http://127.0.0.1:${Math.trunc(port)}` }
      : {}),
    ...(token ? { gatewayToken: token } : {}),
  };
}

export function addBindingToConfig(config: OpenClawConfig, agent: AgentInfo): OpenClawConfig {
  const match: { channel?: string; accountId?: string } = {};
  if (agent.channel) {
    match.channel = agent.channel;
  }

  const newBinding: OpenClawBinding = {
    agentId: agent.agentId,
    match
  };

  return {
    ...config,
    bindings: [...(config.bindings ?? []), newBinding]
  };
}

export function removeBindingFromConfig(config: OpenClawConfig, agentId: string): OpenClawConfig {
  return {
    ...config,
    bindings: (config.bindings ?? []).filter(b => b.agentId !== agentId)
  };
}
