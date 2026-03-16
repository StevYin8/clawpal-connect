import { describe, expect, test } from "vitest";

import { startPairingSession, waitForPairingCompletion, type PairingSession } from "../src/pairing_client.js";

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json"
    }
  });
}

describe("pairing_session client", () => {
  test("startPairingSession requests a new code and derives a status endpoint", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];

    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({
        url: input instanceof URL ? input.toString() : String(input),
        init
      });

      return jsonResponse(200, {
        sessionId: "session-1",
        code: "abc123",
        pollAfterMs: 1200
      });
    };

    const session = await startPairingSession({
      backendUrl: "https://relay.example",
      hostName: "Dev Mac",
      fetchImpl
    });

    expect(session).toEqual({
      sessionId: "session-1",
      code: "ABC123",
      backendUrl: "https://relay.example/",
      hostName: "Dev Mac",
      createEndpoint: "https://relay.example/connector/pair/session",
      statusEndpoint: "https://relay.example/connector/pair/session/session-1",
      pollAfterMs: 1200
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://relay.example/connector/pair/session");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ connector: { hostName: "Dev Mac" } }));
  });

  test("waitForPairingCompletion polls until binding payload is ready", async () => {
    const session: PairingSession = {
      sessionId: "session-2",
      code: "ZXCV12",
      backendUrl: "https://relay.example/",
      hostName: "Workstation",
      createEndpoint: "https://relay.example/connector/pair/session",
      statusEndpoint: "https://relay.example/connector/pair/session/session-2",
      pollAfterMs: 1
    };

    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse(200, {
          status: "pending",
          pollAfterMs: 1
        });
      }

      return jsonResponse(200, {
        status: "paired",
        binding: {
          hostId: "host-2",
          userId: "user-2",
          hostName: "Workstation",
          backendUrl: "https://relay.example",
          connectorToken: "token-2"
        },
        runtime: {
          gatewayUrl: "http://127.0.0.1:4000",
          heartbeatMs: 45000,
          gatewayTimeoutMs: 7000
        }
      });
    };

    let nowMs = 0;
    const pendingStates: string[] = [];

    const resolved = await waitForPairingCompletion({
      session,
      fetchImpl,
      now: () => nowMs,
      sleep: async (ms) => {
        nowMs += ms;
      },
      onPending: (update) => {
        pendingStates.push(update.status ?? "pending");
      }
    });

    expect(calls).toBe(2);
    expect(pendingStates).toEqual(["pending"]);
    expect(resolved.endpoint).toBe("https://relay.example/connector/pair/session/session-2");
    expect(resolved.binding.hostId).toBe("host-2");
    expect(resolved.binding.userId).toBe("user-2");
    expect(resolved.binding.bindingCode).toBe("ZXCV12");
    expect(resolved.runtimeConfig.gatewayUrl).toBe("http://127.0.0.1:4000");
    expect(resolved.runtimeConfig.heartbeatMs).toBe(45000);
    expect(resolved.runtimeConfig.gatewayTimeoutMs).toBe(7000);
  });

  test("waitForPairingCompletion fails when relay reports terminal status", async () => {
    const session: PairingSession = {
      sessionId: "session-3",
      code: "QWERT1",
      backendUrl: "https://relay.example/",
      hostName: "Laptop",
      createEndpoint: "https://relay.example/connector/pair/session",
      statusEndpoint: "https://relay.example/connector/pair/session/session-3",
      pollAfterMs: 1
    };

    const fetchImpl: typeof fetch = async () => {
      return jsonResponse(200, {
        status: "expired",
        message: "Pairing code expired"
      });
    };

    await expect(
      waitForPairingCompletion({
        session,
        fetchImpl,
        now: () => 0,
        sleep: async () => {}
      })
    ).rejects.toThrow("Pairing code expired");
  });
});
