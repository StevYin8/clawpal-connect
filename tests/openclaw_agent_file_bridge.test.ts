import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  OpenClawAgentFileBridgeService,
  OpenClawAgentFileRevisionConflictError,
  type OpenClawAgentFileBridgeDescriptor
} from "../src/openclaw_agent_file_bridge.js";

interface BridgeFixture {
  tempDir: string;
  stateDir: string;
  configPath: string;
  workspaceDir: string;
  bridge: OpenClawAgentFileBridgeService;
}

async function createFixture(configContent: string): Promise<BridgeFixture> {
  const tempDir = await mkdtemp(join(tmpdir(), "clawpal-openclaw-file-bridge-"));
  const stateDir = join(tempDir, ".openclaw");
  const configPath = join(stateDir, "openclaw.json");
  const workspaceDir = join(stateDir, "workspace");

  await mkdir(stateDir, { recursive: true });
  await writeFile(configPath, configContent, "utf-8");

  const bridge = new OpenClawAgentFileBridgeService({ stateDir, configPath });

  return {
    tempDir,
    stateDir,
    configPath,
    workspaceDir,
    bridge
  };
}

function indexByBridgePath(files: OpenClawAgentFileBridgeDescriptor[]): Map<string, OpenClawAgentFileBridgeDescriptor> {
  return new Map(files.map((file) => [file.bridgePath, file]));
}

describe("OpenClawAgentFileBridgeService", () => {
  test("lists config/workspace/memory/skills bridge files", async () => {
    const fixture = await createFixture(`{
      // trailing-comma + comments should parse
      "agents": {
        "defaults": {
          "workspace": "${join(tmpdir(), "placeholder")}",
        },
      },
    }`);

    try {
      const workspaceDir = fixture.workspaceDir;
      await mkdir(join(workspaceDir, "memory"), { recursive: true });
      await mkdir(join(workspaceDir, "skills", "local-skill"), { recursive: true });
      await mkdir(join(fixture.stateDir, "skills", "shared-skill", "config"), { recursive: true });

      await writeFile(fixture.configPath, `{
        "agents": {
          "defaults": {
            "workspace": "${workspaceDir}",
          },
        },
      }`, "utf-8");

      await writeFile(join(workspaceDir, "AGENTS.md"), "rules", "utf-8");
      await writeFile(join(workspaceDir, "SOUL.md"), "soul", "utf-8");
      await writeFile(join(workspaceDir, "IDENTITY.md"), "identity", "utf-8");
      await writeFile(join(workspaceDir, "MEMORY.md"), "memory", "utf-8");
      await writeFile(join(workspaceDir, "memory", "2026-03-19.md"), "daily", "utf-8");
      await writeFile(join(workspaceDir, "skills", "local-skill", "SKILL.md"), "local-skill", "utf-8");
      await writeFile(join(fixture.stateDir, "skills", "shared-skill", "SKILL.md"), "shared-skill", "utf-8");
      await writeFile(join(fixture.stateDir, "skills", "shared-skill", "config", "settings.yaml"), "key: value", "utf-8");

      const listed = await fixture.bridge.listAgentFiles({ agentId: "main" });
      expect(listed.workspaceDir).toBe(workspaceDir);

      const byPath = indexByBridgePath(listed.files);
      expect(byPath.get("config/openclaw.json")?.exists).toBe(true);
      expect(byPath.get("workspace/AGENTS.md")?.category).toBe("personality");
      expect(byPath.get("workspace/SOUL.md")?.category).toBe("soul");
      expect(byPath.get("workspace/IDENTITY.md")?.category).toBe("identity");
      expect(byPath.get("workspace/MEMORY.md")?.category).toBe("memory");
      expect(byPath.get("workspace/memory/2026-03-19.md")?.exists).toBe(true);
      expect(byPath.get("workspace/skills/local-skill/SKILL.md")?.domain).toBe("workspace-skill");
      expect(byPath.get("shared-skills/shared-skill/SKILL.md")?.domain).toBe("shared-skill");
      expect(byPath.get("shared-skills/shared-skill/config/settings.yaml")?.exists).toBe(true);
    } finally {
      await rm(fixture.tempDir, { recursive: true, force: true });
    }
  });

  test("uses defaults.workspace as primary fallback when agents.list is absent", async () => {
    const fixture = await createFixture(`{
      "agents": {
        "defaults": {
          "workspace": "${join(tmpdir(), "shared-workspace")}" 
        }
      }
    }`);

    try {
      await mkdir(fixture.workspaceDir, { recursive: true });
      await writeFile(fixture.configPath, `{
        "agents": {
          "defaults": {
            "workspace": "${fixture.workspaceDir}"
          }
        }
      }`, 'utf-8');
      await writeFile(join(fixture.workspaceDir, 'SOUL.md'), 'shared soul', 'utf-8');

      const listed = await fixture.bridge.listAgentFiles({ agentId: 'claw-tax' });
      expect(listed.agentId).toBe('claw-tax');
      expect(listed.workspaceDir).toBe(fixture.workspaceDir);
      expect(indexByBridgePath(listed.files).get('workspace/SOUL.md')?.exists).toBe(true);
    } finally {
      await rm(fixture.tempDir, { recursive: true, force: true });
    }
  });

  test("reads and writes files with optimistic revision checks", async () => {
    const fixture = await createFixture(`{
      "agents": {
        "defaults": {
          "workspace": "${join(tmpdir(), "will-be-overridden")}",
        },
      },
    }`);

    try {
      await mkdir(fixture.workspaceDir, { recursive: true });
      await writeFile(fixture.configPath, `{
        "agents": {
          "defaults": {
            "workspace": "${fixture.workspaceDir}",
          },
        },
      }`, "utf-8");

      await writeFile(join(fixture.workspaceDir, "AGENTS.md"), "v1", "utf-8");

      const before = await fixture.bridge.readAgentFile({ bridgePath: "workspace/AGENTS.md" });
      expect(before.content).toBe("v1");

      const writeResult = await fixture.bridge.writeAgentFile({
        bridgePath: "workspace/AGENTS.md",
        content: "v2",
        expectedRevision: before.revision
      });

      expect(writeResult.file.exists).toBe(true);
      expect(writeResult.revision).not.toBe(before.revision);

      const after = await fixture.bridge.readAgentFile({ bridgePath: "workspace/AGENTS.md" });
      expect(after.content).toBe("v2");

      await expect(
        fixture.bridge.writeAgentFile({
          bridgePath: "workspace/AGENTS.md",
          content: "v3",
          expectedRevision: before.revision
        })
      ).rejects.toBeInstanceOf(OpenClawAgentFileRevisionConflictError);
    } finally {
      await rm(fixture.tempDir, { recursive: true, force: true });
    }
  });

  test("rejects traversal and symlink escapes", async () => {
    const fixture = await createFixture(`{
      "agents": {
        "defaults": {
          "workspace": "${join(tmpdir(), "will-be-overridden")}",
        },
      },
    }`);

    try {
      await mkdir(join(fixture.workspaceDir, "memory"), { recursive: true });
      await writeFile(fixture.configPath, `{
        "agents": {
          "defaults": {
            "workspace": "${fixture.workspaceDir}",
          },
        },
      }`, "utf-8");

      await expect(
        fixture.bridge.readAgentFile({ bridgePath: "workspace/memory/../SOUL.md" })
      ).rejects.toThrow("Invalid bridgePath segment");

      const outsideDir = join(fixture.tempDir, "outside");
      await mkdir(outsideDir, { recursive: true });
      await writeFile(join(outsideDir, "leak.md"), "secret", "utf-8");
      await symlink(join(outsideDir, "leak.md"), join(fixture.workspaceDir, "memory", "leak.md"));

      await expect(
        fixture.bridge.readAgentFile({ bridgePath: "workspace/memory/leak.md" })
      ).rejects.toThrow("Path escapes allowed root");
    } finally {
      await rm(fixture.tempDir, { recursive: true, force: true });
    }
  });
});
