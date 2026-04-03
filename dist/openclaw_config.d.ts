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
    accountId?: string | undefined;
}
export type OpenClawAgentResolutionMode = "explicit" | "bindings-only" | "unconfigured";
export interface OpenClawAgentResolution {
    agentId: string;
    mode: OpenClawAgentResolutionMode;
    binding?: OpenClawBinding;
}
export declare function readOpenClawConfig(): Promise<OpenClawConfig | null>;
export declare function writeOpenClawConfig(config: OpenClawConfig): Promise<void>;
export declare function resolveOpenClawAgentResolution(config: OpenClawConfig, agentId: string): OpenClawAgentResolution;
export declare function extractAgentsFromConfig(config: OpenClawConfig): AgentInfo[];
export interface LocalGatewayDefaults {
    gatewayUrl?: string;
    gatewayToken?: string;
}
export declare function extractLocalGatewayDefaults(config: OpenClawConfig): LocalGatewayDefaults;
export declare function addBindingToConfig(config: OpenClawConfig, agent: AgentInfo): OpenClawConfig;
export declare function removeBindingFromConfig(config: OpenClawConfig, agentId: string): OpenClawConfig;
