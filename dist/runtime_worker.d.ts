import { type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import type { ConnectorEventInput, ForwardedRequest } from "./backend_client.js";
import type { GatewayProbeResult } from "./gateway_detector.js";
export type RuntimeEventEmitter = (event: ConnectorEventInput) => Promise<void>;
export type RequestExecutor = (request: ForwardedRequest) => AsyncIterable<string>;
type SpawnOpenClawProcess = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcessWithoutNullStreams;
export interface OpenClawRequestExecutorOptions {
    gatewayUrl?: string;
    gatewayToken?: string;
    openClawBinary?: string;
    fetchImpl?: typeof fetch;
    spawnImpl?: SpawnOpenClawProcess;
    env?: NodeJS.ProcessEnv;
}
export interface RuntimeWorkerOptions {
    gatewayProbe?: () => Promise<GatewayProbeResult>;
    executeRequest?: RequestExecutor;
    openClaw?: OpenClawRequestExecutorOptions;
}
export declare function createOpenClawRequestExecutor(options?: OpenClawRequestExecutorOptions): RequestExecutor;
export declare class RuntimeWorker {
    private readonly gatewayProbe;
    private readonly executeRequest;
    constructor(options?: RuntimeWorkerOptions);
    handleForwardedRequest(request: ForwardedRequest, emit: RuntimeEventEmitter): Promise<void>;
}
export {};
