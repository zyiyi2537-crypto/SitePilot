import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";

import { PolicyError } from "./core.js";

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
}

function renderPage(route) {
  const components = route.components.map((component) => `<section data-component="${escapeHtml(component.name)}"><h2>${escapeHtml(component.name)}</h2><p>Candidate component preview. Source: <code>${escapeHtml(component.source.repository)}@${escapeHtml(component.source.commit.slice(0, 12))}:${escapeHtml(component.source.path)}</code></p>${component.name === "ContactForm" ? '<form><label>Email <input type="email" required></label><button type="submit">Send inquiry</button></form>' : ""}</section>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(route.page)} | SitePilot preview</title><style>body{font:16px system-ui;max-width:960px;margin:40px auto;padding:0 20px;color:#18212b}section{border:1px solid #d0d7de;padding:24px;margin:20px 0}code{color:#536273;overflow-wrap:anywhere}a{color:#0969da}input,button{font:inherit;padding:8px;margin:8px 0}label{display:grid;max-width:420px}</style></head><body><p><a href="/">SitePilot preview</a></p><h1>${escapeHtml(route.page)}</h1><p>Candidate page structure, not a production release.</p>${components}</body></html>`;
}

export class LocalPreviewServer {
  constructor({ plan, host = "127.0.0.1", port = 0 } = {}) {
    if (!plan || !Array.isArray(plan.routes)) throw new PolicyError("A page plan is required", "INVALID_INPUT");
    if (host !== "127.0.0.1" && host !== "localhost") throw new PolicyError("Preview server must bind to localhost", "POLICY_DENIED");
    this.plan = plan;
    this.host = host;
    this.port = port;
    this.server = null;
  }

  async listen() {
    if (this.server) return this.address();
    const routes = new Map(this.plan.routes.map((route) => [route.route, route]));
    this.server = http.createServer((request, response) => {
      const pathname = new URL(request.url || "/", `http://${this.host}`).pathname;
      if (request.method !== "GET") {
        response.writeHead(405, { allow: "GET" });
        return response.end();
      }
      if (pathname === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        return response.end(JSON.stringify({ status: "ok", preview: true, writesAllowed: false }));
      }
      const route = routes.get(pathname);
      if (!route) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        return response.end("Preview route not found");
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" });
      response.end(renderPage(route));
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, resolve);
    });
    return this.address();
  }

  address() {
    const value = this.server?.address();
    return typeof value === "object" && value ? { host: this.host, port: value.port } : null;
  }

  async close() {
    if (!this.server) return;
    await new Promise((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
    this.server = null;
  }
}

export async function loadPreviewManifest(worktreeRoot) {
  if (!worktreeRoot || !path.isAbsolute(worktreeRoot)) throw new PolicyError("Preview worktree root must be absolute", "POLICY_DENIED");
  const manifestPath = path.resolve(worktreeRoot, "src/generated/sitepilot-manifest.json");
  const root = path.resolve(worktreeRoot);
  if (!manifestPath.startsWith(`${root}${path.sep}`)) throw new PolicyError("Preview manifest escapes worktree", "POLICY_DENIED");
  return JSON.parse(await fs.readFile(manifestPath, "utf8"));
}
