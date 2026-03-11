import { describe, expect, test } from "vitest";

import { HeartbeatManager } from "../src/heartbeat_manager.js";

describe("HeartbeatManager", () => {
  test("sends periodic host.status events", async () => {
    const events: string[] = [];
    const manager = new HeartbeatManager({ intervalMs: 10 });

    const stop = manager.start({
      hostId: "host-1",
      statusProvider: () => "online",
      sendEvent: async (event) => {
        if (event.type === "host.status") {
          events.push(event.status);
        }
      }
    });

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 35);
    });
    stop();

    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.every((value) => value === "online")).toBe(true);
  });
});
