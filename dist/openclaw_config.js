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