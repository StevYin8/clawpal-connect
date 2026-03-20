import { describe, expect, test } from "vitest";

import { extractLocalGatewayDefaults, resolveOpenClawAgentResolution } from "../src/openclaw_config.js";

describe("extractLocalGatewayDefaults", () => {
  test("extracts gateway url and token from OpenClaw config", () => {
    const defaults = extractLocalGatewayDefaults({
      bindings: [],
      gateway: {
        port: 18789,
        auth: {
          token: "gw-token",
        },
      },
    });

    expect(defaults.gatewayUrl).toBe("http://127.0.0.1:18789");
    expect(defaults.gatewayToken).toBe("gw-token");
  });
});

describe("resolveOpenClawAgentResolution", () => {
  test("returns explicit for agent ids configured in agents.list", () => {
    const resolved = resolveOpenClawAgentResolution(
      {
        bindings: [{ agentId: "claw-tax", match: { channel: "dingtalk" } }],
        agents: {
          list: [{ id: "claw-tax", default: true }]
        }
      },
      "claw-tax"
    );

    expect(resolved.mode).toBe("explicit");
    expect(resolved.binding).toBeUndefined();
  });

  test("returns bindings-only when agent id is only present in bindings", () => {
    const resolved = resolveOpenClawAgentResolution(
      {
        bindings: [{ agentId: "claw-tax", match: { channel: "dingtalk", accountId: "acct-1" } }]
      },
      "claw-tax"
    );

    expect(resolved.mode).toBe("bindings-only");
    expect(resolved.binding).toEqual({
      agentId: "claw-tax",
      match: { channel: "dingtalk", accountId: "acct-1" }
    });
  });
});
