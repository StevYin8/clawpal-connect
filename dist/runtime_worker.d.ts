import type { ConnectorEventInput, ForwardedRequest } from "./backend_client.js";
import type { GatewayProbeResult } from "./gateway_detector.js";
export type RuntimeEventEmitter = (event: ConnectorEventInput) => Promise<void>;
export type RequestExecutor = (request: ForwardedRequest) => AsyncIterable<string>;
export interface RuntimeWorkerOptions {
    gatewayProbe?: () => Promise<GatewayProbeResult>;
    executeRequest?: RequestExecutor;
}
export declare class RuntimeWorker {
    private readonly gatewayProbe;
    private readonly executeRequest;
    constructor(options?: RuntimeWorkerOptions);
    handleForwardedRequest(request: ForwardedRequest, emit: RuntimeEventEmitter): Promise<void>;
}
