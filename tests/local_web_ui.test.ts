import { describe, expect, test } from "vitest";

import type { ConnectorDiagnosticsSnapshot } from "../src/web/local_web_ui.js";
import { renderLocalStatusPage } from "../src/web/local_web_ui.js";

describe("local_web_ui", () => {
  test("renders gateway recovery state and latest recovery details", () => {
    const snapshot: ConnectorDiagnosticsSnapshot = {
      generatedAt: "2026-03-24T00:00:00.000Z",
      status: {
        generatedAt: "2026-03-24T00:00:00.000Z",
        gateway: {
          status: "offline",
          ok: false,
          detail: "Gateway probe failed.",
          checkedAt: "2026-03-24T00:00:00.000Z",
          endpoint: "http://127.0.0.1:18789/tools/invoke",
          latencyMs: 12
        },
        gatewayRecovery: {
          running: true,
          phase: "backoff",
          pollIntervalMs: 10_000,
          consecutiveFailureThreshold: 3,
          consecutiveProbeFailures: 4,
          consecutiveRecoveryFailures: 2,
          maxRecoveryAttempts: 5,
          restartCooldownMs: 15_000,
          backoffScheduleMs: [0, 30_000, 120_000, 600_000],
          restartCommand: "openclaw gateway restart",
          nextRecoveryAllowedAt: "2026-03-24T00:01:30.000Z",
          recentRecoveries: [
            {
              id: 2,
              trigger: "consecutive_probe_failures",
              triggeredAt: "2026-03-24T00:00:30.000Z",
              completedAt: "2026-03-24T00:00:31.000Z",
              consecutiveProbeFailures: 4,
              ok: false,
              detail: "openclaw gateway restart exited with code 1, stderr=boom",
              triggerProbe: {
                status: "offline",
                ok: false,
                detail: "Gateway probe failed.",
                checkedAt: "2026-03-24T00:00:30.000Z",
                endpoint: "http://127.0.0.1:18789/tools/invoke",
                latencyMs: 15
              }
            }
          ]
        },
        registry: {
          activeHostId: null,
          hosts: {},
          updatedAt: "2026-03-24T00:00:00.000Z"
        },
        activeHost: null,
        todoBoundaries: ["todo boundary"]
      },
      backend: {
        transport: "ws",
        connected: true,
        sentEvents: 10
      }
    };

    const html = renderLocalStatusPage(snapshot);
    expect(html).toContain("Backoff");
    expect(html).toContain("latest recovery");
    expect(html).toContain("openclaw gateway restart exited with code 1");
    expect(html).toContain("next retry at");
  });
});
