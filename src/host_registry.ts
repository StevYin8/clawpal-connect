import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface RegisteredHost {
  hostId: string;
  userId: string;
  hostName: string;
  backendUrl: string;
  connectorToken?: string;
  bindingCode?: string;
  boundAt: string;
  updatedAt: string;
}

export interface HostRegistryState {
  activeHostId: string | null;
  hosts: Record<string, RegisteredHost>;
  updatedAt: string;
}

interface HostRegistryStoreFile {
  version: 1;
  state: HostRegistryState;
}

export interface BindHostRequest {
  hostId: string;
  userId: string;
  hostName: string;
  backendUrl: string;
  connectorToken?: string;
  bindingCode?: string;
}

interface HostRegistryOptions {
  filePath?: string;
  now?: () => Date;
}

export function resolveDefaultHostRegistryFilePath(): string {
  return join(homedir(), ".clawpal-connect", "host-registry.json");
}

export function createEmptyHostRegistryState(now = new Date()): HostRegistryState {
  return {
    activeHostId: null,
    hosts: {},
    updatedAt: now.toISOString()
  };
}

export function upsertRegisteredHost(
  hosts: Record<string, RegisteredHost>,
  incoming: RegisteredHost
): Record<string, RegisteredHost> {
  return {
    ...hosts,
    [incoming.hostId]: incoming
  };
}

export function removeRegisteredHost(
  hosts: Record<string, RegisteredHost>,
  hostId: string
): Record<string, RegisteredHost> {
  const next = { ...hosts };
  delete next[hostId];
  return next;
}

function normalizeRequired(input: string, field: string): string {
  const value = input.trim();
  if (!value) {
    throw new Error(`${field} cannot be empty.`);
  }
  return value;
}

function normalizeOptional(input?: string): string | undefined {
  const value = input?.trim();
  return value ? value : undefined;
}

export class HostRegistry {
  private readonly filePath: string;
  private readonly now: () => Date;

  constructor(options: HostRegistryOptions = {}) {
    this.filePath = options.filePath ?? resolveDefaultHostRegistryFilePath();
    this.now = options.now ?? (() => new Date());
  }

  getStoreFilePath(): string {
    return this.filePath;
  }

  async loadState(): Promise<HostRegistryState> {
    const store = await this.readStore();
    return store.state;
  }

  async getActiveHost(): Promise<RegisteredHost | null> {
    const state = await this.loadState();
    if (!state.activeHostId) {
      return null;
    }
    return state.hosts[state.activeHostId] ?? null;
  }

  async bindHost(request: BindHostRequest): Promise<HostRegistryState> {
    const store = await this.readStore();
    const nowIso = this.now().toISOString();

    const hostId = normalizeRequired(request.hostId, "hostId");
    const userId = normalizeRequired(request.userId, "userId");
    const hostName = normalizeRequired(request.hostName, "hostName");
    const backendUrl = normalizeRequired(request.backendUrl, "backendUrl");
    const connectorToken = normalizeOptional(request.connectorToken);
    const bindingCode = normalizeOptional(request.bindingCode);

    const existing = store.state.hosts[hostId];
    const host: RegisteredHost = {
      hostId,
      userId,
      hostName,
      backendUrl,
      ...(connectorToken ? { connectorToken } : {}),
      ...(bindingCode ? { bindingCode } : {}),
      boundAt: existing?.boundAt ?? nowIso,
      updatedAt: nowIso
    };

    const next: HostRegistryState = {
      activeHostId: hostId,
      hosts: upsertRegisteredHost(store.state.hosts, host),
      updatedAt: nowIso
    };

    await this.writeStore({ version: 1, state: next });
    return next;
  }

  async unbindHost(hostId?: string): Promise<HostRegistryState> {
    const store = await this.readStore();
    const targetHostId = hostId?.trim() || store.state.activeHostId;
    if (!targetHostId) {
      return store.state;
    }

    const hosts = removeRegisteredHost(store.state.hosts, targetHostId);
    const nextActiveHostId =
      store.state.activeHostId === targetHostId
        ? Object.keys(hosts)[0] ?? null
        : store.state.activeHostId;

    const next: HostRegistryState = {
      activeHostId: nextActiveHostId,
      hosts,
      updatedAt: this.now().toISOString()
    };

    await this.writeStore({ version: 1, state: next });
    return next;
  }

  private async readStore(): Promise<HostRegistryStoreFile> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<HostRegistryStoreFile>;
      if (parsed.version !== 1 || !parsed.state || typeof parsed.state !== "object") {
        return { version: 1, state: createEmptyHostRegistryState(this.now()) };
      }

      const state = parsed.state as Partial<HostRegistryState>;
      const hosts = state.hosts && typeof state.hosts === "object" ? state.hosts : {};
      return {
        version: 1,
        state: {
          activeHostId: typeof state.activeHostId === "string" ? state.activeHostId : null,
          hosts,
          updatedAt:
            typeof state.updatedAt === "string" ? state.updatedAt : createEmptyHostRegistryState(this.now()).updatedAt
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, state: createEmptyHostRegistryState(this.now()) };
      }
      throw error;
    }
  }

  private async writeStore(store: HostRegistryStoreFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(store, null, 2), "utf8");
  }
}

// TODO(official-backend): replace local connector token persistence with secure credential storage.
