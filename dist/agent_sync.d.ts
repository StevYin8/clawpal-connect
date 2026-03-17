import type { AgentInfo } from "./openclaw_config.js";
export interface AgentSyncOptions {
    backendUrl: string;
    hostId: string;
}
export interface AgentSyncResult {
    synced: number;
    agents: AgentInfo[];
}
export declare function syncAgentsToRelay(options: AgentSyncOptions): Promise<AgentSyncResult>;
export declare function createAgentInOpenClaw(agent: AgentInfo): Promise<boolean>;
export declare function deleteAgentFromOpenClaw(agentId: string): Promise<boolean>;
export declare function getAgentsFromRelay(backendUrl: string, hostId: string): Promise<AgentInfo[]>;
