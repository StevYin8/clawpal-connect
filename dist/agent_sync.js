import { readOpenClawConfig, writeOpenClawConfig, extractAgentsFromConfig, addBindingToConfig, removeBindingFromConfig } from "./openclaw_config.js";
export async function syncAgentsToRelay(options) {
    const config = await readOpenClawConfig();
    if (!config) {
        return { synced: 0, agents: [] };
    }
    const agents = extractAgentsFromConfig(config);
    let synced = 0;
    // Send each agent to relay
    for (const agent of agents) {
        try {
            const response = await fetch(`${options.backendUrl}/agents`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    hostId: options.hostId,
                    agentId: agent.agentId,
                    name: agent.name,
                    model: agent.model
                })
            });
            if (response.ok) {
                synced++;
            }
        }
        catch {
            // Ignore errors for now
        }
    }
    return { synced, agents };
}
export async function createAgentInOpenClaw(agent) {
    let config = await readOpenClawConfig();
    if (!config) {
        config = { bindings: [] };
    }
    try {
        const updated = addBindingToConfig(config, agent);
        await writeOpenClawConfig(updated);
        return true;
    }
    catch {
        return false;
    }
}
export async function deleteAgentFromOpenClaw(agentId) {
    const config = await readOpenClawConfig();
    if (!config) {
        return false;
    }
    try {
        const updated = removeBindingFromConfig(config, agentId);
        await writeOpenClawConfig(updated);
        return true;
    }
    catch {
        return false;
    }
}
export async function getAgentsFromRelay(backendUrl, hostId) {
    try {
        const response = await fetch(`${backendUrl}/agents?hostId=${encodeURIComponent(hostId)}`);
        if (!response.ok)
            return [];
        const data = await response.json();
        return (data.agents ?? []).map(a => ({
            agentId: a.agentId,
            name: a.name,
            model: a.model
        }));
    }
    catch {
        return [];
    }
}
//# sourceMappingURL=agent_sync.js.map