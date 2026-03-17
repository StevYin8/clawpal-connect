import type { ConnectorEvent } from "../backend_client.js";
import type { ConnectorStatusSnapshot } from "../connector_runtime.js";
export interface LocalWebUiOptions {
    host?: string;
    port?: number;
}
export interface LocalWebUiServer {
    url: string;
    close: () => Promise<void>;
}
export interface ConnectorDiagnosticsSnapshot {
    generatedAt: string;
    status: ConnectorStatusSnapshot;
    backend: {
        transport: string;
        connected: boolean;
        sentEvents: number;
        lastEvent?: ConnectorEvent;
    };
}
export declare function renderLocalStatusPage(snapshot: ConnectorDiagnosticsSnapshot): string;
export declare function startLocalWebUi(getSnapshot: () => ConnectorDiagnosticsSnapshot, options?: LocalWebUiOptions): Promise<LocalWebUiServer>;
