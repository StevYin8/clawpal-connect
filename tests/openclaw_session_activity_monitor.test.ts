import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { OpenClawSessionActivityMonitor } from "../src/openclaw_session_activity_monitor.js";

const NOW_MS = Date.parse("2026-03-19T12:00:00.000Z");

describe("OpenClawSessionActivityMonitor", () => {
  test("prioritizes active lock files and exposes provider-based summary", async () => {
    const fixture = await createSessionFixture({
      agentId: "agent-a",
      sessionId: "session-1",
      updatedAtMs: NOW_MS - 15_000,
      chatType: "direct",
      origin: {
        provider: "discord",
        from: "discord:user-1",
        to: "channel:123"
      },
      lockContent: JSON.stringify({
        pid: process.pid,
        createdAt: new Date(NOW_MS - 10_000).toISOString()
      })
    });

    try {
      const monitor = new OpenClawSessionActivityMonitor({
        agentIds: ["agent-a"],
        agentsRootDir: fixture.agentsRoot,
        now: () => new Date(NOW_MS)
      });

      const [activity] = await monitor.refresh();
      expect(activity).toMatchObject({
        agentId: "agent-a",
        isActive: true,
        signal: "lock",
        title: "Discord 会话处理中"
      });
      expect(activity?.summary).toContain("Discord 会话处理中");
      expect(activity?.summary).toContain("discord:user-1 -> channel:123");
    } finally {
      await fixture.cleanup();
    }
  });

  test("falls back to recent update activity when no lock signal exists", async () => {
    const fixture = await createSessionFixture({
      agentId: "agent-a",
      sessionId: "session-2",
      updatedAtMs: NOW_MS - 45_000,
      chatType: "direct",
      origin: {
        chatType: "direct"
      }
    });

    try {
      const monitor = new OpenClawSessionActivityMonitor({
        agentIds: ["agent-a"],
        agentsRootDir: fixture.agentsRoot,
        now: () => new Date(NOW_MS)
      });

      const [activity] = await monitor.refresh();
      expect(activity).toMatchObject({
        agentId: "agent-a",
        isActive: true,
        signal: "recent-update",
        title: "Direct 最近有会话活动"
      });
    } finally {
      await fixture.cleanup();
    }
  });

  test("marks inactive when session metadata is stale", async () => {
    const fixture = await createSessionFixture({
      agentId: "agent-a",
      sessionId: "session-3",
      updatedAtMs: NOW_MS - 10 * 60_000,
      chatType: "direct",
      origin: {
        provider: "discord"
      }
    });

    try {
      const monitor = new OpenClawSessionActivityMonitor({
        agentIds: ["agent-a"],
        agentsRootDir: fixture.agentsRoot,
        now: () => new Date(NOW_MS)
      });

      const [activity] = await monitor.refresh();
      expect(activity).toMatchObject({
        agentId: "agent-a",
        isActive: false,
        signal: "inactive"
      });
      expect(activity?.title).toBeUndefined();
      expect(activity?.summary).toBeUndefined();
    } finally {
      await fixture.cleanup();
    }
  });

  test("uses cron-specific wording when metadata indicates cron origin", async () => {
    const fixture = await createSessionFixture({
      agentId: "agent-a",
      sessionId: "session-4",
      updatedAtMs: NOW_MS - 20_000,
      chatType: "cron",
      origin: {
        provider: "cron"
      },
      lockContent: JSON.stringify({
        pid: process.pid,
        createdAt: new Date(NOW_MS - 5_000).toISOString()
      })
    });

    try {
      const monitor = new OpenClawSessionActivityMonitor({
        agentIds: ["agent-a"],
        agentsRootDir: fixture.agentsRoot,
        now: () => new Date(NOW_MS)
      });

      const [activity] = await monitor.refresh();
      expect(activity).toMatchObject({
        agentId: "agent-a",
        isActive: true,
        signal: "lock",
        title: "Cron 任务执行中"
      });
    } finally {
      await fixture.cleanup();
    }
  });
});

interface SessionFixtureOptions {
  agentId: string;
  sessionId: string;
  updatedAtMs: number;
  chatType: string;
  origin: {
    provider?: string;
    surface?: string;
    chatType?: string;
    from?: string;
    to?: string;
    accountId?: string;
  };
  lockContent?: string;
}

async function createSessionFixture(options: SessionFixtureOptions): Promise<{
  agentsRoot: string;
  cleanup: () => Promise<void>;
}> {
  const tempDir = await mkdtemp(join(tmpdir(), "clawpal-session-monitor-"));
  const agentsRoot = join(tempDir, "agents");
  const sessionsDir = join(agentsRoot, options.agentId, "sessions");
  const sessionFile = join(sessionsDir, `${options.sessionId}.jsonl`);

  await mkdir(sessionsDir, { recursive: true });
  await writeFile(sessionFile, "", "utf-8");
  await writeFile(
    join(sessionsDir, "sessions.json"),
    JSON.stringify(
      {
        [`agent:${options.agentId}:main`]: {
          sessionId: options.sessionId,
          updatedAt: options.updatedAtMs,
          chatType: options.chatType,
          origin: options.origin,
          sessionFile
        }
      },
      null,
      2
    ),
    "utf-8"
  );

  if (options.lockContent) {
    await writeFile(`${sessionFile}.lock`, options.lockContent, "utf-8");
  }

  return {
    agentsRoot,
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    }
  };
}
