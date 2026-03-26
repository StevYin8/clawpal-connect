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

export type OpenClawAgentFactSource = "openclaw-filesystem" | "openclaw-sessions-index" | "unavailable";

export interface OpenClawAgentFactAvailability {
  available: boolean;
  source: OpenClawAgentFactSource;
  detail: string;
}

export interface OpenClawAgentFileDomainFacts {
  availability: OpenClawAgentFactAvailability;
  bridgePaths: string[];
  existingBridgePaths: string[];
}

export interface OpenClawAgentSkillFacts {
  availability: OpenClawAgentFactAvailability;
  workspaceSkillIds: string[];
  sharedSkillIds: string[];
  contextBridgePaths: string[];
}

export interface OpenClawAgentMemoryFacts {
  availability: OpenClawAgentFactAvailability;
  rootBridgePaths: string[];
  entryBridgePaths: string[];
  categories: string[];
  markdownFileCount: number;
}

export interface OpenClawAgentScheduledTaskFacts {
  availability: OpenClawAgentFactAvailability;
  sessionsIndexPath: string;
  observedTaskCount?: number;
  observedCronLikeTaskCount?: number;
  lastCronLikeActivityAt?: string;
}

export interface OpenClawAgentUsageFacts {
  taskCounts: {
    availability: OpenClawAgentFactAvailability;
    observedTaskCount?: number;
    todayTaskCount?: number;
  };
  tokenUsage: OpenClawAgentFactAvailability & {
    totalTokens?: number;
    todayTokens?: number;
  };
}

export interface OpenClawAgentFactSnapshot {
  schemaVersion: 1;
  generatedAt: string;
  soul: OpenClawAgentFileDomainFacts;
  personality: OpenClawAgentFileDomainFacts;
  identity: OpenClawAgentFileDomainFacts;
  skills: OpenClawAgentSkillFacts;
  memory: OpenClawAgentMemoryFacts;
  scheduledTasks: OpenClawAgentScheduledTaskFacts;
  usage: OpenClawAgentUsageFacts;
}

export interface OpenClawAgentFilesListResult {
  agentId: string;
  stateDir: string;
  configPath: string;
  workspaceDir: string;
  files: OpenClawAgentFileBridgeDescriptor[];
  factSnapshot: OpenClawAgentFactSnapshot;
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
  workspaceDirs: string[];
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

interface OpenClawSessionIndexSummary {
  totalObservedSessions: number;
  todayObservedSessions: number;
  cronLikeObservedSessions: number;
  lastCronLikeActivityAt?: string;
}

interface OpenClawUsageSummary {
  totalTokens: number;
  todayTokens: number;
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

function normalizeOptionalToken(value: unknown): string | undefined {
  return normalizeOptionalString(value)?.toLowerCase();
}

function parseTimestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = Math.trunc(value);
    return normalized > 0 ? normalized : undefined;
  }

  const stringValue = normalizeOptionalString(value);
  if (!stringValue) {
    return undefined;
  }

  if (/^\d+$/.test(stringValue)) {
    const parsed = Number.parseInt(stringValue, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }

  const parsed = Date.parse(stringValue);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return value as Record<string, unknown>;
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

function resolveAgentWorkspaceDirs(config: OpenClawConfigLike, stateDir: string, agentId: string): string[] {
  const normalizedAgentId = normalizeAgentId(agentId);
  const entries = listAgentEntries(config);
  const agentEntry = entries.find((entry) => normalizeAgentId(normalizeOptionalString(entry.id)) === normalizedAgentId);
  const explicitWorkspace = normalizeOptionalString(agentEntry?.workspace);
  const defaultWorkspace = normalizeOptionalString(config.agents?.defaults?.workspace);
  const candidates: string[] = [];

  const pushCandidate = (value?: string | null): void => {
    const normalized = normalizeOptionalString(value);
    if (!normalized) {
      return;
    }
    const resolved = stripNullBytes(resolveUserPath(normalized));
    if (!candidates.includes(resolved)) {
      candidates.push(resolved);
    }
  };

  pushCandidate(explicitWorkspace);
  pushCandidate(defaultWorkspace);
  pushCandidate(join(stateDir, `workspace-${normalizedAgentId}`));
  if (normalizedAgentId === resolveDefaultAgentId(config) || entries.length === 0) {
    pushCandidate(join(stateDir, 'workspace'));
  }

  if (candidates.length === 0) {
    pushCandidate(join(stateDir, 'workspace'));
  }
  return candidates;
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

function dedupeAndSort(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function isCronLikeSessionEntry(entry: Record<string, unknown>): boolean {
  const origin = asRecord(entry.origin) ?? {};
  const provider = normalizeOptionalToken(origin.provider);
  const surface = normalizeOptionalToken(origin.surface);
  const originChatType = normalizeOptionalToken(origin.chatType);
  const chatType = normalizeOptionalToken(entry.chatType);
  return provider === "cron" || surface === "cron" || originChatType === "cron" || chatType === "cron";
}

function formatLocalDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseSessionsIndexSummary(content: string): OpenClawSessionIndexSummary {
  const parsed = JSON.parse(content) as unknown;
  let entries: unknown[] = [];
  if (Array.isArray(parsed)) {
    entries = parsed;
  } else {
    entries = Object.values(asRecord(parsed) ?? {});
  }

  let totalObservedSessions = 0;
  let todayObservedSessions = 0;
  let cronLikeObservedSessions = 0;
  let lastCronLikeActivityMs = 0;
  const todayKey = formatLocalDayKey(new Date());

  for (const entry of entries) {
    const record = asRecord(entry);
    if (!record) {
      continue;
    }

    totalObservedSessions += 1;
    const updatedAtMs = parseTimestampMs(record.updatedAt);
    if (updatedAtMs && formatLocalDayKey(new Date(updatedAtMs)) == todayKey) {
      todayObservedSessions += 1;
    }
    if (!isCronLikeSessionEntry(record)) {
      continue;
    }

    cronLikeObservedSessions += 1;
    if (updatedAtMs && updatedAtMs > lastCronLikeActivityMs) {
      lastCronLikeActivityMs = updatedAtMs;
    }
  }

  return {
    totalObservedSessions,
    todayObservedSessions,
    cronLikeObservedSessions,
    ...(lastCronLikeActivityMs > 0 ? { lastCronLikeActivityAt: new Date(lastCronLikeActivityMs).toISOString() } : {})
  };
}

function buildFileDomainFacts(
  files: OpenClawAgentFileBridgeDescriptor[],
  detailIfAvailable: string,
  detailIfUnavailable: string
): OpenClawAgentFileDomainFacts {
  const bridgePaths = dedupeAndSort(files.map((file) => file.bridgePath));
  const existingBridgePaths = dedupeAndSort(files.filter((file) => file.exists).map((file) => file.bridgePath));
  const available = existingBridgePaths.length > 0;

  return {
    availability: {
      available,
      source: "openclaw-filesystem",
      detail: available ? detailIfAvailable : detailIfUnavailable
    },
    bridgePaths,
    existingBridgePaths
  };
}

function extractSkillIdsByPrefix(bridgePaths: string[], prefix: string): string[] {
  const suffixPrefix = `${prefix}/`;
  const ids = new Set<string>();
  for (const bridgePath of bridgePaths) {
    if (!bridgePath.startsWith(suffixPrefix)) {
      continue;
    }
    const relative = bridgePath.slice(suffixPrefix.length);
    const [skillId] = relative.split("/");
    const normalizedSkillId = skillId?.trim();
    if (!normalizedSkillId) {
      continue;
    }
    ids.add(normalizedSkillId);
  }
  return [...ids].sort((left, right) => left.localeCompare(right));
}

function extractMemoryCategories(memoryEntryBridgePaths: string[]): string[] {
  const categories = new Set<string>();
  for (const bridgePath of memoryEntryBridgePaths) {
    const relative = bridgePath.slice("workspace/memory/".length);
    if (!relative) {
      continue;
    }
    const parts = relative.split("/").filter(Boolean);
    if (parts.length <= 1) {
      categories.add("root");
      continue;
    }
    categories.add(parts[0] ?? "root");
  }
  return [...categories].sort((left, right) => left.localeCompare(right));
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
      if (!targetsByPath.has(target.bridgePath)) {
        targetsByPath.set(target.bridgePath, target);
      }
    };

    addTarget({
      bridgePath: "config/openclaw.json",
      absolutePath: this.configPath,
      domain: "config",
      category: "config",
      rootDir: dirname(this.configPath)
    });

    for (const workspaceDir of context.workspaceDirs) {
      for (const fileName of WORKSPACE_ROOT_FILES) {
        addTarget({
          bridgePath: `workspace/${fileName}`,
          absolutePath: join(workspaceDir, fileName),
          domain: "workspace",
          category: categorizeWorkspaceRootFile(fileName),
          rootDir: workspaceDir
        });
      }

      const memoryDir = join(workspaceDir, "memory");
      for (const absolutePath of await listMarkdownFiles(memoryDir)) {
        addTarget({
          bridgePath: `workspace/memory/${toNormalizedRelativePath(memoryDir, absolutePath)}`,
          absolutePath,
          domain: "workspace-memory",
          category: "memory",
          rootDir: workspaceDir
        });
      }

      for (const target of await loadSkillTargets(
        join(workspaceDir, "skills"),
        "workspace/skills",
        "workspace-skill"
      )) {
        addTarget(target);
      }
    }

    for (const target of await loadSkillTargets(join(this.stateDir, "skills"), "shared-skills", "shared-skill")) {
      addTarget(target);
    }

    const sortedTargets = sortTargets([...targetsByPath.values()]);
    const descriptors = await Promise.all(sortedTargets.map(async (target) => await this.describeTarget(target)));
    const factSnapshot = await this.buildFactSnapshot(context, descriptors);

    return {
      agentId: context.agentId,
      stateDir: this.stateDir,
      configPath: this.configPath,
      workspaceDir: context.workspaceDir,
      files: descriptors,
      factSnapshot
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

  private async buildFactSnapshot(
    context: ResolvedAgentContext,
    files: OpenClawAgentFileBridgeDescriptor[]
  ): Promise<OpenClawAgentFactSnapshot> {
    const soulFiles = files.filter((file) => file.category === "soul" || file.category === "personality");
    const identityFiles = files.filter((file) => file.category === "identity");
    const memoryFiles = files.filter((file) => file.category === "memory");
    const skillFiles = files.filter((file) => file.category === "skills");
    const configFiles = files.filter((file) => file.category === "config");

    const soul = buildFileDomainFacts(
      soulFiles,
      "检测到宿主端 Soul / Personality 文件。",
      "未检测到宿主端 Soul / Personality 文件。"
    );
    const personality = buildFileDomainFacts(
      soulFiles.filter((file) => file.category === "personality"),
      "检测到宿主端 personality 文件。",
      "未检测到独立 personality 文件。"
    );
    const identity = buildFileDomainFacts(
      identityFiles,
      "检测到宿主端 identity 文件。",
      "未检测到宿主端 identity 文件。"
    );

    const workspaceSkillIds = extractSkillIdsByPrefix(
      skillFiles.map((file) => file.bridgePath),
      "workspace/skills"
    );
    const sharedSkillIds = extractSkillIdsByPrefix(
      skillFiles.map((file) => file.bridgePath),
      "shared-skills"
    );

    const sessionsIndexPath = join(this.stateDir, "agents", context.agentId, "sessions", "sessions.json");
    const sessionsIndexCurrent = await this.tryReadCurrent(sessionsIndexPath);
    const sessionsIndexSummary = sessionsIndexCurrent
      ? parseSessionsIndexSummary(sessionsIndexCurrent.content)
      : undefined;
    const usageSummary = await this.collectUsageSummary(context.agentId);

    const memoryEntryBridgePaths = memoryFiles
      .filter((file) => file.bridgePath.startsWith("workspace/memory/"))
      .map((file) => file.bridgePath);

    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      soul,
      personality,
      identity,
      skills: {
        availability: {
          available: skillFiles.some((file) => file.exists),
          source: skillFiles.some((file) => file.exists) ? "openclaw-filesystem" : "unavailable",
          detail: skillFiles.some((file) => file.exists)
            ? "已从 OpenClaw 技能目录读取技能事实。"
            : "未在本地 OpenClaw 技能目录中发现技能事实。"
        },
        workspaceSkillIds,
        sharedSkillIds,
        contextBridgePaths: dedupeAndSort(skillFiles.map((file) => file.bridgePath))
      },
      memory: {
        availability: {
          available: memoryFiles.some((file) => file.exists),
          source: memoryFiles.some((file) => file.exists) ? "openclaw-filesystem" : "unavailable",
          detail: memoryFiles.some((file) => file.exists)
            ? "已从 MEMORY / memory/*.md 读取记忆事实。"
            : "未发现本地记忆文件。"
        },
        rootBridgePaths: dedupeAndSort(
          memoryFiles
            .filter((file) => file.bridgePath === "workspace/MEMORY.md" || file.bridgePath === "workspace/memory.md")
            .map((file) => file.bridgePath)
        ),
        entryBridgePaths: dedupeAndSort(memoryEntryBridgePaths),
        categories: extractMemoryCategories(memoryEntryBridgePaths),
        markdownFileCount: memoryFiles.filter((file) => file.exists).length
      },
      scheduledTasks: {
        availability: {
          available: Boolean(sessionsIndexCurrent),
          source: sessionsIndexCurrent ? "openclaw-sessions-index" : "unavailable",
          detail: sessionsIndexCurrent
            ? "已从 OpenClaw sessions 索引观察定时任务活动。"
            : "未发现可用的 OpenClaw sessions 索引。"
        },
        sessionsIndexPath,
        ...(sessionsIndexSummary
          ? {
              observedTaskCount: sessionsIndexSummary.totalObservedSessions,
              observedCronLikeTaskCount: sessionsIndexSummary.cronLikeObservedSessions,
              ...(sessionsIndexSummary.lastCronLikeActivityAt
                ? { lastCronLikeActivityAt: sessionsIndexSummary.lastCronLikeActivityAt }
                : {})
            }
          : {})
      },
      usage: {
        taskCounts: {
          availability: {
            available: Boolean(sessionsIndexCurrent),
            source: sessionsIndexCurrent ? "openclaw-sessions-index" : "unavailable",
            detail: sessionsIndexCurrent
              ? "已从 OpenClaw sessions 索引统计任务数。"
              : "未发现可统计的本地任务索引。"
          },
          ...(sessionsIndexSummary
            ? {
                observedTaskCount: sessionsIndexSummary.totalObservedSessions,
                todayTaskCount: sessionsIndexSummary.todayObservedSessions
              }
            : {})
        },
        tokenUsage: {
          available: usageSummary.totalTokens > 0 || usageSummary.todayTokens > 0,
          source:
            usageSummary.totalTokens > 0 || usageSummary.todayTokens > 0
              ? "openclaw-sessions-index"
              : "unavailable",
          detail:
            usageSummary.totalTokens > 0 || usageSummary.todayTokens > 0
              ? "已从 OpenClaw agent sessions transcript 聚合 token usage。"
              : "未发现可统计的本地 token transcript。",
          ...(usageSummary.totalTokens > 0 ? { totalTokens: usageSummary.totalTokens } : {}),
          ...(usageSummary.todayTokens > 0 ? { todayTokens: usageSummary.todayTokens } : {})
        }
      }
    };
  }

  private async collectUsageSummary(agentId: string): Promise<OpenClawUsageSummary> {
    const sessionsDir = join(this.stateDir, 'agents', agentId, 'sessions');
    const entries = await readdir(sessionsDir, { withFileTypes: true }).catch(() => [] as Dirent[]);
    const todayKey = formatLocalDayKey(new Date());
    let totalTokens = 0;
    let todayTokens = 0;

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
        continue;
      }
      const filePath = join(sessionsDir, entry.name);
      let content = '';
      try {
        content = await readFile(filePath, 'utf-8');
      } catch {
        continue;
      }
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          continue;
        }
        const record = asRecord(parsed);
        const message = asRecord(record?.message);
        const usage = asRecord(message?.usage ?? record?.usage);
        if (!usage) {
          continue;
        }
        const input = Number(usage.input ?? 0) || 0;
        const output = Number(usage.output ?? 0) || 0;
        const cacheRead = Number(usage.cacheRead ?? usage.cache_read ?? 0) || 0;
        const cacheWrite = Number(usage.cacheWrite ?? usage.cache_write ?? 0) || 0;
        const total = Number(usage.total ?? input + output + cacheRead + cacheWrite) || 0;
        if (total <= 0) {
          continue;
        }
        totalTokens += total;
        const ts = parseTimestampMs(record?.timestamp ?? message?.timestamp);
        if (ts && formatLocalDayKey(new Date(ts)) === todayKey) {
          todayTokens += total;
        }
      }
    }

    return { totalTokens, todayTokens };
  }

  private async resolveAgentContext(agentId?: string): Promise<ResolvedAgentContext> {
    const config = await this.readConfig();
    const normalizedAgentId = normalizeAgentId(agentId ?? resolveDefaultAgentId(config));

    const workspaceDirs = resolveAgentWorkspaceDirs(config, this.stateDir, normalizedAgentId);
    return {
      agentId: normalizedAgentId,
      stateDir: this.stateDir,
      configPath: this.configPath,
      workspaceDir: workspaceDirs[0] ?? stripNullBytes(join(this.stateDir, 'workspace')),
      workspaceDirs
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
