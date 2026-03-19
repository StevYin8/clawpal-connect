import { describe, expect, test } from "vitest";

import { createMockForwardedRequest } from "../src/mock_backend_transport.js";
import type { OpenClawAgentActivity } from "../src/openclaw_session_activity_monitor.js";
import { RuntimeStatusTracker } from "../src/runtime_status_tracker.js";

describe("RuntimeStatusTracker", () => {
  test("initializes deduplicated idle providers", () => {
    const tracker = new RuntimeStatusTracker(["agent-a", " agent-a ", "agent-b", ""]);
    const providers = tracker.getAgentStatusProviders();

    expect(providers.map((provider) => provider.agentId)).toEqual(["agent-a", "agent-b"]);
    expect(providers.every((provider) => provider.displayStatus === "idle")).toBe(true);
  });

  test("marks providers working during a request and idles after completion", () => {
    const tracker = new RuntimeStatusTracker(["agent-a"]);
    const request = createMockForwardedRequest({
      hostId: "host-1",
      userId: "user-1",
      agentId: "agent-a",
      requestId: "req-1",
      conversationId: "conv-1",
      message: "Summarize\nlogs for host"
    });

    tracker.markForwardedRequestStarted(request);

    const provider = tracker.getAgentStatusProviders()[0];
    expect(provider?.displayStatus).toBe("working");
    expect(provider?.currentWorkTitle).toContain("Summarize logs for host");
    expect(provider?.currentWorkSummary).toContain("Summarize logs for host");

    tracker.markForwardedRequestCompleted(request.requestId);

    expect(provider?.displayStatus).toBe("idle");
    expect(provider?.currentWorkTitle).toBeUndefined();
    expect(provider?.currentWorkSummary).toBeUndefined();
  });

  test("tracks multiple active requests and keeps most recent summary", () => {
    const tracker = new RuntimeStatusTracker(["agent-a"]);
    const first = createMockForwardedRequest({
      hostId: "host-1",
      userId: "user-1",
      agentId: "agent-a",
      requestId: "req-1",
      conversationId: "conv-1",
      message: "First request"
    });
    const second = createMockForwardedRequest({
      hostId: "host-1",
      userId: "user-1",
      agentId: "agent-a",
      requestId: "req-2",
      conversationId: "conv-2",
      message: "Second request"
    });

    tracker.markForwardedRequestStarted(first);
    tracker.markForwardedRequestStarted(second);

    const provider = tracker.getAgentStatusProviders()[0];
    expect(provider?.displayStatus).toBe("working");
    expect(provider?.currentWorkSummary).toContain("Second request");
    expect(provider?.currentWorkSummary).toContain("+1 more active request");

    tracker.markForwardedRequestCompleted(second.requestId);
    expect(provider?.currentWorkSummary).toContain("First request");
    expect(provider?.currentWorkSummary).not.toContain("more active request");

    tracker.markForwardedRequestCompleted(first.requestId);
    expect(provider?.displayStatus).toBe("idle");
  });

  test("uses local session activity when no forwarded request is active", () => {
    const tracker = new RuntimeStatusTracker(["agent-a", "agent-b"]);

    tracker.updateOpenClawSessionActivities([
      createActivity({
        agentId: "agent-a",
        signal: "recent-update",
        title: "Direct 最近有会话活动",
        summary: "Direct 最近有会话活动"
      }),
      createActivity({
        agentId: "agent-b",
        signal: "inactive",
        isActive: false
      })
    ]);

    const providers = tracker.getAgentStatusProviders();
    expect(providers[0]?.displayStatus).toBe("working");
    expect(providers[0]?.currentWorkTitle).toBe("Direct 最近有会话活动");
    expect(providers[0]?.currentWorkSummary).toBe("Direct 最近有会话活动");
    expect(providers[1]?.displayStatus).toBe("idle");
    expect(tracker.hasActiveWork()).toBe(true);

    tracker.updateOpenClawSessionActivities([]);
    expect(providers[0]?.displayStatus).toBe("idle");
    expect(providers[0]?.currentWorkTitle).toBeUndefined();
    expect(providers[0]?.currentWorkSummary).toBeUndefined();
    expect(tracker.hasActiveWork()).toBe(false);
  });

  test("keeps forwarded request details as higher priority than local activity", () => {
    const tracker = new RuntimeStatusTracker(["agent-a"]);
    tracker.updateOpenClawSessionActivities([
      createActivity({
        agentId: "agent-a",
        signal: "lock",
        title: "Discord 会话处理中",
        summary: "Discord 会话处理中"
      })
    ]);

    const request = createMockForwardedRequest({
      hostId: "host-1",
      userId: "user-1",
      agentId: "agent-a",
      requestId: "req-1",
      conversationId: "conv-1",
      message: "Handle forwarded priority test"
    });
    tracker.markForwardedRequestStarted(request);

    const provider = tracker.getAgentStatusProviders()[0];
    expect(provider?.displayStatus).toBe("working");
    expect(provider?.currentWorkTitle).toContain("Handle forwarded priority test");
    expect(provider?.currentWorkSummary).toContain("Handle forwarded priority test");

    tracker.markForwardedRequestCompleted(request.requestId);
    expect(provider?.displayStatus).toBe("working");
    expect(provider?.currentWorkTitle).toBe("Discord 会话处理中");
    expect(provider?.currentWorkSummary).toBe("Discord 会话处理中");
  });
});

function createActivity(
  overrides: Partial<OpenClawAgentActivity> & Pick<OpenClawAgentActivity, "agentId" | "signal">
): OpenClawAgentActivity {
  const isActive = overrides.isActive ?? overrides.signal !== "inactive";
  return {
    agentId: overrides.agentId,
    isActive,
    signal: overrides.signal,
    ...(overrides.title ? { title: overrides.title } : {}),
    ...(overrides.summary ? { summary: overrides.summary } : {}),
    ...(typeof overrides.updatedAtMs === "number" ? { updatedAtMs: overrides.updatedAtMs } : {})
  };
}
