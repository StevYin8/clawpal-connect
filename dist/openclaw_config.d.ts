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
export declare function readOpenClawConfig(): Promise<OpenClawConfig | null>;
export declare function writeOpenClawConfig(config: OpenClawConfig): Promise<void>;
export declare function extractAgentsFromConfig(config: OpenClawConfig): AgentInfo[];
export interface LocalGatewayDefaults {
    gatewayUrl?: string;
    gatewayToken?: string;
}
export declare function extractLocalGatewayDefaults(config: OpenClawConfig): LocalGatewayDefaults;
export declare function addBindingToConfig(config: OpenClawConfig, agent: AgentInfo): OpenClawConfig;
export declare function removeBindingFromConfig(config: OpenClawConfig, agentId: string): OpenClawConfig;
