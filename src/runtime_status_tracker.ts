import type { ForwardedRequest } from "./backend_client.js";
import type { ChannelConnectionSnapshot } from "./channel_connection_snapshot.js";
import type { AgentStatusProvider } from "./heartbeat_manager.js";
import type { OpenClawAgentActivity } from "./openclaw_session_activity_monitor.js";
import { extractAgentsFromConfig, readOpenClawConfig } from "./openclaw_config.js";

const MAX_WORK_TITLE_CHARS = 72;
const MAX_WORK_SUMMARY_CHARS = 220;
const FALLBACK_WORK_TITLE = "Handling forwarded request";
const FALLBACK_LOCAL_WORK_TITLE = "会话处理中";
const FALLBACK_LOCAL_WORK_SUMMARY = "检测到本地会话活动";

interface ActiveWorkContext {
  requestId: string;
  agentId: string;
  title: string;
  summary: string;
  sequence: number;
}

export type SyncedAgentIdProvider = () => Promise<string[]>;

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

function normalizeWhitespace(input: string): string {
  return input.trim().replace(/\s+/g, " ");
}

function truncate(input: string, maxChars: number): string {
  if (input.length <= maxChars) {
    return input;
  }
  if (maxChars <= 3) {
    return input.slice(0, maxChars);
  }
  return `${input.slice(0, maxChars - 3)}...`;
}

function buildWorkTitle(message: string): string {
  if (!message) {
    return FALLBACK_WORK_TITLE;
  }
  return truncate(message, MAX_WORK_TITLE_CHARS);
}

function buildWorkSummary(request: ForwardedRequest, message: string): string {
  if (message) {
    return truncate(message, MAX_WORK_SUMMARY_CHARS);
  }
  return `Forwarded request ${request.requestId} (conversation ${request.conversationId})`;
}

export async function loadSyncedAgentIdsFromOpenClawConfig(): Promise<string[]> {
  const config = await readOpenClawConfig();
  if (!config) {
    return [];
  }
  return normalizeAgentIds(extractAgentsFromConfig(config).map((agent) => agent.agentId));
}

export class RuntimeStatusTracker {
  private readonly agentStatusProviders: AgentStatusProvider[];
  private readonly activeWorkByRequestId = new Map<string, ActiveWorkContext>();
  private readonly localSessionActivityByAgentId = new Map<string, OpenClawAgentActivity>();
  private readonly channelSnapshotsByAgentId = new Map<string, ChannelConnectionSnapshot>();
  private nextSequence = 0;

  constructor(agentIds: string[]) {
    this.agentStatusProviders = normalizeAgentIds(agentIds).map((agentId) => ({
      agentId,
      displayStatus: "idle"
    }));
  }

  getAgentStatusProviders(): AgentStatusProvider[] {
    return this.agentStatusProviders;
  }

  hasActiveWork(): boolean {
    return this.activeWorkByRequestId.size > 0 || this.localSessionActivityByAgentId.size > 0;
  }

  updateOpenClawSessionActivities(activities: OpenClawAgentActivity[]): void {
    this.localSessionActivityByAgentId.clear();
    for (const activity of activities) {
      if (!activity.isActive) {
        continue;
      }
      this.localSessionActivityByAgentId.set(activity.agentId, activity);
    }
    this.syncAgentStatusProviders();
  }

  updateChannelAvailability(snapshots: Map<string, ChannelConnectionSnapshot>): void {
    this.channelSnapshotsByAgentId.clear();
    for (const [agentId, snapshot] of snapshots.entries()) {
      this.channelSnapshotsByAgentId.set(agentId, snapshot);
    }
    this.syncAgentStatusProviders();
  }

  markForwardedRequestStarted(request: ForwardedRequest): void {
    const normalizedMessage = normalizeWhitespace(request.message);
    const title = buildWorkTitle(normalizedMessage);
    const summary = buildWorkSummary(request, normalizedMessage);

    this.activeWorkByRequestId.set(request.requestId, {
      requestId: request.requestId,
      agentId: request.agentId,
      title,
      summary,
      sequence: this.nextSequence
    });
    this.nextSequence += 1;

    this.syncAgentStatusProviders();
  }

  markForwardedRequestCompleted(requestId: string): void {
    this.activeWorkByRequestId.delete(requestId);
    this.syncAgentStatusProviders();
  }

  private syncAgentStatusProviders(): void {
    if (this.agentStatusProviders.length === 0) {
      return;
    }

    if (this.activeWorkByRequestId.size === 0 && this.localSessionActivityByAgentId.size === 0) {
      for (const provider of this.agentStatusProviders) {
        this.resetProviderToIdle(provider);
        this.applyChannelAvailability(provider);
      }
      return;
    }

    for (const provider of this.agentStatusProviders) {
      const activeWork = this.selectMostRecentActiveWorkForAgent(provider.agentId);
      if (activeWork) {
        const additionalActiveRequestCount = this.countAdditionalActiveRequestsForAgent(provider.agentId, activeWork.requestId);
        const workSummary =
          additionalActiveRequestCount > 0
            ? `${activeWork.summary} (+${additionalActiveRequestCount} more active request${additionalActiveRequestCount === 1 ? "" : "s"})`
            : activeWork.summary;

        provider.displayStatus = "working";
        provider.currentWorkTitle = activeWork.title;
        provider.currentWorkSummary = workSummary;
        delete provider.progressCurrent;
        delete provider.progressTotal;
        delete provider.hasPendingConfirmation;
        delete provider.hasActiveError;
        this.applyChannelAvailability(provider);
        continue;
      }

      const localActivity = this.localSessionActivityByAgentId.get(provider.agentId);
      if (!localActivity) {
        this.resetProviderToIdle(provider);
        this.applyChannelAvailability(provider);
        continue;
      }

      provider.displayStatus = "working";
      provider.currentWorkTitle = buildLocalWorkTitle(localActivity.title);
      provider.currentWorkSummary = buildLocalWorkSummary(localActivity.summary, localActivity.title);
      delete provider.progressCurrent;
      delete provider.progressTotal;
      delete provider.hasPendingConfirmation;
      delete provider.hasActiveError;
      this.applyChannelAvailability(provider);
    }
  }

  private selectMostRecentActiveWorkForAgent(agentId: string): ActiveWorkContext | undefined {
    let latest: ActiveWorkContext | undefined;
    for (const activeWork of this.activeWorkByRequestId.values()) {
      if (activeWork.agentId !== agentId) {
        continue;
      }
      if (!latest || activeWork.sequence > latest.sequence) {
        latest = activeWork;
      }
    }
    return latest;
  }

  private countAdditionalActiveRequestsForAgent(agentId: string, currentRequestId: string): number {
    let count = 0;
    for (const activeWork of this.activeWorkByRequestId.values()) {
      if (activeWork.agentId === agentId && activeWork.requestId !== currentRequestId) {
        count += 1;
      }
    }
    return count;
  }

  private resetProviderToIdle(provider: AgentStatusProvider): void {
    provider.displayStatus = "idle";
    delete provider.currentWorkTitle;
    delete provider.currentWorkSummary;
    delete provider.progressCurrent;
    delete provider.progressTotal;
    delete provider.hasPendingConfirmation;
    delete provider.hasActiveError;
  }

  private applyChannelAvailability(provider: AgentStatusProvider): void {
    const snapshot = this.channelSnapshotsByAgentId.get(provider.agentId);
    if (!snapshot) {
      delete provider.providerConnected;
      delete provider.deliveryAvailable;
      delete provider.channelType;
      delete provider.channelAccountId;
      delete provider.availabilityDetail;
      return;
    }

    provider.providerConnected = snapshot.providerConnected;
    provider.deliveryAvailable = snapshot.deliveryAvailable;
    if (snapshot.provider) {
      provider.channelType = snapshot.provider;
    } else {
      delete provider.channelType;
    }
    if (snapshot.accountId) {
      provider.channelAccountId = snapshot.accountId;
    } else {
      delete provider.channelAccountId;
    }
    if (snapshot.detail) {
      provider.availabilityDetail = snapshot.detail;
    } else {
      delete provider.availabilityDetail;
    }

    if (snapshot.deliveryAvailable == false || snapshot.providerConnected == false) {
      provider.displayStatus = "offline";
      if (!provider.currentWorkSummary && snapshot.detail) {
        provider.currentWorkSummary = snapshot.detail;
      }
      if (snapshot.detail) {
        provider.availabilityDetail = snapshot.detail;
      }
    }
  }
}

function buildLocalWorkTitle(title: string | undefined): string {
  const normalized = normalizeWhitespace(title ?? "");
  if (!normalized) {
    return FALLBACK_LOCAL_WORK_TITLE;
  }
  return truncate(normalized, MAX_WORK_TITLE_CHARS);
}

function buildLocalWorkSummary(summary: string | undefined, title: string | undefined): string {
  const normalizedSummary = normalizeWhitespace(summary ?? "");
  if (normalizedSummary) {
    return truncate(normalizedSummary, MAX_WORK_SUMMARY_CHARS);
  }

  const normalizedTitle = normalizeWhitespace(title ?? "");
  if (normalizedTitle) {
    return truncate(normalizedTitle, MAX_WORK_SUMMARY_CHARS);
  }

  return FALLBACK_LOCAL_WORK_SUMMARY;
}
