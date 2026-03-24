import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

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

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderGatewayBadge(status: ConnectorStatusSnapshot["gateway"]["status"]): string {
  const map: Record<ConnectorStatusSnapshot["gateway"]["status"], string> = {
    online: "Online",
    unauthorized: "Unauthorized",
    offline: "Offline",
    error: "Error"
  };
  return map[status];
}

function renderGatewayRecoveryPhase(phase: ConnectorStatusSnapshot["gatewayRecovery"]["phase"]): string {
  const map: Record<ConnectorStatusSnapshot["gatewayRecovery"]["phase"], string> = {
    stopped: "Stopped",
    monitoring: "Monitoring",
    recovering: "Recovering",
    backoff: "Backoff",
    manual_attention: "Manual Attention"
  };
  return map[phase];
}

function renderLastEvent(event?: ConnectorEvent): string {
  if (!event) {
    return "No backend events yet.";
  }

  if (event.type === "host.status") {
    return `${event.type} (${event.status}) @ ${event.at}`;
  }

  if (event.type === "agent.runtime.status") {
    return `${event.type} agent=${event.agentId} (${event.displayStatus}) @ ${event.at}`;
  }

  return `${event.type} (${event.requestId}) @ ${event.at}`;
}

export function renderLocalStatusPage(snapshot: ConnectorDiagnosticsSnapshot): string {
  const gateway = snapshot.status.gateway;
  const gatewayRecovery = snapshot.status.gatewayRecovery;
  const latestRecovery = gatewayRecovery.recentRecoveries[0];
  const activeHost = snapshot.status.activeHost;
  const statusClass = `status-${gateway.status}`;
  const todoHtml = snapshot.status.todoBoundaries
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ClawPal Connector Diagnostics</title>
    <style>
      :root {
        --bg: #edf3f4;
        --card: #ffffff;
        --text: #24313a;
        --muted: #60717f;
        --border: #cbd9df;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "IBM Plex Sans", "Helvetica Neue", Helvetica, Arial, sans-serif;
        color: var(--text);
        background: radial-gradient(circle at top right, #d4e6ef 0%, #edf3f4 45%, #f8fbfc 100%);
      }
      main {
        max-width: 900px;
        margin: 0 auto;
        padding: 26px 18px 40px;
      }
      h1 { margin: 0 0 6px; }
      .muted { color: var(--muted); font-size: 0.92rem; }
      .card {
        margin-top: 12px;
        padding: 16px;
        border-radius: 14px;
        border: 1px solid var(--border);
        background: var(--card);
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
        gap: 12px;
      }
      .status {
        display: inline-block;
        border-radius: 999px;
        padding: 3px 10px;
        font-size: 0.82rem;
        font-weight: 700;
      }
      .status-online { background: #d9f8e2; color: #0f7d3d; }
      .status-offline { background: #ffe2df; color: #af2828; }
      .status-unauthorized { background: #ffeccc; color: #8f5f00; }
      .status-error { background: #efe5ff; color: #5734aa; }
      .status-recovering { background: #ffeccc; color: #8f5f00; }
      .status-backoff { background: #fff5cc; color: #8a6b00; }
      .status-manual_attention { background: #ffe2df; color: #af2828; }
      .status-monitoring { background: #d9f8e2; color: #0f7d3d; }
      .status-stopped { background: #dce5eb; color: #415462; }
      ul {
        margin: 8px 0 0;
        padding-left: 18px;
      }
      code {
        font-family: "IBM Plex Mono", Menlo, Monaco, monospace;
        font-size: 0.9rem;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>ClawPal Connector Diagnostics</h1>
      <p class="muted">Generated at ${escapeHtml(snapshot.generatedAt)}</p>

      <section class="card">
        <h2>Gateway</h2>
        <span class="status ${statusClass}">${renderGatewayBadge(gateway.status)}</span>
        <p>${escapeHtml(gateway.detail)}</p>
        <p class="muted">endpoint: <code>${escapeHtml(gateway.endpoint)}</code> | latency: ${gateway.latencyMs}ms</p>
        <p>
          recovery:
          <span class="status status-${escapeHtml(gatewayRecovery.phase)}">${renderGatewayRecoveryPhase(gatewayRecovery.phase)}</span>
        </p>
        <p class="muted">
          failure threshold: ${gatewayRecovery.consecutiveProbeFailures}/${gatewayRecovery.consecutiveFailureThreshold}
          |
          restart failures: ${gatewayRecovery.consecutiveRecoveryFailures}/${gatewayRecovery.maxRecoveryAttempts}
        </p>
        ${
          gatewayRecovery.nextRecoveryAllowedAt
            ? `<p class="muted">next retry at: ${escapeHtml(gatewayRecovery.nextRecoveryAllowedAt)}</p>`
            : ""
        }
        ${
          latestRecovery
            ? `<p class="muted">latest recovery: ${escapeHtml(latestRecovery.triggeredAt)} | ok=${latestRecovery.ok ? "yes" : "no"} | ${escapeHtml(latestRecovery.detail)}</p>`
            : `<p class="muted">latest recovery: none</p>`
        }
      </section>

      <div class="grid">
        <section class="card">
          <h2>Host Registry</h2>
          ${
            activeHost
              ? `<p><strong>${escapeHtml(activeHost.hostName)}</strong> (${escapeHtml(activeHost.hostId)})</p>
                 <p class="muted">user: ${escapeHtml(activeHost.userId)}</p>
                 <p class="muted">backend: <code>${escapeHtml(activeHost.backendUrl)}</code></p>`
              : `<p>No active host binding yet.</p>`
          }
        </section>

        <section class="card">
          <h2>Backend Link</h2>
          <p>transport: <code>${escapeHtml(snapshot.backend.transport)}</code></p>
          <p>connected: <strong>${snapshot.backend.connected ? "yes" : "no"}</strong></p>
          <p>sent events: <strong>${snapshot.backend.sentEvents}</strong></p>
          <p class="muted">last event: ${escapeHtml(renderLastEvent(snapshot.backend.lastEvent))}</p>
        </section>
      </div>

      <section class="card">
        <h2>Explicit TODO Boundaries</h2>
        <ul>${todoHtml}</ul>
      </section>
    </main>
  </body>
</html>`;
}

export async function startLocalWebUi(
  getSnapshot: () => ConnectorDiagnosticsSnapshot | Promise<ConnectorDiagnosticsSnapshot>,
  options: LocalWebUiOptions = {}
): Promise<LocalWebUiServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8787;

  const server = createServer((request, response) => {
    void (async () => {
      try {
        const url = request.url ?? "/";
        if (url.startsWith("/healthz")) {
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({ ok: true, ts: new Date().toISOString() }));
          return;
        }

        const snapshot = await getSnapshot();
        if (url.startsWith("/api/status")) {
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(JSON.stringify(snapshot, null, 2));
          return;
        }

        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(renderLocalStatusPage(snapshot));
      } catch (error) {
        response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        response.end(
          JSON.stringify({
            ok: false,
            error: error instanceof Error ? error.message : "Unknown diagnostics snapshot error."
          })
        );
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  const address = server.address() as AddressInfo;
  const exposedHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  const url = `http://${exposedHost}:${address.port}`;

  return {
    url,
    close: async () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      })
  };
}
