import { describe, expect, test } from "vitest";

import { createMockForwardedRequest } from "../src/mock_backend_transport.js";
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
});
