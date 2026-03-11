import type { ConnectorEventInput, ForwardedRequest } from "./backend_client.js";
import type { GatewayProbeResult } from "./gateway_detector.js";

export type RuntimeEventEmitter = (event: ConnectorEventInput) => Promise<void>;

export type RequestExecutor = (request: ForwardedRequest) => AsyncIterable<string>;

export interface RuntimeWorkerOptions {
  gatewayProbe?: () => Promise<GatewayProbeResult>;
  executeRequest?: RequestExecutor;
}

function splitIntoChunks(input: string, chunkSize = 18): string[] {
  if (!input) {
    return [];
  }

  const chunks: string[] = [];
  for (let cursor = 0; cursor < input.length; cursor += chunkSize) {
    chunks.push(input.slice(cursor, cursor + chunkSize));
  }
  return chunks;
}

async function* defaultRequestExecutor(request: ForwardedRequest): AsyncGenerator<string> {
  const output = `Mock OpenClaw bridge handled: ${request.message}`;
  for (const chunk of splitIntoChunks(output)) {
    yield chunk;
  }
}

function mapGatewayFailureCode(status: GatewayProbeResult["status"]): string {
  switch (status) {
    case "offline":
      return "gateway_offline";
    case "unauthorized":
      return "gateway_unauthorized";
    case "error":
      return "gateway_error";
    case "online":
      return "gateway_unknown";
  }
}

export class RuntimeWorker {
  private readonly gatewayProbe: () => Promise<GatewayProbeResult>;
  private readonly executeRequest: RequestExecutor;

  constructor(options: RuntimeWorkerOptions = {}) {
    this.gatewayProbe =
      options.gatewayProbe ??
      (async () => ({
        status: "online",
        ok: true,
        detail: "Gateway probe bypassed in runtime worker.",
        checkedAt: new Date().toISOString(),
        endpoint: "mock://gateway",
        latencyMs: 0
      }));
    this.executeRequest = options.executeRequest ?? defaultRequestExecutor;
  }

  async handleForwardedRequest(request: ForwardedRequest, emit: RuntimeEventEmitter): Promise<void> {
    const gateway = await this.gatewayProbe();

    if (!gateway.ok) {
      await emit({
        type: "message.error",
        requestId: request.requestId,
        hostId: request.hostId,
        conversationId: request.conversationId,
        code: mapGatewayFailureCode(gateway.status),
        message: `OpenClaw gateway unavailable: ${gateway.detail}`
      });
      return;
    }

    await emit({
      type: "message.start",
      requestId: request.requestId,
      hostId: request.hostId,
      userId: request.userId,
      conversationId: request.conversationId
    });

    let output = "";
    let sequence = 0;

    try {
      for await (const chunk of this.executeRequest(request)) {
        if (!chunk) {
          continue;
        }

        sequence += 1;
        output += chunk;
        await emit({
          type: "message.delta",
          requestId: request.requestId,
          hostId: request.hostId,
          conversationId: request.conversationId,
          sequence,
          delta: chunk
        });
      }

      await emit({
        type: "message.done",
        requestId: request.requestId,
        hostId: request.hostId,
        conversationId: request.conversationId,
        output
      });
    } catch (error) {
      await emit({
        type: "message.error",
        requestId: request.requestId,
        hostId: request.hostId,
        conversationId: request.conversationId,
        code: "runtime_execution_failed",
        message: error instanceof Error ? error.message : "Unknown runtime worker error"
      });
    }
  }
}

// TODO(official-backend): replace mock request executor with real OpenClaw streaming bridge.
