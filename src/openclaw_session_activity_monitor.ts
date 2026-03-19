import { constants as fsConstants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_RECENT_SESSION_UPDATE_MS = 120_000;
const DEFAULT_LOCK_RECENT_SESSION_MS = 900_000;
const DEFAULT_LOCK_FRESH_MS = 600_000;
const FUTURE_SKEW_TOLERANCE_MS = 60_000;
const OPENCLAW_AGENTS_DIR = join(homedir(), ".openclaw", "agents");

const PROVIDER_LABELS: Record<string, string> = {
  api: "API",
  cron: "Cron",
  direct: "Direct",
  discord: "Discord",
  email: "Email",
  feishu: "Feishu",
  lark: "Lark",
  slack: "Slack",
  telegram: "Telegram",
  web: "Web",
  wechat: "WeChat"
};

export type OpenClawSessionActivitySignal = "lock" | "recent-update" | "inactive";

export interface OpenClawAgentActivity {
  agentId: string;
  isActive: boolean;
  signal: OpenClawSessionActivitySignal;
  title?: string;
  summary?: string;
  updatedAtMs?: number;
}

export interface SessionActivityMonitor {
  refresh(): Promise<OpenClawAgentActivity[]>;
  start(onUpdate: (activities: OpenClawAgentActivity[]) => void): () => void;
}

export type SessionActivityMonitorFactory = (agentIds: string[]) => SessionActivityMonitor;

interface OpenClawSessionActivityMonitorOptions {
  agentIds: string[];
  pollIntervalMs?: number;
  recentSessionUpdateMs?: number;
  lockRecentSessionMs?: number;
  lockFreshMs?: number;
  agentsRootDir?: string;
  now?: () => Date;
  onError?: (error: unknown) => void;
  readFileUtf8?: (path: string) => Promise<string>;
  statFile?: (path: string) => Promise<{ mtimeMs: number }>;
  fileExists?: (path: string) => Promise<boolean>;
  isProcessRunning?: (pid: number) => boolean;
}

interface SessionOriginMetadata {
  provider?: string;
  surface?: string;
  chatType?: string;
  from?: string;
  to?: string;
  accountId?: string;
}

interface SessionMetadata {
  sessionId?: string;
  updatedAtMs: number;
  chatType?: string;
  sessionFile?: string;
  origin: SessionOriginMetadata;
}

interface SessionActivityText {
  title: string;
  summary: string;
}

interface LockMetadata {
  pid?: number;
  createdAtMs?: number;
}

function normalizeAgentIds(agentIds: string[]): string[] {
  const unique = new Set<string>();
  for (const rawAgentId of agentIds) {
    const agentId = rawAgentId.trim();
    if (!agentId) {
      continue;
    }
    unique.add(agentId);
  }
  return [...unique];
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function normalizeToken(value: unknown): string | undefined {
  return normalizeString(value)?.toLowerCase();
}

function parseTimestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = Math.trunc(value);
    return normalized > 0 ? normalized : undefined;
  }

  const stringValue = normalizeString(value);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractSessionMetadata(entry: unknown): SessionMetadata | undefined {
  if (!isRecord(entry)) {
    return undefined;
  }

  const originRaw = isRecord(entry.origin) ? entry.origin : {};
  const updatedAtMs = parseTimestampMs(entry.updatedAt) ?? 0;
  const sessionId = normalizeString(entry.sessionId);
  const chatType = normalizeString(entry.chatType);
  const sessionFile = normalizeString(entry.sessionFile);
  const provider = normalizeString(originRaw.provider);
  const surface = normalizeString(originRaw.surface);
  const originChatType = normalizeString(originRaw.chatType);
  const from = normalizeString(originRaw.from);
  const to = normalizeString(originRaw.to);
  const accountId = normalizeString(originRaw.accountId);

  const origin: SessionOriginMetadata = {
    ...(provider ? { provider } : {}),
    ...(surface ? { surface } : {}),
    ...(originChatType ? { chatType: originChatType } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(accountId ? { accountId } : {})
  };

  return {
    ...(sessionId ? { sessionId } : {}),
    updatedAtMs,
    ...(chatType ? { chatType } : {}),
    ...(sessionFile ? { sessionFile } : {}),
    origin
  };
}

function parseSessionsMetadata(content: string): SessionMetadata[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }

  let entries: unknown[] = [];
  if (Array.isArray(parsed)) {
    entries = parsed;
  } else if (isRecord(parsed)) {
    entries = Object.values(parsed);
  }

  const sessions: SessionMetadata[] = [];
  for (const entry of entries) {
    const session = extractSessionMetadata(entry);
    if (!session) {
      continue;
    }
    sessions.push(session);
  }

  sessions.sort((left, right) => right.updatedAtMs - left.updatedAtMs);
  return sessions;
}

function formatLabel(token: string): string {
  if (!token) {
    return token;
  }

  const known = PROVIDER_LABELS[token];
  if (known) {
    return known;
  }

  return token
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function resolveSignalLabel(session: SessionMetadata): { label?: string; isCron: boolean } {
  const provider = normalizeToken(session.origin.provider) ?? normalizeToken(session.origin.surface);
  const chatType = normalizeToken(session.origin.chatType) ?? normalizeToken(session.chatType);

  if (provider === "cron" || chatType === "cron") {
    return { label: "Cron", isCron: true };
  }

  if (provider) {
    return { label: formatLabel(provider), isCron: false };
  }

  if (chatType) {
    return { label: formatLabel(chatType), isCron: false };
  }

  return { isCron: false };
}

function buildRoutingHint(session: SessionMetadata): string | undefined {
  const from = normalizeString(session.origin.from);
  const to = normalizeString(session.origin.to);
  if (from && to) {
    return `${from} -> ${to}`;
  }
  return from ?? to;
}

function buildSessionActivityText(signal: "lock" | "recent-update", session: SessionMetadata): SessionActivityText {
  const context = resolveSignalLabel(session);
  const title =
    signal === "lock"
      ? context.isCron
        ? "Cron 任务执行中"
        : context.label
          ? `${context.label} 会话处理中`
          : "会话处理中"
      : context.isCron
        ? "Cron 最近有任务活动"
        : context.label
          ? `${context.label} 最近有会话活动`
          : "最近有会话活动";

  const routingHint = buildRoutingHint(session);
  return {
    title,
    summary: routingHint ? `${title} (${routingHint})` : title
  };
}

function isFreshTimestamp(timestampMs: number | undefined, nowMs: number, maxAgeMs: number): boolean {
  if (!timestampMs || !Number.isFinite(timestampMs) || timestampMs <= 0) {
    return false;
  }

  const ageMs = nowMs - timestampMs;
  if (ageMs < -FUTURE_SKEW_TOLERANCE_MS) {
    return false;
  }
  return ageMs <= maxAgeMs;
}

function resolveSessionFilePath(agentId: string, sessionFile: string, agentsRootDir: string): string {
  if (isAbsolute(sessionFile)) {
    return sessionFile;
  }
  return join(agentsRootDir, agentId, "sessions", sessionFile);
}

function parsePid(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
  }

  return undefined;
}

function parseLockMetadata(content: string): LockMetadata {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (isRecord(parsed)) {
      const pid = parsePid(parsed.pid);
      const createdAtMs = parseTimestampMs(parsed.createdAt);
      return {
        ...(pid ? { pid } : {}),
        ...(createdAtMs ? { createdAtMs } : {})
      };
    }
  } catch {
    // Continue with regex fallback.
  }

  const pidMatch = content.match(/\bpid\b\D*(\d+)/i);
  const createdAtMatch = content.match(/\bcreatedAt\b\D*([^\n\r]+)/i);

  const pid = pidMatch ? parsePid(pidMatch[1]) : undefined;
  const createdAtMs = createdAtMatch ? parseTimestampMs(createdAtMatch[1]) : undefined;
  return {
    ...(pid ? { pid } : {}),
    ...(createdAtMs ? { createdAtMs } : {})
  };
}

function defaultIsProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

async function defaultFileExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export class OpenClawSessionActivityMonitor implements SessionActivityMonitor {
  private readonly agentIds: string[];
  private readonly pollIntervalMs: number;
  private readonly recentSessionUpdateMs: number;
  private readonly lockRecentSessionMs: number;
  private readonly lockFreshMs: number;
  private readonly agentsRootDir: string;
  private readonly now: () => Date;
  private readonly onError: (error: unknown) => void;
  private readonly readFileUtf8: (path: string) => Promise<string>;
  private readonly statFile: (path: string) => Promise<{ mtimeMs: number }>;
  private readonly fileExists: (path: string) => Promise<boolean>;
  private readonly isProcessRunning: (pid: number) => boolean;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: OpenClawSessionActivityMonitorOptions) {
    this.agentIds = normalizeAgentIds(options.agentIds);
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.recentSessionUpdateMs = options.recentSessionUpdateMs ?? DEFAULT_RECENT_SESSION_UPDATE_MS;
    this.lockRecentSessionMs = options.lockRecentSessionMs ?? DEFAULT_LOCK_RECENT_SESSION_MS;
    this.lockFreshMs = options.lockFreshMs ?? DEFAULT_LOCK_FRESH_MS;
    this.agentsRootDir = options.agentsRootDir ?? OPENCLAW_AGENTS_DIR;
    this.now = options.now ?? (() => new Date());
    this.onError =
      options.onError ??
      ((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`OpenClaw session activity monitor error: ${message}`);
      });
    this.readFileUtf8 = options.readFileUtf8 ?? ((path) => readFile(path, "utf-8"));
    this.statFile = options.statFile ?? ((path) => stat(path));
    this.fileExists = options.fileExists ?? defaultFileExists;
    this.isProcessRunning = options.isProcessRunning ?? defaultIsProcessRunning;
  }

  async refresh(): Promise<OpenClawAgentActivity[]> {
    const activities = await Promise.all(this.agentIds.map((agentId) => this.collectAgentActivity(agentId)));
    return activities;
  }

  start(onUpdate: (activities: OpenClawAgentActivity[]) => void): () => void {
    if (this.timer) {
      throw new Error("OpenClaw session activity monitor is already running.");
    }

    const poll = async () => {
      const activities = await this.refresh();
      onUpdate(activities);
    };

    void poll().catch((error) => {
      this.onError(error);
    });

    // Lightweight polling keeps heartbeat status fresh without aggressively scanning session files.
    this.timer = setInterval(() => {
      void poll().catch((error) => {
        this.onError(error);
      });
    }, this.pollIntervalMs);

    return () => this.stop();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async collectAgentActivity(agentId: string): Promise<OpenClawAgentActivity> {
    const sessionsIndexPath = join(this.agentsRootDir, agentId, "sessions", "sessions.json");

    let sessions: SessionMetadata[];
    try {
      const content = await this.readFileUtf8(sessionsIndexPath);
      sessions = parseSessionsMetadata(content);
    } catch {
      return {
        agentId,
        isActive: false,
        signal: "inactive"
      };
    }

    if (sessions.length === 0) {
      return {
        agentId,
        isActive: false,
        signal: "inactive"
      };
    }

    const nowMs = this.now().getTime();
    const lockSession = await this.findSessionWithActiveLock(agentId, sessions, nowMs);
    if (lockSession) {
      const text = buildSessionActivityText("lock", lockSession);
      return {
        agentId,
        isActive: true,
        signal: "lock",
        title: text.title,
        summary: text.summary,
        updatedAtMs: lockSession.updatedAtMs
      };
    }

    const latestSession = sessions.at(0);
    if (!latestSession) {
      return {
        agentId,
        isActive: false,
        signal: "inactive"
      };
    }

    if (isFreshTimestamp(latestSession.updatedAtMs, nowMs, this.recentSessionUpdateMs)) {
      const text = buildSessionActivityText("recent-update", latestSession);
      return {
        agentId,
        isActive: true,
        signal: "recent-update",
        title: text.title,
        summary: text.summary,
        updatedAtMs: latestSession.updatedAtMs
      };
    }

    return {
      agentId,
      isActive: false,
      signal: "inactive"
    };
  }

  private async findSessionWithActiveLock(
    agentId: string,
    sessions: SessionMetadata[],
    nowMs: number
  ): Promise<SessionMetadata | undefined> {
    for (const session of sessions) {
      if (!session.sessionFile) {
        continue;
      }
      if (!isFreshTimestamp(session.updatedAtMs, nowMs, this.lockRecentSessionMs)) {
        continue;
      }

      const sessionPath = resolveSessionFilePath(agentId, session.sessionFile, this.agentsRootDir);
      const lockPath = `${sessionPath}.lock`;
      if (await this.hasActiveLock(lockPath, nowMs)) {
        return session;
      }
    }

    return undefined;
  }

  private async hasActiveLock(lockPath: string, nowMs: number): Promise<boolean> {
    if (!(await this.fileExists(lockPath))) {
      return false;
    }

    let content: string | undefined;
    try {
      content = await this.readFileUtf8(lockPath);
    } catch {
      content = undefined;
    }

    if (content) {
      const lock = parseLockMetadata(content);
      if (lock.pid && this.isProcessRunning(lock.pid)) {
        return true;
      }
      if (isFreshTimestamp(lock.createdAtMs, nowMs, this.lockFreshMs)) {
        return true;
      }
    }

    try {
      const fileStat = await this.statFile(lockPath);
      return isFreshTimestamp(fileStat.mtimeMs, nowMs, this.lockFreshMs);
    } catch {
      return false;
    }
  }
}
