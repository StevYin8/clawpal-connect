import { describe, expect, test } from "vitest";
import { EventEmitter } from "node:events";

import {
  ConnectorServiceManager,
  buildConnectorServiceLaunchAgentPlist,
  buildConnectorServiceProgramArguments,
  buildConnectorServiceSystemdUnit,
  resolveDefaultConnectorServicePath
} from "../src/service_manager.js";

function createSpawnResult(stdout: string, stderr = "", exitCode = 0) {
  return () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter & { setEncoding: (encoding: string) => void };
      stderr: EventEmitter & { setEncoding: (encoding: string) => void };
      once: (event: string, listener: (...args: any[]) => void) => any;
    };
    child.stdout = new EventEmitter() as EventEmitter & { setEncoding: (encoding: string) => void };
    child.stderr = new EventEmitter() as EventEmitter & { setEncoding: (encoding: string) => void };
    child.stdout.setEncoding = () => {};
    child.stderr.setEncoding = () => {};
    queueMicrotask(() => {
      if (stdout) {
        child.stdout.emit("data", stdout);
      }
      if (stderr) {
        child.stderr.emit("data", stderr);
      }
      child.emit("close", exitCode, null);
    });
    return child as any;
  };
}

describe("service_manager", () => {
  test("builds program arguments for service mode", () => {
    expect(buildConnectorServiceProgramArguments({
      nodeExecutable: "/opt/homebrew/bin/node",
      cliEntryPath: "/usr/local/lib/node_modules/clawpal-connect/dist/cli.js",
      registryFile: "/tmp/registry.json",
      runtimeConfigFile: "/tmp/runtime.json"
    })).toEqual([
      "/opt/homebrew/bin/node",
      "/usr/local/lib/node_modules/clawpal-connect/dist/cli.js",
      "run",
      "--registry-file",
      "/tmp/registry.json",
      "--runtime-config-file",
      "/tmp/runtime.json"
    ]);
  });

  test("resolves service path per platform", () => {
    expect(resolveDefaultConnectorServicePath("darwin")).toContain("Library/LaunchAgents/ai.clawpal.connector.plist");
    expect(resolveDefaultConnectorServicePath("linux")).toContain(".config/systemd/user/ai.clawpal.connector.service");
    expect(resolveDefaultConnectorServicePath("win32")).toBe("ai.clawpal.connector");
  });

  test("renders LaunchAgent plist for connector service", () => {
    const plist = buildConnectorServiceLaunchAgentPlist({
      label: "ai.clawpal.connector",
      logDir: "/Users/test/.clawpal-connect/logs",
      nodeExecutable: "/opt/homebrew/bin/node",
      cliEntryPath: "/usr/local/lib/node_modules/clawpal-connect/dist/cli.js",
      registryFile: "/tmp/registry.json",
      runtimeConfigFile: "/tmp/runtime.json",
      env: { HOME: "/Users/test", PATH: "/usr/bin:/bin" }
    });

    expect(plist).toContain("<string>ai.clawpal.connector</string>");
    expect(plist).toContain("<string>/opt/homebrew/bin/node</string>");
    expect(plist).toContain("<string>/usr/local/lib/node_modules/clawpal-connect/dist/cli.js</string>");
    expect(plist).toContain("<string>run</string>");
    expect(plist).toContain("connector.stdout.log");
    expect(plist).toContain("CLAWPAL_CONNECTOR_SERVICE");
  });

  test("renders systemd user unit for connector service", () => {
    const unit = buildConnectorServiceSystemdUnit({
      label: "ai.clawpal.connector",
      logDir: "/home/test/.clawpal-connect/logs",
      nodeExecutable: "/usr/bin/node",
      cliEntryPath: "/usr/lib/node_modules/clawpal-connect/dist/cli.js",
      registryFile: "/tmp/registry.json",
      runtimeConfigFile: "/tmp/runtime.json",
      env: { HOME: "/home/test", PATH: "/usr/bin:/bin", SHELL: "/bin/bash" }
    });

    expect(unit).toContain("Description=ClawPal Connector Background Service");
    expect(unit).toContain("ExecStart=/bin/bash -lc");
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("connector.stdout.log");
    expect(unit).toContain("CLAWPAL_CONNECTOR_SERVICE=1");
  });

  test("start bootstraps when LaunchAgent is not loaded", async () => {
    const seen: string[] = [];
    const manager = new ConnectorServiceManager({
      platform: "darwin",
      uid: 0,
      servicePath: "/tmp/ai.clawpal.connector.plist",
      spawnImpl: (_command, args) => {
        seen.push(args.join(" "));
        if (args[0] === "print") {
          return createSpawnResult("", "not loaded", 113)();
        }
        return createSpawnResult("bootstrapped", "", 0)();
      }
    });

    const result = await manager.start();

    expect(result.command).toContain("launchctl bootstrap");
    expect(seen).toEqual([
      "print gui/0/ai.clawpal.connector",
      "bootstrap gui/0 /tmp/ai.clawpal.connector.plist"
    ]);
  });

  test("start kickstarts when LaunchAgent is already loaded", async () => {
    const seen: string[] = [];
    const manager = new ConnectorServiceManager({
      platform: "darwin",
      uid: 0,
      servicePath: "/tmp/ai.clawpal.connector.plist",
      spawnImpl: (_command, args) => {
        seen.push(args.join(" "));
        if (args[0] === "print") {
          return createSpawnResult("loaded", "", 0)();
        }
        return createSpawnResult("kickstarted", "", 0)();
      }
    });

    const result = await manager.start();

    expect(result.command).toContain("launchctl kickstart -k");
    expect(seen).toEqual([
      "print gui/0/ai.clawpal.connector",
      "kickstart -k gui/0/ai.clawpal.connector"
    ]);
  });

  test("linux start uses systemctl --user enable --now", async () => {
    const seen: string[] = [];
    const manager = new ConnectorServiceManager({
      platform: "linux",
      servicePath: "/home/test/.config/systemd/user/ai.clawpal.connector.service",
      spawnImpl: (_command, args) => {
        seen.push(args.join(" "));
        return createSpawnResult("started", "", 0)();
      }
    });

    const result = await manager.start();

    expect(result.command).toContain("systemctl --user enable --now ai.clawpal.connector.service");
    expect(seen).toEqual(["--user enable --now ai.clawpal.connector.service"]);
  });

  test("windows start uses schtasks run", async () => {
    const seen: string[] = [];
    const manager = new ConnectorServiceManager({
      platform: "win32",
      spawnImpl: (_command, args) => {
        seen.push(args.join(" "));
        return createSpawnResult("SUCCESS: Attempted to run the scheduled task", "", 0)();
      }
    });

    const result = await manager.start();

    expect(result.command).toContain("schtasks /Run /TN ai.clawpal.connector");
    expect(seen).toEqual(["/Run /TN ai.clawpal.connector"]);
  });
});
