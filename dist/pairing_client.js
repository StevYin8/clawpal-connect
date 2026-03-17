import { hostname } from "node:os";
const DEFAULT_PAIR_RESOLVE_PATHS = [
    "/connector/pair/resolve",
    "/api/connector/pair/resolve",
    "/api/connectors/pair/resolve",
    "/v1/connector/pair/resolve"
];
const DEFAULT_PAIR_SESSION_CREATE_PATHS = [
    "/connector/pair/session",
    "/api/connector/pair/session",
    "/api/connectors/pair/session",
    "/v1/connector/pair/session"
];
const DEFAULT_PAIR_SESSION_POLL_AFTER_MS = 1_500;
const DEFAULT_PAIR_SESSION_WAIT_TIMEOUT_MS = 10 * 60_000;
const COMPLETED_SESSION_STATUSES = new Set([
    "paired",
    "bound",
    "completed",
    "resolved",
    "done",
    "success",
    "succeeded",
    "active"
]);
const PENDING_SESSION_STATUSES = new Set([
    "pending",
    "waiting",
    "created",
    "issued",
    "open",
    "new",
    "in_progress",
    "processing"
]);
const TERMINAL_SESSION_STATUSES = new Set([
    "expired",
    "cancelled",
    "canceled",
    "rejected",
    "failed",
    "error",
    "invalid",
    "closed",
    "timeout",
    "timed_out"
]);
function normalizeRequired(value, field) {
    const next = value.trim();
    if (!next) {
        throw new Error(`${field} cannot be empty.`);
    }
    return next;
}
function normalizeCode(value) {
    return normalizeRequired(value, "Pairing code").toUpperCase();
}
function parseJsonObject(input) {
    const text = input.trim();
    if (!text) {
        return null;
    }
    try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== "object") {
            return null;
        }
        return parsed;
    }
    catch {
        return null;
    }
}
function asRecord(value) {
    if (!value || typeof value !== "object") {
        return null;
    }
    return value;
}
function readString(value, keys) {
    for (const key of keys) {
        const current = value[key];
        if (typeof current === "string" && current.trim()) {
            return current.trim();
        }
    }
    return undefined;
}
function readNumber(value, keys) {
    for (const key of keys) {
        const current = value[key];
        if (typeof current === "number" && Number.isFinite(current)) {
            return Math.trunc(current);
        }
    }
    return undefined;
}
function buildCandidateObjects(payload) {
    const queue = [payload];
    const keys = ["binding", "pairing", "result", "data", "connector", "runtime", "session", "status"];
    for (const key of keys) {
        const direct = asRecord(payload[key]);
        if (direct) {
            queue.push(direct);
        }
    }
    const data = asRecord(payload.data);
    if (data) {
        const nestedKeys = ["binding", "pairing", "runtime", "session", "status", "result"];
        for (const key of nestedKeys) {
            const nested = asRecord(data[key]);
            if (nested) {
                queue.push(nested);
            }
        }
    }
    return queue;
}
function extractErrorMessage(parsed, fallback) {
    if (!parsed) {
        return fallback;
    }
    const direct = readString(parsed, ["message", "detail", "error_description"]);
    if (direct) {
        return direct;
    }
    const errorRecord = asRecord(parsed.error);
    if (errorRecord) {
        const nested = readString(errorRecord, ["message", "detail", "description"]);
        if (nested) {
            return nested;
        }
    }
    return fallback;
}
function withScheme(url) {
    return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}
function parseBackendUrl(url) {
    return new URL(withScheme(normalizeRequired(url, "backendUrl")));
}
function normalizePollAfterMs(value, fallback) {
    if (!Number.isFinite(value) || !value || value <= 0) {
        return fallback;
    }
    return Math.max(250, Math.trunc(value));
}
function normalizeTimeoutMs(value, fallback) {
    if (!Number.isFinite(value) || !value || value <= 0) {
        return fallback;
    }
    return Math.max(1_000, Math.trunc(value));
}
function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
function normalizeStatusValue(status) {
    if (!status) {
        return undefined;
    }
    return status.trim().toLowerCase().replace(/[\s-]+/g, "_");
}
function resolveBindingFromPayload(payload, options) {
    const candidates = buildCandidateObjects(payload);
    const binding = {
        hostId: "",
        userId: "",
        hostName: options.hostName,
        backendUrl: options.fallbackBackendUrl,
        bindingCode: options.code
    };
    const runtimeConfig = {};
    for (const candidate of candidates) {
        const hostId = readString(candidate, ["hostId", "host_id", "connectorHostId", "connector_host_id"]);
        if (hostId && !binding.hostId) {
            binding.hostId = hostId;
        }
        const userId = readString(candidate, ["userId", "user_id", "accountId", "account_id"]);
        if (userId && !binding.userId) {
            binding.userId = userId;
        }
        const hostName = readString(candidate, ["hostName", "host_name", "deviceName", "device_name"]);
        if (hostName && binding.hostName === options.hostName) {
            binding.hostName = hostName;
        }
        const backendUrl = readString(candidate, ["backendUrl", "backend_url", "relayUrl", "relay_url"]);
        if (backendUrl) {
            binding.backendUrl = backendUrl;
        }
        const connectorToken = readString(candidate, [
            "connectorToken",
            "connector_token",
            "token",
            "accessToken",
            "access_token"
        ]);
        if (connectorToken && !binding.connectorToken) {
            binding.connectorToken = connectorToken;
        }
        const gatewayUrl = readString(candidate, [
            "gatewayUrl",
            "gateway_url",
            "openclawGatewayUrl",
            "openclaw_gateway_url"
        ]);
        if (gatewayUrl && !runtimeConfig.gatewayUrl) {
            runtimeConfig.gatewayUrl = gatewayUrl;
        }
        const gatewayToken = readString(candidate, [
            "gatewayToken",
            "gateway_token",
            "openclawGatewayToken",
            "openclaw_gateway_token"
        ]);
        if (gatewayToken && !runtimeConfig.gatewayToken) {
            runtimeConfig.gatewayToken = gatewayToken;
        }
        const heartbeatMs = readNumber(candidate, ["heartbeatMs", "heartbeat_ms"]);
        if (heartbeatMs && !runtimeConfig.heartbeatMs) {
            runtimeConfig.heartbeatMs = heartbeatMs;
        }
        const gatewayTimeoutMs = readNumber(candidate, ["gatewayTimeoutMs", "gateway_timeout_ms", "timeoutMs", "timeout_ms"]);
        if (gatewayTimeoutMs && !runtimeConfig.gatewayTimeoutMs) {
            runtimeConfig.gatewayTimeoutMs = gatewayTimeoutMs;
        }
    }
    if (!binding.hostId || !binding.userId) {
        return null;
    }
    return { binding, runtimeConfig };
}
function resolvePairingSessionFromPayload(payload) {
    const candidates = buildCandidateObjects(payload);
    let sessionId;
    let code;
    let statusEndpoint;
    let expiresAt;
    let pollAfterMs;
    for (const candidate of candidates) {
        if (!sessionId) {
            sessionId = readString(candidate, ["sessionId", "session_id", "pairSessionId", "pair_session_id", "pairingSessionId", "pairing_session_id", "id"]);
        }
        if (!code) {
            code = readString(candidate, ["code", "pairCode", "pair_code", "pairingCode", "pairing_code", "bindingCode"]);
        }
        if (!statusEndpoint) {
            statusEndpoint = readString(candidate, [
                "statusEndpoint",
                "status_endpoint",
                "statusUrl",
                "status_url",
                "sessionUrl",
                "session_url",
                "pollUrl",
                "poll_url"
            ]);
        }
        if (!expiresAt) {
            expiresAt = readString(candidate, ["expiresAt", "expires_at", "expireAt", "expire_at"]);
        }
        if (!pollAfterMs) {
            pollAfterMs = readNumber(candidate, [
                "pollAfterMs",
                "poll_after_ms",
                "retryAfterMs",
                "retry_after_ms",
                "nextPollMs",
                "next_poll_ms"
            ]);
        }
    }
    if (!sessionId || !code) {
        return null;
    }
    const resolved = {
        sessionId,
        code: normalizeCode(code),
        ...(statusEndpoint ? { statusEndpoint } : {}),
        ...(expiresAt ? { expiresAt } : {}),
        ...(pollAfterMs ? { pollAfterMs } : {})
    };
    return resolved;
}
function deriveStatusEndpoint(createEndpoint, sessionId) {
    const url = new URL(createEndpoint);
    const basePath = url.pathname.replace(/\/+$/g, "");
    url.pathname = `${basePath}/${encodeURIComponent(sessionId)}`;
    url.search = "";
    return url.toString();
}
function resolveEndpointOrPath(value, backendUrl) {
    if (!value) {
        return undefined;
    }
    try {
        return new URL(value, backendUrl).toString();
    }
    catch {
        return undefined;
    }
}
function resolvePairingSessionStatus(payload) {
    const candidates = buildCandidateObjects(payload);
    for (const candidate of candidates) {
        const status = readString(candidate, ["status", "state", "pairingStatus", "pairing_status", "sessionStatus", "session_status"]);
        if (status) {
            return status;
        }
    }
    return undefined;
}
function resolvePollAfterMsFromPayload(payload) {
    const candidates = buildCandidateObjects(payload);
    for (const candidate of candidates) {
        const pollAfterMs = readNumber(candidate, [
            "pollAfterMs",
            "poll_after_ms",
            "retryAfterMs",
            "retry_after_ms",
            "nextPollMs",
            "next_poll_ms"
        ]);
        if (pollAfterMs) {
            return pollAfterMs;
        }
    }
    return undefined;
}
function classifyPairingPayload(payload, options) {
    const resolved = resolveBindingFromPayload(payload, options);
    if (resolved) {
        return {
            kind: "resolved",
            resolution: resolved
        };
    }
    const statusRaw = resolvePairingSessionStatus(payload);
    const status = normalizeStatusValue(statusRaw);
    if (status && TERMINAL_SESSION_STATUSES.has(status)) {
        return {
            kind: "terminal",
            status,
            message: extractErrorMessage(payload, `Pairing session ended with status=${status}.`)
        };
    }
    if (status && COMPLETED_SESSION_STATUSES.has(status)) {
        return {
            kind: "terminal",
            status,
            message: "Pairing session reported completion but host binding payload is missing hostId/userId."
        };
    }
    const pendingStatus = status ?? statusRaw;
    const pollAfterMs = resolvePollAfterMsFromPayload(payload);
    if (!pendingStatus || PENDING_SESSION_STATUSES.has(pendingStatus)) {
        return {
            kind: "pending",
            ...(pendingStatus ? { status: pendingStatus } : {}),
            ...(pollAfterMs ? { pollAfterMs } : {})
        };
    }
    return {
        kind: "pending",
        status: pendingStatus,
        ...(pollAfterMs ? { pollAfterMs } : {})
    };
}
function buildStatusEndpointCandidates(session) {
    const candidates = [];
    const push = (value) => {
        if (!candidates.includes(value)) {
            candidates.push(value);
        }
    };
    push(session.statusEndpoint);
    push(deriveStatusEndpoint(session.createEndpoint, session.sessionId));
    const queryEndpoint = new URL(session.createEndpoint);
    queryEndpoint.searchParams.set("sessionId", session.sessionId);
    push(queryEndpoint.toString());
    return candidates;
}
async function probePairingSession(options) {
    const endpoints = buildStatusEndpointCandidates(options.session);
    let lastError = null;
    for (const endpoint of endpoints) {
        let parsed = null;
        try {
            const response = await options.fetchImpl(endpoint, {
                method: "GET",
                headers: {
                    Accept: "application/json"
                }
            });
            parsed = parseJsonObject(await response.text());
            if (!response.ok) {
                if (response.status === 404 || response.status === 405) {
                    lastError = `Pair session status API path not found at ${endpoint}.`;
                    continue;
                }
                if (parsed) {
                    const classification = classifyPairingPayload(parsed, {
                        fallbackBackendUrl: options.session.backendUrl,
                        code: options.session.code,
                        hostName: options.session.hostName
                    });
                    if (classification.kind === "resolved") {
                        return {
                            kind: "resolved",
                            endpoint,
                            resolution: {
                                ...classification.resolution,
                                endpoint
                            }
                        };
                    }
                    if (classification.kind === "terminal") {
                        return {
                            kind: "terminal",
                            endpoint,
                            ...(classification.status ? { status: classification.status } : {}),
                            message: classification.message
                        };
                    }
                    return {
                        kind: "pending",
                        endpoint,
                        ...(classification.status ? { status: classification.status } : {}),
                        ...(classification.message ? { message: classification.message } : {}),
                        ...(classification.pollAfterMs ? { pollAfterMs: classification.pollAfterMs } : {})
                    };
                }
                throw new Error(`Pair session status request failed with HTTP ${response.status}.`);
            }
            if (!parsed) {
                return {
                    kind: "pending",
                    endpoint
                };
            }
            const classification = classifyPairingPayload(parsed, {
                fallbackBackendUrl: options.session.backendUrl,
                code: options.session.code,
                hostName: options.session.hostName
            });
            if (classification.kind === "resolved") {
                return {
                    kind: "resolved",
                    endpoint,
                    resolution: {
                        ...classification.resolution,
                        endpoint
                    }
                };
            }
            if (classification.kind === "terminal") {
                return {
                    kind: "terminal",
                    endpoint,
                    ...(classification.status ? { status: classification.status } : {}),
                    message: classification.message
                };
            }
            return {
                kind: "pending",
                endpoint,
                ...(classification.status ? { status: classification.status } : {}),
                ...(classification.message ? { message: classification.message } : {}),
                ...(classification.pollAfterMs ? { pollAfterMs: classification.pollAfterMs } : {})
            };
        }
        catch (error) {
            if (error instanceof Error) {
                lastError = error.message;
            }
            else {
                lastError = String(error);
            }
        }
    }
    throw new Error(lastError ?? "Failed to query pairing session status against relay backend.");
}
export async function startPairingSession(options) {
    const backendUrl = parseBackendUrl(options.backendUrl).toString();
    const hostId = normalizeRequired(options.hostId, "hostId");
    const hostName = options.hostName?.trim() || hostname();
    const fetchImpl = options.fetchImpl ?? fetch;
    const paths = options.paths ?? DEFAULT_PAIR_SESSION_CREATE_PATHS;
    let lastError = null;
    for (const path of paths) {
        const endpoint = new URL(path, backendUrl).toString();
        let parsed = null;
        try {
            const response = await fetchImpl(endpoint, {
                method: "POST",
                headers: {
                    Accept: "application/json",
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    hostId,
                    hostName,
                    connector: {
                        hostId,
                        hostName
                    }
                })
            });
            parsed = parseJsonObject(await response.text());
            if (!response.ok) {
                if (response.status === 404 || response.status === 405) {
                    lastError = `Pair session API path not found at ${endpoint}.`;
                    continue;
                }
                throw new Error(extractErrorMessage(parsed, `Pair session request failed with HTTP ${response.status}.`));
            }
            if (!parsed) {
                throw new Error("Pair session API response body was empty.");
            }
            const session = resolvePairingSessionFromPayload(parsed);
            if (!session) {
                throw new Error("Pair session API response did not include sessionId/code.");
            }
            const resolvedStatusEndpoint = resolveEndpointOrPath(session.statusEndpoint, backendUrl) ?? deriveStatusEndpoint(endpoint, session.sessionId);
            return {
                sessionId: session.sessionId,
                code: session.code,
                backendUrl,
                hostId,
                hostName,
                createEndpoint: endpoint,
                statusEndpoint: resolvedStatusEndpoint,
                ...(session.expiresAt ? { expiresAt: session.expiresAt } : {}),
                pollAfterMs: normalizePollAfterMs(session.pollAfterMs, DEFAULT_PAIR_SESSION_POLL_AFTER_MS)
            };
        }
        catch (error) {
            if (error instanceof Error) {
                lastError = error.message;
            }
            else {
                lastError = String(error);
            }
        }
    }
    throw new Error(lastError ?? "Failed to create pairing session against relay backend.");
}
export async function waitForPairingCompletion(options) {
    const fetchImpl = options.fetchImpl ?? fetch;
    const timeoutMs = normalizeTimeoutMs(options.timeoutMs, DEFAULT_PAIR_SESSION_WAIT_TIMEOUT_MS);
    const defaultPollAfterMs = normalizePollAfterMs(options.pollAfterMs, options.session.pollAfterMs);
    const now = options.now ?? Date.now;
    const sleepImpl = options.sleep ?? sleep;
    const startedAt = now();
    let attempt = 0;
    let nextPollAfterMs = 0;
    while (true) {
        if (attempt > 0) {
            await sleepImpl(nextPollAfterMs);
        }
        if (now() - startedAt > timeoutMs) {
            throw new Error(`Timed out waiting for pairing completion after ${timeoutMs}ms.`);
        }
        const probe = await probePairingSession({
            session: options.session,
            fetchImpl
        });
        if (probe.kind === "resolved") {
            return probe.resolution;
        }
        if (probe.kind === "terminal") {
            throw new Error(probe.message);
        }
        const pollAfterMs = normalizePollAfterMs(probe.pollAfterMs, defaultPollAfterMs);
        if (options.onPending) {
            await options.onPending({
                attempt: attempt + 1,
                endpoint: probe.endpoint,
                pollAfterMs,
                ...(probe.status ? { status: probe.status } : {}),
                ...(probe.message ? { message: probe.message } : {})
            });
        }
        nextPollAfterMs = pollAfterMs;
        attempt += 1;
    }
}
export async function resolvePairingCode(options) {
    const backendUrl = parseBackendUrl(options.backendUrl).toString();
    const code = normalizeCode(options.code);
    const hostName = options.hostName?.trim() || hostname();
    const fetchImpl = options.fetchImpl ?? fetch;
    const paths = options.paths ?? DEFAULT_PAIR_RESOLVE_PATHS;
    let lastError = null;
    for (const path of paths) {
        const endpoint = new URL(path, backendUrl).toString();
        let parsed = null;
        try {
            const response = await fetchImpl(endpoint, {
                method: "POST",
                headers: {
                    Accept: "application/json",
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    code,
                    connector: {
                        hostName
                    }
                })
            });
            parsed = parseJsonObject(await response.text());
            if (!response.ok) {
                if (response.status === 404 || response.status === 405) {
                    lastError = `Pair API path not found at ${endpoint}.`;
                    continue;
                }
                throw new Error(extractErrorMessage(parsed, `Pair request failed with HTTP ${response.status}.`));
            }
            const resolution = parsed
                ? resolveBindingFromPayload(parsed, {
                    fallbackBackendUrl: backendUrl,
                    code,
                    hostName
                })
                : null;
            if (!resolution) {
                throw new Error("Pair API response did not include hostId/userId.");
            }
            return {
                ...resolution,
                endpoint
            };
        }
        catch (error) {
            if (error instanceof Error) {
                lastError = error.message;
            }
            else {
                lastError = String(error);
            }
        }
    }
    throw new Error(lastError ?? "Failed to resolve pairing code against relay backend.");
}
//# sourceMappingURL=pairing_client.js.map