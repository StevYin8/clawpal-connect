import { constants as fsConstants, type Dirent, type Stats } from "node:fs";
import { access, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";

const DEFAULT_AGENT_ID = "main";
const DEFAULT_CONFIG_FILENAME = "openclaw.json";
const DEFAULT_OPENCLAW_STATE_DIR = join(homedir(), ".openclaw");

const WORKSPACE_ROOT_FILES: readonly string[] = [
  "AGENTS.md",
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
  "MEMORY.md",
  "memory.md"
];

const SKILL_ROOT_FILES = new Set([
  "SKILL.md",
  "manifest.json",
  "metadata.json",
  "_meta.json",
  "config.json"
]);

const SKILL_CONFIG_EXTENSIONS = new Set([".json", ".yaml", ".yml", ".toml"]);

type OpenClawAgentEntryLike = {
  id?: unknown;
  default?: unknown;
  workspace?: unknown;
};

interface OpenClawConfigLike {
  agents?: {
    defaults?: {
      workspace?: unknown;
    };
    list?: unknown;
  };
}

export type OpenClawAgentFileDomain =
  | "config"
  | "workspace"
  | "workspace-memory"
  | "workspace-skill"
  | "shared-skill";

export type OpenClawAgentFileCategory = "skills" | "personality" | "soul" | "identity" | "memory" | "config";

export interface OpenClawAgentFileBridgeDescriptor {
  bridgePath: string;
  absolutePath: string;
  domain: OpenClawAgentFileDomain;
  category: OpenClawAgentFileCategory;
  exists: boolean;
  writable: boolean;
  byteSize?: number;
  updatedAt?: string;
}

export interface OpenClawAgentFilesListResult {
  agentId: string;
  stateDir: string;
  configPath: string;
  workspaceDir: string;
  files: OpenClawAgentFileBridgeDescriptor[];
}

export interface OpenClawAgentFilesListOptions {
  agentId?: string;
}

export interface OpenClawAgentFileReadInput {
  agentId?: string;
  bridgePath: string;
}

export interface OpenClawAgentFileReadResult {
  file: OpenClawAgentFileBridgeDescriptor;
  content: string;
  revision: string;
}

export interface OpenClawAgentFileWriteInput {
  agentId?: string;
  bridgePath: string;
  content: string;
  expectedRevision?: string;
}

export interface OpenClawAgentFileWriteResult {
  file: OpenClawAgentFileBridgeDescriptor;
  revision: string;
}

interface OpenClawAgentFileBridgeOptions {
  stateDir?: string;
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  onConfigError?: (error: unknown) => void;
}

interface ResolvedAgentContext {
  agentId: string;
  stateDir: string;
  configPath: string;
  workspaceDir: string;
}

interface ResolvedBridgeFileTarget {
  bridgePath: string;
  absolutePath: string;
  domain: OpenClawAgentFileDomain;
  category: OpenClawAgentFileCategory;
  rootDir: string;
}

interface ParsedBridgePath {
  normalized: string;
  segments: string[];
}

export class OpenClawAgentFileRevisionConflictError extends Error {
  readonly code = "openclaw_agent_file_revision_conflict";
  readonly bridgePath: string;
  readonly expectedRevision: string;
  readonly actualRevision?: string;

  constructor(params: { bridgePath: string; expectedRevision: string; actualRevision?: string }) {
    const actualSuffix = params.actualRevision ? `, actual=${params.actualRevision}` : ", actual=<missing>";
    super(`Revision mismatch for ${params.bridgePath}: expected=${params.expectedRevision}${actualSuffix}`);
    this.name = "OpenClawAgentFileRevisionConflictError";
    this.bridgePath = params.bridgePath;
    this.expectedRevision = params.expectedRevision;
    if (params.actualRevision !== undefined) {
      this.actualRevision = params.actualRevision;
    }
  }
}

export const OPENCLAW_AGENT_FILE_BRIDGE_WIRING_POINTS: readonly string[] = [
  "Add relay -> connector request envelopes for agents.files.list/get/set.",
  "Update src/ws_backend_transport.ts to decode those envelopes and dispatch them to connector handlers.",
  "Add request/response plumbing in src/backend_client.ts + src/connector_runtime.ts that routes file ops to OpenClawAgentFileBridgeService (not RuntimeWorker chat path).",
  "Define relay/app response contracts (success + conflict/not-found/validation errors) and map them to existing connector event transport."
];

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function resolveUserPath(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

function normalizeAgentId(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (!normalized) {
    return DEFAULT_AGENT_ID;
  }

  const slug = normalized
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9#@._+-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");

  return slug || DEFAULT_AGENT_ID;
}

function stripNullBytes(value: string): string {
  return value.replace(/\0/g, "");
}

function normalizeBridgePath(pathInput: string): ParsedBridgePath {
  const trimmed = pathInput.trim();
  if (!trimmed) {
    throw new Error("bridgePath cannot be empty.");
  }

  const normalized = trimmed
    .replaceAll("\\", "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");

  if (!normalized) {
    throw new Error("bridgePath cannot be empty.");
  }

  const segments = normalized.split("/");
  for (const segment of segments) {
    if (!segment || segment === "." || segment === "..") {
      throw new Error(`Invalid bridgePath segment: ${segment || "<empty>"}`);
    }
  }

  return {
    normalized: segments.join("/"),
    segments
  };
}

function parseOpenClawConfig(content: string): OpenClawConfigLike {
  const normalized = content
    .replace(/^\uFEFF/, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,\s*([}\]])/g, "$1");

  return JSON.parse(normalized) as OpenClawConfigLike;
}

function listAgentEntries(config: OpenClawConfigLike): OpenClawAgentEntryLike[] {
  const list = config.agents?.list;
  if (!Array.isArray(list)) {
    return [];
  }

  return list.filter((entry): entry is OpenClawAgentEntryLike => typeof entry === "object" && entry !== null);
}

function resolveDefaultAgentId(config: OpenClawConfigLike): string {
  const entries = listAgentEntries(config);
  if (entries.length === 0) {
    return DEFAULT_AGENT_ID;
  }

  const defaultEntry = entries.find((entry) => entry.default === true);
  return normalizeAgentId(normalizeOptionalString(defaultEntry?.id) ?? normalizeOptionalString(entries[0]?.id));
}

function resolveAgentWorkspaceDir(config: OpenClawConfigLike, stateDir: string, agentId: string): string {
  const normalizedAgentId = normalizeAgentId(agentId);
  const entries = listAgentEntries(config);
  const agentEntry = entries.find((entry) => normalizeAgentId(normalizeOptionalString(entry.id)) === normalizedAgentId);
  const explicitWorkspace = normalizeOptionalString(agentEntry?.workspace);
  if (explicitWorkspace) {
    return stripNullBytes(resolveUserPath(explicitWorkspace));
  }

  if (normalizedAgentId === resolveDefaultAgentId(config)) {
    const defaultWorkspace = normalizeOptionalString(config.agents?.defaults?.workspace);
    if (defaultWorkspace) {
      return stripNullBytes(resolveUserPath(defaultWorkspace));
    }
    return stripNullBytes(join(stateDir, "workspace"));
  }

  return stripNullBytes(join(stateDir, `workspace-${normalizedAgentId}`));
}

function categorizeWorkspaceRootFile(name: string): OpenClawAgentFileCategory {
  if (name === "SOUL.md") {
    return "soul";
  }
  if (name === "IDENTITY.md" || name === "USER.md") {
    return "identity";
  }
  if (name === "MEMORY.md" || name === "memory.md") {
    return "memory";
  }
  return "personality";
}

function isPathInside(candidatePath: string, rootPath: string): boolean {
  const relativePath = relative(rootPath, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function computeRevision(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function safeStat(filePath: string): Promise<Stats | undefined> {
  try {
    return await stat(filePath, { bigint: false });
  } catch (error) {
    if (isNotFoundError(error)) {
      return undefined;
    }
    throw error;
  }
}

function isNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function realpathOrResolve(filePath: string): Promise<string> {
  try {
    return await realpath(filePath);
  } catch (error) {
    if (isNotFoundError(error)) {
      return resolve(filePath);
    }
    throw error;
  }
}

async function resolveExistingAncestor(filePath: string): Promise<string> {
  let current = resolve(filePath);

  while (true) {
    try {
      return await realpath(current);
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }

      const parent = dirname(current);
      if (parent === current) {
        return resolve(filePath);
      }
      current = parent;
    }
  }
}

async function assertPathWithinRoot(filePath: string, rootDir: string): Promise<void> {
  const rootRealpath = await realpathOrResolve(rootDir);
  const resolvedPath = resolve(filePath);

  const ancestorRealpath = await resolveExistingAncestor(resolvedPath);
  if (!isPathInside(ancestorRealpath, rootRealpath)) {
    throw new Error(`Path escapes allowed root: ${filePath}`);
  }

  const fileStats = await safeStat(resolvedPath);
  if (fileStats) {
    const fileRealpath = await realpathOrResolve(resolvedPath);
    if (!isPathInside(fileRealpath, rootRealpath)) {
      throw new Error(`Path escapes allowed root: ${filePath}`);
    }
  }
}

async function canWrite(filePath: string): Promise<boolean> {
  let probePath = filePath;

  while (true) {
    const stats = await safeStat(probePath);
    if (stats) {
      try {
        await access(probePath, fsConstants.W_OK);
        return true;
      } catch {
        return false;
      }
    }

    const parent = dirname(probePath);
    if (parent === probePath) {
      return false;
    }
    probePath = parent;
  }
}

async function listMarkdownFiles(rootDir: string, maxDepth = 3): Promise<string[]> {
  const discovered: string[] = [];

  async function walk(currentDir: string, depth: number): Promise<void> {
    if (depth > maxDepth) {
      return;
    }

    let entries: Dirent[] = [];
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch (error) {
      if (isNotFoundError(error)) {
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }

      const nextPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(nextPath, depth + 1);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (entry.name.toLowerCase().endsWith(".md")) {
        discovered.push(nextPath);
      }
    }
  }

  await walk(rootDir, 0);
  return discovered;
}

function toNormalizedRelativePath(rootDir: string, absolutePath: string): string {
  return relative(rootDir, absolutePath).replaceAll("\\", "/");
}

function isAllowedSkillRelativePath(relativePath: string): boolean {
  const parsed = normalizeBridgePath(relativePath);
  if (parsed.segments.length < 2) {
    return false;
  }

  const rest = parsed.segments.slice(1);
  if (rest.length === 1) {
    return SKILL_ROOT_FILES.has(rest[0] ?? "");
  }

  const head = rest[0];
  const tail = rest[rest.length - 1] ?? "";
  if (head !== "config") {
    return false;
  }

  const extension = extname(tail).toLowerCase();
  return SKILL_CONFIG_EXTENSIONS.has(extension);
}

function isAllowedMemoryRelativePath(relativePath: string): boolean {
  const parsed = normalizeBridgePath(relativePath);
  const tail = parsed.segments[parsed.segments.length - 1] ?? "";
  return tail.toLowerCase().endsWith(".md");
}

function sortTargets(targets: ResolvedBridgeFileTarget[]): ResolvedBridgeFileTarget[] {
  return [...targets].sort((left, right) => left.bridgePath.localeCompare(right.bridgePath));
}

async function loadSkillTargets(rootDir: string, bridgePrefix: string, domain: OpenClawAgentFileDomain): Promise<ResolvedBridgeFileTarget[]> {
  const targets: ResolvedBridgeFileTarget[] = [];
  const skillsRootStats = await safeStat(rootDir);
  if (!skillsRootStats || !skillsRootStats.isDirectory()) {
    return targets;
  }

  const skillEntries = await readdir(rootDir, { withFileTypes: true });
  for (const skillEntry of skillEntries) {
    if (!skillEntry.isDirectory() || skillEntry.name.startsWith(".")) {
      continue;
    }

    const skillDir = join(rootDir, skillEntry.name);
    for (const skillFileName of SKILL_ROOT_FILES) {
      const absolutePath = join(skillDir, skillFileName);
      const stats = await safeStat(absolutePath);
      if (!stats || !stats.isFile()) {
        continue;
      }

      targets.push({
        bridgePath: `${bridgePrefix}/${skillEntry.name}/${skillFileName}`,
        absolutePath,
        domain,
        category: "skills",
        rootDir
      });
    }

    const configDir = join(skillDir, "config");
    const configStats = await safeStat(configDir);
    if (!configStats || !configStats.isDirectory()) {
      continue;
    }

    const configEntries = await readdir(configDir, { withFileTypes: true });
    for (const configEntry of configEntries) {
      if (!configEntry.isFile()) {
        continue;
      }

      const extension = extname(configEntry.name).toLowerCase();
      if (!SKILL_CONFIG_EXTENSIONS.has(extension)) {
        continue;
      }

      const absolutePath = join(configDir, configEntry.name);
      targets.push({
        bridgePath: `${bridgePrefix}/${skillEntry.name}/config/${configEntry.name}`,
        absolutePath,
        domain,
        category: "skills",
        rootDir
      });
    }
  }

  return targets;
}

export class OpenClawAgentFileBridgeService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly stateDir: string;
  private readonly configPath: string;
  private readonly onConfigError: (error: unknown) => void;

  constructor(options: OpenClawAgentFileBridgeOptions = {}) {
    this.env = options.env ?? process.env;
    const envStateDir = normalizeOptionalString(this.env.OPENCLAW_STATE_DIR);
    this.stateDir = stripNullBytes(resolveUserPath(options.stateDir ?? envStateDir ?? DEFAULT_OPENCLAW_STATE_DIR));
    const envConfigPath = normalizeOptionalString(this.env.OPENCLAW_CONFIG_PATH);
    this.configPath = stripNullBytes(
      resolveUserPath(options.configPath ?? envConfigPath ?? join(this.stateDir, DEFAULT_CONFIG_FILENAME))
    );
    this.onConfigError =
      options.onConfigError ??
      ((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`Failed to parse OpenClaw config for file bridge: ${message}`);
      });
  }

  async listAgentFiles(options: OpenClawAgentFilesListOptions = {}): Promise<OpenClawAgentFilesListResult> {
    const context = await this.resolveAgentContext(options.agentId);
    const targetsByPath = new Map<string, ResolvedBridgeFileTarget>();

    const addTarget = (target: ResolvedBridgeFileTarget): void => {
      targetsByPath.set(target.bridgePath, target);
    };

    addTarget({
      bridgePath: "config/openclaw.json",
      absolutePath: this.configPath,
      domain: "config",
      category: "config",
      rootDir: dirname(this.configPath)
    });

    for (const fileName of WORKSPACE_ROOT_FILES) {
      addTarget({
        bridgePath: `workspace/${fileName}`,
        absolutePath: join(context.workspaceDir, fileName),
        domain: "workspace",
        category: categorizeWorkspaceRootFile(fileName),
        rootDir: context.workspaceDir
      });
    }

    const memoryDir = join(context.workspaceDir, "memory");
    for (const absolutePath of await listMarkdownFiles(memoryDir)) {
      addTarget({
        bridgePath: `workspace/memory/${toNormalizedRelativePath(memoryDir, absolutePath)}`,
        absolutePath,
        domain: "workspace-memory",
        category: "memory",
        rootDir: context.workspaceDir
      });
    }

    for (const target of await loadSkillTargets(
      join(context.workspaceDir, "skills"),
      "workspace/skills",
      "workspace-skill"
    )) {
      addTarget(target);
    }

    for (const target of await loadSkillTargets(join(this.stateDir, "skills"), "shared-skills", "shared-skill")) {
      addTarget(target);
    }

    const sortedTargets = sortTargets([...targetsByPath.values()]);
    const descriptors = await Promise.all(sortedTargets.map(async (target) => await this.describeTarget(target)));

    return {
      agentId: context.agentId,
      stateDir: this.stateDir,
      configPath: this.configPath,
      workspaceDir: context.workspaceDir,
      files: descriptors
    };
  }

  async readAgentFile(input: OpenClawAgentFileReadInput): Promise<OpenClawAgentFileReadResult> {
    const context = await this.resolveAgentContext(input.agentId);
    const target = this.resolveTarget(context, input.bridgePath);
    await assertPathWithinRoot(target.absolutePath, target.rootDir);

    const fileStats = await safeStat(target.absolutePath);
    if (!fileStats || !fileStats.isFile()) {
      throw new Error(`OpenClaw bridge file not found: ${target.bridgePath}`);
    }

    const content = await readFile(target.absolutePath, "utf-8");
    const revision = computeRevision(content);
    const descriptor = await this.describeTarget(target);
    if (!descriptor.exists) {
      throw new Error(`OpenClaw bridge file not found: ${target.bridgePath}`);
    }

    return {
      file: descriptor,
      content,
      revision
    };
  }

  async writeAgentFile(input: OpenClawAgentFileWriteInput): Promise<OpenClawAgentFileWriteResult> {
    const context = await this.resolveAgentContext(input.agentId);
    const target = this.resolveTarget(context, input.bridgePath);
    await assertPathWithinRoot(target.absolutePath, target.rootDir);

    const current = await this.tryReadCurrent(target.absolutePath);
    if (input.expectedRevision !== undefined && current?.revision !== input.expectedRevision) {
      throw new OpenClawAgentFileRevisionConflictError({
        bridgePath: target.bridgePath,
        expectedRevision: input.expectedRevision,
        ...(current?.revision ? { actualRevision: current.revision } : {})
      });
    }

    await mkdir(dirname(target.absolutePath), { recursive: true });

    const tempPath = join(
      dirname(target.absolutePath),
      `.${basename(target.absolutePath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );

    let tempWritten = false;
    try {
      await writeFile(tempPath, input.content, "utf-8");
      tempWritten = true;
      await rename(tempPath, target.absolutePath);
      tempWritten = false;
    } finally {
      if (tempWritten) {
        await rm(tempPath, { force: true }).catch(() => {});
      }
    }

    const descriptor = await this.describeTarget(target);
    if (!descriptor.exists) {
      throw new Error(`Failed to persist OpenClaw bridge file: ${target.bridgePath}`);
    }

    return {
      file: descriptor,
      revision: computeRevision(input.content)
    };
  }

  private async resolveAgentContext(agentId?: string): Promise<ResolvedAgentContext> {
    const config = await this.readConfig();
    const normalizedAgentId = normalizeAgentId(agentId ?? resolveDefaultAgentId(config));

    return {
      agentId: normalizedAgentId,
      stateDir: this.stateDir,
      configPath: this.configPath,
      workspaceDir: resolveAgentWorkspaceDir(config, this.stateDir, normalizedAgentId)
    };
  }

  private async readConfig(): Promise<OpenClawConfigLike> {
    try {
      const content = await readFile(this.configPath, "utf-8");
      return parseOpenClawConfig(content);
    } catch (error) {
      if (isNotFoundError(error)) {
        return {};
      }

      this.onConfigError(error);
      return {};
    }
  }

  private resolveTarget(context: ResolvedAgentContext, bridgePath: string): ResolvedBridgeFileTarget {
    const parsed = normalizeBridgePath(bridgePath);

    if (parsed.normalized === "config/openclaw.json") {
      return {
        bridgePath: parsed.normalized,
        absolutePath: this.configPath,
        domain: "config",
        category: "config",
        rootDir: dirname(this.configPath)
      };
    }

    if (parsed.segments[0] === "workspace") {
      const workspaceRelative = parsed.segments.slice(1).join("/");
      if (WORKSPACE_ROOT_FILES.includes(workspaceRelative)) {
        return {
          bridgePath: parsed.normalized,
          absolutePath: join(context.workspaceDir, workspaceRelative),
          domain: "workspace",
          category: categorizeWorkspaceRootFile(workspaceRelative),
          rootDir: context.workspaceDir
        };
      }

      if (workspaceRelative.startsWith("memory/")) {
        const memoryRelative = workspaceRelative.slice("memory/".length);
        if (!isAllowedMemoryRelativePath(memoryRelative)) {
          throw new Error(`Unsupported workspace memory file path: ${parsed.normalized}`);
        }

        return {
          bridgePath: parsed.normalized,
          absolutePath: join(context.workspaceDir, workspaceRelative),
          domain: "workspace-memory",
          category: "memory",
          rootDir: context.workspaceDir
        };
      }

      if (workspaceRelative.startsWith("skills/")) {
        const skillRelative = workspaceRelative.slice("skills/".length);
        if (!isAllowedSkillRelativePath(skillRelative)) {
          throw new Error(`Unsupported workspace skill file path: ${parsed.normalized}`);
        }

        return {
          bridgePath: parsed.normalized,
          absolutePath: join(context.workspaceDir, workspaceRelative),
          domain: "workspace-skill",
          category: "skills",
          rootDir: context.workspaceDir
        };
      }

      throw new Error(`Unsupported workspace bridge path: ${parsed.normalized}`);
    }

    if (parsed.segments[0] === "shared-skills") {
      const sharedRelative = parsed.segments.slice(1).join("/");
      if (!isAllowedSkillRelativePath(sharedRelative)) {
        throw new Error(`Unsupported shared skill file path: ${parsed.normalized}`);
      }

      return {
        bridgePath: parsed.normalized,
        absolutePath: join(this.stateDir, "skills", sharedRelative),
        domain: "shared-skill",
        category: "skills",
        rootDir: join(this.stateDir, "skills")
      };
    }

    throw new Error(`Unsupported OpenClaw bridge path: ${parsed.normalized}`);
  }

  private async describeTarget(target: ResolvedBridgeFileTarget): Promise<OpenClawAgentFileBridgeDescriptor> {
    const fileStats = await safeStat(target.absolutePath);
    const exists = Boolean(fileStats && fileStats.isFile());

    const writable = await canWrite(target.absolutePath);

    return {
      bridgePath: target.bridgePath,
      absolutePath: target.absolutePath,
      domain: target.domain,
      category: target.category,
      exists,
      writable,
      ...(exists && fileStats
        ? {
            byteSize: fileStats.size,
            updatedAt: new Date(fileStats.mtimeMs).toISOString()
          }
        : {})
    };
  }

  private async tryReadCurrent(filePath: string): Promise<{ content: string; revision: string } | undefined> {
    const fileStats = await safeStat(filePath);
    if (!fileStats || !fileStats.isFile()) {
      return undefined;
    }

    await access(filePath, fsConstants.R_OK);
    const content = await readFile(filePath, "utf-8");
    return {
      content,
      revision: computeRevision(content)
    };
  }
}
