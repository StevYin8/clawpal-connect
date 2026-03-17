export declare const DEFAULT_GATEWAY_TIMEOUT_MS = 8000;
export type GatewayStatus = "online" | "unauthorized" | "offline" | "error";
export interface GatewayProbeResult {
    status: GatewayStatus;
    ok: boolean;
    detail: string;
    checkedAt: string;
    endpoint: string;
    latencyMs: number;
    httpStatus?: number;
}
export interface GatewayDetectorOptions {
    baseUrl: string;
    token?: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
}
export declare function buildToolsInvokeUrl(baseUrl: string): URL;
export declare function classifyGatewayHttpStatus(statusCode: number): GatewayStatus;
export declare function describeGatewayStatus(status: GatewayStatus): string;
export declare class GatewayDetector {
    private readonly endpoint;
    private readonly token;
    private readonly timeoutMs;
    private readonly fetchImpl;
    constructor(options: GatewayDetectorOptions);
    detect(): Promise<GatewayProbeResult>;
}
