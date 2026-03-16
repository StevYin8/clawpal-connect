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

export interface OpenClawConfig {
  bindings: OpenClawBinding[];
  gateway?: {
    port?: number;
    auth?: {
      token?: string;
    };
  };
  agents?: {
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