import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
export function resolveDefaultBindingFilePath() {
    return join(homedir(), ".clawpal-connect", "bindings.json");
}
export function createEmptyBindingState(hostId, now = new Date()) {
    return {
        hostId,
        devices: [],
        updatedAt: now.toISOString()
    };
}
export function upsertBinding(bindings, incoming) {
    return [incoming, ...bindings.filter((item) => item.deviceId !== incoming.deviceId)];
}
export function removeBinding(bindings, deviceId) {
    return bindings.filter((item) => item.deviceId !== deviceId);
}
export class BindingManager {
    filePath;
    now;
    constructor(options = {}) {
        this.filePath = options.filePath ?? resolveDefaultBindingFilePath();
        this.now = options.now ?? (() => new Date());
    }
    getStoreFilePath() {
        return this.filePath;
    }
    async loadState(hostId) {
        const store = await this.readStore();
        const current = store.hosts[hostId];
        return current ?? createEmptyBindingState(hostId, this.now());
    }
    async bindDevice(hostId, binding) {
        const store = await this.readStore();
        const current = store.hosts[hostId] ?? createEmptyBindingState(hostId, this.now());
        const next = {
            hostId,
            devices: upsertBinding(current.devices, binding),
            updatedAt: this.now().toISOString()
        };
        store.hosts[hostId] = next;
        await this.writeStore(store);
        return next;
    }
    async unbindDevice(hostId, deviceId) {
        const store = await this.readStore();
        const current = store.hosts[hostId] ?? createEmptyBindingState(hostId, this.now());
        const next = {
            hostId,
            devices: removeBinding(current.devices, deviceId),
            updatedAt: this.now().toISOString()
        };
        store.hosts[hostId] = next;
        await this.writeStore(store);
        return next;
    }
    async readStore() {
        try {
            const raw = await readFile(this.filePath, "utf8");
            const parsed = JSON.parse(raw);
            if (parsed.version !== 1 || !parsed.hosts || typeof parsed.hosts !== "object") {
                return { version: 1, hosts: {} };
            }
            return {
                version: 1,
                hosts: parsed.hosts
            };
        }
        catch (error) {
            if (error.code === "ENOENT") {
                return { version: 1, hosts: {} };
            }
            throw error;
        }
    }
    async writeStore(store) {
        await mkdir(dirname(this.filePath), { recursive: true });
        await writeFile(this.filePath, JSON.stringify(store, null, 2), "utf8");
    }
}
// TODO(security): encrypt binding store at rest once account/session model is finalized.
//# sourceMappingURL=binding_manager.js.map