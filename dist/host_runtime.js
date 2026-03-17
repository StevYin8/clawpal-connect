import { BindingManager } from "./binding_manager.js";
import { GatewayDetector } from "./gateway_detector.js";
import { MockPairingProvider, PairingClient } from "./pairing_client.js";
import { QrPresenter } from "./qr_presenter.js";
export class HostRuntime {
    hostId;
    now;
    gatewayDetector;
    pairingClient;
    qrPresenter;
    bindingManager;
    constructor(options = {}) {
        this.hostId = options.hostId ?? "local-host";
        this.now = options.now ?? (() => new Date());
        this.gatewayDetector =
            options.gatewayDetector ??
                new GatewayDetector({
                    baseUrl: options.gatewayBaseUrl ?? "http://127.0.0.1:3456",
                    ...(options.gatewayToken ? { token: options.gatewayToken } : {}),
                    ...(options.gatewayTimeoutMs !== undefined ? { timeoutMs: options.gatewayTimeoutMs } : {}),
                    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
                });
        const pairingProvider = options.pairingProvider ??
            new MockPairingProvider({
                now: this.now,
                ...(options.pairingTtlMinutes !== undefined
                    ? { ttlMinutes: options.pairingTtlMinutes }
                    : {})
            });
        this.pairingClient = options.pairingClient ?? new PairingClient(pairingProvider);
        this.qrPresenter = options.qrPresenter ?? new QrPresenter();
        this.bindingManager =
            options.bindingManager ??
                new BindingManager({
                    now: this.now,
                    ...(options.bindingFilePath ? { filePath: options.bindingFilePath } : {})
                });
    }
    async createSnapshot() {
        const gateway = await this.gatewayDetector.detect();
        const pairingSession = await this.pairingClient.createSession({
            hostId: this.hostId,
            gatewayStatus: gateway.status
        });
        const qr = await this.qrPresenter.present(pairingSession.qrPayload);
        const bindings = await this.bindingManager.loadState(this.hostId);
        return {
            hostId: this.hostId,
            generatedAt: this.now().toISOString(),
            gateway,
            pairingSession,
            qr,
            bindings,
            todoBoundaries: this.listTodoBoundaries()
        };
    }
    startHeartbeat(intervalMs = 30_000, onTick) {
        const timer = setInterval(() => {
            onTick?.({
                hostId: this.hostId,
                at: this.now().toISOString()
            });
        }, intervalMs);
        return () => {
            clearInterval(timer);
        };
    }
    listTodoBoundaries() {
        return [
            "Cloud pairing API is not implemented in this repository yet.",
            "Pair redemption, revocation, and device trust persistence are mock-only.",
            "Runtime heartbeat is local-only and not reported to cloud services."
        ];
    }
}
//# sourceMappingURL=host_runtime.js.map