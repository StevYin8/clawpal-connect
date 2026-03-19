import type { ForwardedRequest } from "./backend_client.js";
import type { AgentStatusProvider } from "./heartbeat_manager.js";
import { extractAgentsFromConfig, readOpenClawConfig } from "./openclaw_config.js";

const MAX_WORK_TITLE_CHARS = 72;
const MAX_WORK_SUMMARY_CHARS = 220;
const FALLBACK_WORK_TITLE = "Handling forwarded request";

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
    return this.activeWorkByRequestId.size > 0;
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

    if (this.activeWorkByRequestId.size === 0) {
      for (const provider of this.agentStatusProviders) {
        provider.displayStatus = "idle";
        delete provider.currentWorkTitle;
        delete provider.currentWorkSummary;
        delete provider.progressCurrent;
        delete provider.progressTotal;
        delete provider.hasPendingConfirmation;
        delete provider.hasActiveError;
      }
      return;
    }

    for (const provider of this.agentStatusProviders) {
      const activeWork = this.selectMostRecentActiveWorkForAgent(provider.agentId);
      if (!activeWork) {
        provider.displayStatus = "idle";
        delete provider.currentWorkTitle;
        delete provider.currentWorkSummary;
        delete provider.progressCurrent;
        delete provider.progressTotal;
        delete provider.hasPendingConfirmation;
        delete provider.hasActiveError;
        continue;
      }

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
}
