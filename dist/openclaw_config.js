import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
const OPENCLAW_CONFIG_PATH = join(homedir(), ".openclaw", "openclaw.json");
export async function readOpenClawConfig() {
    try {
        const content = await readFile(OPENCLAW_CONFIG_PATH, "utf-8");
        return parseOpenClawConfig(content);
    }
    catch {
        return null;
    }
}
function parseOpenClawConfig(content) {
    const normalized = content
        .replace(/^\uFEFF/, "")
        .replace(/^\s*\/\/.*$/gm, "")
        .replace(/,\s*([}\]])/g, "$1");
    return JSON.parse(normalized);
}
export async function writeOpenClawConfig(config) {
    await writeFile(OPENCLAW_CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}
function normalizeAgentId(value) {
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
function listExplicitAgentIds(config) {
    const explicitAgentIds = new Set();
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
function findRouteBindingByAgentId(config, agentId) {
    for (const binding of config.bindings ?? []) {
        const normalizedBindingAgentId = normalizeAgentId(binding.agentId);
        if (!normalizedBindingAgentId || normalizedBindingAgentId !== agentId) {
            continue;
        }
        return binding;
    }
    return undefined;
}
export function resolveOpenClawAgentResolution(config, agentId) {
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
export function extractAgentsFromConfig(config) {
    const agents = [];
    if (!config.bindings)
        return agents;
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
export function extractLocalGatewayDefaults(config) {
    const port = config.gateway?.port;
    const token = config.gateway?.auth?.token?.trim();
    return {
        ...(typeof port === "number" && Number.isFinite(port)
            ? { gatewayUrl: `http://127.0.0.1:${Math.trunc(port)}` }
            : {}),
        ...(token ? { gatewayToken: token } : {}),
    };
}
export function addBindingToConfig(config, agent) {
    const match = {};
    if (agent.channel) {
        match.channel = agent.channel;
    }
    const newBinding = {
        agentId: agent.agentId,
        match
    };
    return {
        ...config,
        bindings: [...(config.bindings ?? []), newBinding]
    };
}
export function removeBindingFromConfig(config, agentId) {
    return {
        ...config,
        bindings: (config.bindings ?? []).filter(b => b.agentId !== agentId)
    };
}
//# sourceMappingURL=openclaw_config.js.map