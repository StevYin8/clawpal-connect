import { describe, expect, test } from "vitest";

import { HeartbeatManager } from "../src/heartbeat_manager.js";
import type { ConnectorEventInput } from "../src/backend_client.js";
import type { AgentStatusProvider } from "../src/heartbeat_manager.js";

function isAgentRuntimeStatusEvent(
  event: ConnectorEventInput
): event is Extract<ConnectorEventInput, { type: "agent.runtime.status" }> {
  return event.type === "agent.runtime.status";
}

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

  test("sends periodic agent.runtime.status events from providers", async () => {
    const events: ConnectorEventInput[] = [];
    const providers: AgentStatusProvider[] = [
      {
        agentId: "agent-1",
        displayStatus: "working",
        currentWorkTitle: "Handle request",
        currentWorkSummary: "Summarize logs from project",
        providerConnected: false,
        deliveryAvailable: false,
        channelType: "discord",
        channelAccountId: "claw-swe",
        availabilityDetail: "gateway disconnected"
      }
    ];
    const manager = new HeartbeatManager({ intervalMs: 10 });

    const stop = manager.start({
      hostId: "host-1",
      sendEvent: async (event) => {
        events.push(event);
      },
      agentStatusProviders: providers
    });

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });

    providers[0].displayStatus = "idle";
    delete providers[0].currentWorkTitle;
    delete providers[0].currentWorkSummary;

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
    stop();

    const agentEvents = events.filter(isAgentRuntimeStatusEvent);
    expect(agentEvents.length).toBeGreaterThanOrEqual(2);
    expect(agentEvents.some((event) => event.displayStatus === "working")).toBe(true);
    expect(agentEvents.some((event) => event.displayStatus === "idle")).toBe(true);
    expect(agentEvents.some((event) => event.providerConnected === false)).toBe(true);
    expect(agentEvents.some((event) => event.deliveryAvailable === false)).toBe(true);
    expect(agentEvents.some((event) => event.channelType === "discord")).toBe(true);
    expect(agentEvents.some((event) => event.channelAccountId === "claw-swe")).toBe(true);
    expect(agentEvents.some((event) => event.availabilityDetail === "gateway disconnected")).toBe(true);
  });
});
