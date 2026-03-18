import { createServer } from "node:http";
function escapeHtml(input) {
    return input
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}
function renderGatewayBadge(status) {
    const map = {
        online: "Online",
        unauthorized: "Unauthorized",
        offline: "Offline",
        error: "Error"
    };
    return map[status];
}
function renderLastEvent(event) {
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
export function renderLocalStatusPage(snapshot) {
    const gateway = snapshot.status.gateway;
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
      </section>

      <div class="grid">
        <section class="card">
          <h2>Host Registry</h2>
          ${activeHost
        ? `<p><strong>${escapeHtml(activeHost.hostName)}</strong> (${escapeHtml(activeHost.hostId)})</p>
                 <p class="muted">user: ${escapeHtml(activeHost.userId)}</p>
                 <p class="muted">backend: <code>${escapeHtml(activeHost.backendUrl)}</code></p>`
        : `<p>No active host binding yet.</p>`}
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
export async function startLocalWebUi(getSnapshot, options = {}) {
    const host = options.host ?? "127.0.0.1";
    const port = options.port ?? 8787;
    const server = createServer((request, response) => {
        const url = request.url ?? "/";
        if (url.startsWith("/api/status")) {
            response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            response.end(JSON.stringify(getSnapshot(), null, 2));
            return;
        }
        if (url.startsWith("/healthz")) {
            response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            response.end(JSON.stringify({ ok: true, ts: new Date().toISOString() }));
            return;
        }
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(renderLocalStatusPage(getSnapshot()));
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => resolve());
    });
    const address = server.address();
    const exposedHost = host === "0.0.0.0" ? "127.0.0.1" : host;
    const url = `http://${exposedHost}:${address.port}`;
    return {
        url,
        close: async () => new Promise((resolve, reject) => {
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
//# sourceMappingURL=local_web_ui.js.map