import { describe, expect, test } from "vitest";

import { extractLocalGatewayDefaults } from "../src/openclaw_config.js";

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
