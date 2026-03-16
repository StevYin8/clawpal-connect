import { describe, expect, test } from "vitest";

import { resolveRelayWsBaseUrl } from "../src/ws_backend_transport.js";

describe("resolveRelayWsBaseUrl", () => {
  test("maps relay HTTP API port 3001 to WS port 8788", () => {
    expect(resolveRelayWsBaseUrl("http://120.55.96.42:3001")).toBe(
      "ws://120.55.96.42:8788",
    );
  });

  test("keeps non-3001 ports while switching protocol", () => {
    expect(resolveRelayWsBaseUrl("https://relay.example:443")).toBe(
      "wss://relay.example",
    );
  });
});
