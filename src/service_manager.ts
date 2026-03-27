import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type ConnectorServiceLifecycleCommand = "install" | "start" | "stop" | "restart" | "status" | "uninstall";

type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcessWithoutNullStreams;

export interface ConnectorServiceCommandResult {
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  label: string;
  servicePath: string;
  platform: NodeJS.Platform;
}

export interface ConnectorServiceManagerOptions {
  label?: string;
  servicePath?: string;
  logDir?: string;
  nodeExecutable?: string;
  cliEntryPath?: string;
  registryFile?: string;
  runtimeConfigFile?: string;
  env?: NodeJS.ProcessEnv;
  spawnImpl?: SpawnProcess;
  platform?: NodeJS.Platform;
  uid?: number;
}

const DEFAULT_SERVICE_LABEL = "ai.clawpal.connector";
const SUPPORTED_PLATFORMS: readonly NodeJS.Platform[] = ["darwin", "linux", "win32"];

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function windowsQuote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function plistArray(values: string[]): string {
  return values.map((value) => `    <string>${escapeXml(value)}</string>`).join("\n");
}

function plistDict(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([key, value]) => `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`)
    .join("\n");
}

export function resolveDefaultConnectorServicePath(platform: NodeJS.Platform, label = DEFAULT_SERVICE_LABEL): string {
  if (platform === "darwin") {
    return join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
  }
  if (platform === "linux") {
    return join(homedir(), ".config", "systemd", "user", `${label}.service`);
  }
  if (platform === "win32") {
    return label;
  }
  throw new Error(`Connector service is unsupported on platform: ${platform}`);
}

export function resolveDefaultConnectorServiceLogDir(): string {
  return join(homedir(), ".clawpal-connect", "logs");
}

export function resolveDefaultConnectorCliEntryPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "cli.js");
}

export function buildConnectorServiceProgramArguments(options: {
  nodeExecutable: string;
  cliEntryPath: string;
  registryFile?: string;
  runtimeConfigFile?: string;
}): string[] {
  const args = [options.nodeExecutable, options.cliEntryPath, "run"];
  if (options.registryFile?.trim()) {
    args.push("--registry-file", options.registryFile.trim());
  }
  if (options.runtimeConfigFile?.trim()) {
    args.push("--runtime-config-file", options.runtimeConfigFile.trim());
  }
  return args;
}

function buildConnectorCommandLine(options: {
  nodeExecutable: string;
  cliEntryPath: string;
  registryFile?: string;
  runtimeConfigFile?: string;
}): string {
  return buildConnectorServiceProgramArguments(options).map(shellQuote).join(" ");
}

function buildConnectorWindowsCommandLine(options: {
  nodeExecutable: string;
  cliEntryPath: string;
  registryFile?: string;
  runtimeConfigFile?: string;
}): string {
  return buildConnectorServiceProgramArguments(options).map(windowsQuote).join(" ");
}

export function buildConnectorServiceLaunchAgentPlist(options: {
  label?: string;
  logDir: string;
  nodeExecutable: string;
  cliEntryPath: string;
  registryFile?: string;
  runtimeConfigFile?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const label = options.label?.trim() || DEFAULT_SERVICE_LABEL;
  const programArguments = buildConnectorServiceProgramArguments({
    nodeExecutable: options.nodeExecutable,
    cliEntryPath: options.cliEntryPath,
    ...(options.registryFile ? { registryFile: options.registryFile } : {}),
    ...(options.runtimeConfigFile ? { runtimeConfigFile: options.runtimeConfigFile } : {})
  });
  const environment: Record<string, string> = {
    CLAWPAL_CONNECTOR_SERVICE: "1",
    HOME: options.env?.HOME ?? homedir(),
    PATH: options.env?.PATH ?? process.env.PATH ?? ""
  };
  const shell = options.env?.SHELL?.trim();
  if (shell) {
    environment.SHELL = shell;
  }

  const stdoutPath = join(options.logDir, "connector.stdout.log");
  const stderrPath = join(options.logDir, "connector.stderr.log");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${plistArray(programArguments)}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${escapeXml(homedir())}</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(stderrPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${plistDict(environment)}
  </dict>
</dict>
</plist>
`;
}

export function buildConnectorServiceSystemdUnit(options: {
  label?: string;
  logDir: string;
  nodeExecutable: string;
  cliEntryPath: string;
  registryFile?: string;
  runtimeConfigFile?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const label = options.label?.trim() || DEFAULT_SERVICE_LABEL;
  const stdoutPath = join(options.logDir, "connector.stdout.log");
  const stderrPath = join(options.logDir, "connector.stderr.log");
  const command = buildConnectorCommandLine({
    nodeExecutable: options.nodeExecutable,
    cliEntryPath: options.cliEntryPath,
    ...(options.registryFile ? { registryFile: options.registryFile } : {}),
    ...(options.runtimeConfigFile ? { runtimeConfigFile: options.runtimeConfigFile } : {})
  });
  const shell = options.env?.SHELL?.trim() || "/bin/sh";
  const path = options.env?.PATH?.trim() || process.env.PATH || "/usr/bin:/bin";
  return `[Unit]
Description=ClawPal Connector Background Service (${label})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${homedir()}
Environment=CLAWPAL_CONNECTOR_SERVICE=1
Environment=HOME=${options.env?.HOME ?? homedir()}
Environment=PATH=${path}
ExecStart=${shell} -lc ${shellQuote(`${command} >> ${shellQuote(stdoutPath)} 2>> ${shellQuote(stderrPath)}`)}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

function buildWindowsTaskCommand(options: {
  logDir: string;
  nodeExecutable: string;
  cliEntryPath: string;
  registryFile?: string;
  runtimeConfigFile?: string;
}): string {
  const stdoutPath = join(options.logDir, "connector.stdout.log");
  const stderrPath = join(options.logDir, "connector.stderr.log");
  const command = buildConnectorWindowsCommandLine({
    nodeExecutable: options.nodeExecutable,
    cliEntryPath: options.cliEntryPath,
    ...(options.registryFile ? { registryFile: options.registryFile } : {}),
    ...(options.runtimeConfigFile ? { runtimeConfigFile: options.runtimeConfigFile } : {})
  });
  return `cmd.exe /d /c set CLAWPAL_CONNECTOR_SERVICE=1&& ${command} >> ${windowsQuote(stdoutPath)} 2>> ${windowsQuote(stderrPath)}`;
}

export class ConnectorServiceManager {
  private readonly label: string;
  private readonly servicePath: string;
  private readonly logDir: string;
  private readonly nodeExecutable: string;
  private readonly cliEntryPath: string;
  private readonly registryFile: string | undefined;
  private readonly runtimeConfigFile: string | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private readonly spawnImpl: SpawnProcess;
  private readonly platform: NodeJS.Platform;
  private readonly uid: number;

  constructor(options: ConnectorServiceManagerOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.ensureSupportedPlatform();
    this.label = options.label?.trim() || DEFAULT_SERVICE_LABEL;
    this.servicePath = options.servicePath?.trim() || resolveDefaultConnectorServicePath(this.platform, this.label);
    this.logDir = options.logDir?.trim() || resolveDefaultConnectorServiceLogDir();
    this.nodeExecutable = options.nodeExecutable?.trim() || process.execPath;
    this.cliEntryPath = options.cliEntryPath?.trim() || resolveDefaultConnectorCliEntryPath();
    this.registryFile = options.registryFile?.trim() || undefined;
    this.runtimeConfigFile = options.runtimeConfigFile?.trim() || undefined;
    this.env = options.env ?? process.env;
    this.spawnImpl = options.spawnImpl ?? ((command, args, spawnOptions) =>
      spawn(command, [...args], spawnOptions) as ChildProcessWithoutNullStreams);
    this.uid = options.uid ?? process.getuid?.() ?? 0;
  }

  getLabel(): string {
    return this.label;
  }

  getServicePath(): string {
    return this.servicePath;
  }

  getLogDir(): string {
    return this.logDir;
  }

  async install(): Promise<ConnectorServiceCommandResult> {
    await mkdir(this.logDir, { recursive: true });
    if (this.platform === "darwin") {
      await mkdir(dirname(this.servicePath), { recursive: true });
      const plist = buildConnectorServiceLaunchAgentPlist({
        label: this.label,
        logDir: this.logDir,
        nodeExecutable: this.nodeExecutable,
        cliEntryPath: this.cliEntryPath,
        ...(this.registryFile ? { registryFile: this.registryFile } : {}),
        ...(this.runtimeConfigFile ? { runtimeConfigFile: this.runtimeConfigFile } : {}),
        env: this.env
      });
      await writeFile(this.servicePath, plist, "utf8");
      return this.commandResult(`write ${this.servicePath}`, [this.servicePath], `Installed connector LaunchAgent plist at ${this.servicePath}. Next step: clawpal service start`);
    }
    if (this.platform === "linux") {
      await mkdir(dirname(this.servicePath), { recursive: true });
      const unit = buildConnectorServiceSystemdUnit({
        label: this.label,
        logDir: this.logDir,
        nodeExecutable: this.nodeExecutable,
        cliEntryPath: this.cliEntryPath,
        ...(this.registryFile ? { registryFile: this.registryFile } : {}),
        ...(this.runtimeConfigFile ? { runtimeConfigFile: this.runtimeConfigFile } : {}),
        env: this.env
      });
      await writeFile(this.servicePath, unit, "utf8");
      const reloadResult = await this.runCommand("systemctl", ["--user", "daemon-reload"]);
      return {
        ...reloadResult,
        stdout: [
          `Installed connector systemd user unit at ${this.servicePath}.`,
          reloadResult.stdout.trim(),
          "Next step: clawpal service start"
        ].filter(Boolean).join("\n")
      };
    }
    const taskResult = await this.runCommand("schtasks", [
      "/Create",
      "/TN",
      this.label,
      "/SC",
      "ONLOGON",
      "/TR",
      buildWindowsTaskCommand({
        logDir: this.logDir,
        nodeExecutable: this.nodeExecutable,
        cliEntryPath: this.cliEntryPath,
        ...(this.registryFile ? { registryFile: this.registryFile } : {}),
        ...(this.runtimeConfigFile ? { runtimeConfigFile: this.runtimeConfigFile } : {})
      }),
      "/F"
    ]);
    return {
      ...taskResult,
      stdout: [taskResult.stdout.trim(), `Installed connector Scheduled Task ${this.label}. Next step: clawpal service start`]
        .filter(Boolean)
        .join("\n")
    };
  }

  async start(): Promise<ConnectorServiceCommandResult> {
    if (this.platform === "darwin") {
      const loaded = await this.isMacLoaded();
      if (loaded) {
        return await this.runCommand("launchctl", ["kickstart", "-k", this.launchctlServiceTarget()]);
      }
      return await this.runCommand("launchctl", ["bootstrap", this.launchctlDomainTarget(), this.servicePath]);
    }
    if (this.platform === "linux") {
      return await this.runCommand("systemctl", ["--user", "enable", "--now", this.systemdUnitName()]);
    }
    return await this.runCommand("schtasks", ["/Run", "/TN", this.label]);
  }

  async stop(): Promise<ConnectorServiceCommandResult> {
    if (this.platform === "darwin") {
      return await this.runCommand("launchctl", ["bootout", this.launchctlServiceTarget()]);
    }
    if (this.platform === "linux") {
      return await this.runCommand("systemctl", ["--user", "stop", this.systemdUnitName()]);
    }
    return await this.runCommand("schtasks", ["/End", "/TN", this.label]);
  }

  async restart(): Promise<ConnectorServiceCommandResult> {
    if (this.platform === "darwin") {
      const stopResult = await this.stop().catch(() => undefined);
      const startResult = await this.start();
      return {
        ...startResult,
        stdout: [stopResult?.stdout.trim(), startResult.stdout.trim()].filter(Boolean).join("\n")
      };
    }
    if (this.platform === "linux") {
      return await this.runCommand("systemctl", ["--user", "restart", this.systemdUnitName()]);
    }
    const stopResult = await this.stop().catch(() => undefined);
    const startResult = await this.start();
    return {
      ...startResult,
      stdout: [stopResult?.stdout.trim(), startResult.stdout.trim()].filter(Boolean).join("\n")
    };
  }

  async status(): Promise<ConnectorServiceCommandResult> {
    if (this.platform === "darwin") {
      return await this.runCommand("launchctl", ["print", this.launchctlServiceTarget()]);
    }
    if (this.platform === "linux") {
      return await this.runCommand("systemctl", ["--user", "status", this.systemdUnitName(), "--no-pager"]);
    }
    return await this.runCommand("schtasks", ["/Query", "/TN", this.label, "/V", "/FO", "LIST"]);
  }

  async uninstall(): Promise<ConnectorServiceCommandResult> {
    if (this.platform === "darwin") {
      const stopResult = await this.stop().catch(() => undefined);
      await rm(this.servicePath, { force: true });
      return this.commandResult(
        `rm ${this.servicePath}`,
        [this.servicePath],
        [stopResult?.stdout.trim(), `Removed connector LaunchAgent plist ${this.servicePath}.`].filter(Boolean).join("\n"),
        stopResult?.stderr ?? ""
      );
    }
    if (this.platform === "linux") {
      const disableResult = await this.runCommand("systemctl", ["--user", "disable", "--now", this.systemdUnitName()]).catch(() => undefined);
      await rm(this.servicePath, { force: true });
      const reloadResult = await this.runCommand("systemctl", ["--user", "daemon-reload"]);
      return {
        ...reloadResult,
        stdout: [
          disableResult?.stdout.trim(),
          `Removed connector systemd user unit ${this.servicePath}.`,
          reloadResult.stdout.trim()
        ].filter(Boolean).join("\n"),
        stderr: [disableResult?.stderr.trim(), reloadResult.stderr.trim()].filter(Boolean).join("\n")
      };
    }
    return await this.runCommand("schtasks", ["/Delete", "/F", "/TN", this.label]);
  }

  private ensureSupportedPlatform(): void {
    if (!SUPPORTED_PLATFORMS.includes(this.platform)) {
      throw new Error("Connector service commands are supported only on macOS, Linux, and Windows.");
    }
  }

  private systemdUnitName(): string {
    return `${this.label}.service`;
  }

  private async isMacLoaded(): Promise<boolean> {
    const result = await this.runCommand("launchctl", ["print", this.launchctlServiceTarget()]);
    return result.exitCode === 0;
  }

  private launchctlDomainTarget(): string {
    return `gui/${this.uid}`;
  }

  private launchctlServiceTarget(): string {
    return `${this.launchctlDomainTarget()}/${this.label}`;
  }

  private commandResult(
    command: string,
    args: string[],
    stdout = "",
    stderr = "",
    exitCode: number | null = 0,
    signal: NodeJS.Signals | null = null
  ): ConnectorServiceCommandResult {
    return {
      command,
      args,
      stdout,
      stderr,
      exitCode,
      signal,
      label: this.label,
      servicePath: this.servicePath,
      platform: this.platform
    };
  }

  private async runCommand(command: string, args: string[]): Promise<ConnectorServiceCommandResult> {
    return await new Promise<ConnectorServiceCommandResult>((resolve, reject) => {
      const child = this.spawnImpl(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: this.env
      });

      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf-8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf-8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("close", (exitCode, signal) => {
        resolve(this.commandResult(`${command} ${args.join(" ")}`, [...args], stdout, stderr, exitCode, signal));
      });
    });
  }
}
