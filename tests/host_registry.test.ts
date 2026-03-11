import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  HostRegistry,
  removeRegisteredHost,
  upsertRegisteredHost,
  type RegisteredHost
} from "../src/host_registry.js";

function host(input: Partial<RegisteredHost> = {}): RegisteredHost {
  return {
    hostId: input.hostId ?? "host-1",
    userId: input.userId ?? "user-1",
    hostName: input.hostName ?? "Mac Mini",
    backendUrl: input.backendUrl ?? "https://relay.clawpal.example",
    boundAt: input.boundAt ?? "2026-03-11T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-03-11T00:00:00.000Z",
    ...(input.connectorToken ? { connectorToken: input.connectorToken } : {}),
    ...(input.bindingCode ? { bindingCode: input.bindingCode } : {})
  };
}

describe("host_registry pure helpers", () => {
  test("upsertRegisteredHost inserts or replaces by host id", () => {
    const hosts = upsertRegisteredHost(
      { "host-1": host({ hostName: "Old Host" }) },
      host({ hostId: "host-1", hostName: "New Host" })
    );

    expect(Object.keys(hosts)).toEqual(["host-1"]);
    expect(hosts["host-1"]?.hostName).toBe("New Host");
  });

  test("removeRegisteredHost removes only targeted host", () => {
    const hosts = removeRegisteredHost(
      {
        "host-1": host({ hostId: "host-1" }),
        "host-2": host({ hostId: "host-2" })
      },
      "host-2"
    );

    expect(Object.keys(hosts)).toEqual(["host-1"]);
  });
});

describe("HostRegistry persistence", () => {
  test("bindHost persists active host", async () => {
    const root = await mkdtemp(join(tmpdir(), "clawpal-connect-host-registry-"));
    try {
      const filePath = join(root, "registry.json");
      const registry = new HostRegistry({
        filePath,
        now: () => new Date("2026-03-11T01:00:00.000Z")
      });

      await registry.bindHost({
        hostId: "host-a",
        hostName: "Workstation",
        userId: "user-a",
        backendUrl: "https://relay.clawpal.example"
      });

      const active = await registry.getActiveHost();
      expect(active?.hostId).toBe("host-a");

      const state = await registry.loadState();
      expect(state.activeHostId).toBe("host-a");
      expect(Object.keys(state.hosts)).toEqual(["host-a"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
