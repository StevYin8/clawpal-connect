function splitIntoChunks(input, chunkSize = 18) {
    if (!input) {
        return [];
    }
    const chunks = [];
    for (let cursor = 0; cursor < input.length; cursor += chunkSize) {
        chunks.push(input.slice(cursor, cursor + chunkSize));
    }
    return chunks;
}
async function* defaultRequestExecutor(request) {
    const output = `Mock OpenClaw bridge handled: ${request.message}`;
    for (const chunk of splitIntoChunks(output)) {
        yield chunk;
    }
}
function mapGatewayFailureCode(status) {
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
    gatewayProbe;
    executeRequest;
    constructor(options = {}) {
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
    async handleForwardedRequest(request, emit) {
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
        }
        catch (error) {
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
//# sourceMappingURL=runtime_worker.js.map