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
    return JSON.parse(content) as OpenClawConfig;
  } catch {
    return null;
  }
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