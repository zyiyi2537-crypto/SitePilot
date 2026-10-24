import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";

import { PolicyError } from "./core.js";
import { renderDesignPreviewDocument, renderDesignPreviewStylesheet } from "./design-preview.js";

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
}

function renderBoundDesign(route, design) {
  if (!design?.pageTree?.length) return null;
  const page = design.pageTree.find((item) => item.page === route.page && item.route === route.route);
  if (!page || !Array.isArray(route.components) || !Array.isArray(page.components) || page.components.length !== route.components.length) return null;
  const planned = new Map(route.components.map((component) => [component.registryId, component]));
  if (page.components.some((component) => {
    const source = planned.get(component.registryId);
    return !source || (component.name && source.name !== component.name);
  })) return null;
  const boundDesign = {
    ...design,
    pageTree: design.pageTree.map((item) => item.page === route.page && item.route === route.route
      ? {
          ...item,
          components: item.components.map((component) => ({
            ...component,
            name: planned.get(component.registryId).name,
          })),
        }
      : item),
  };
  const document = renderDesignPreviewDocument({
    designDraft: boundDesign,
    page: route.page,
    locale: design.previewContext?.locale || "zh-CN",
    industry: design.previewContext?.industry,
    audience: design.previewContext?.audience,
    primaryConversion: design.previewContext?.primaryConversion,
    businessGoal: design.previewContext?.businessGoal,
  });
  if (!document) return "";
  const stylesheet = renderDesignPreviewStylesheet({ designDraft: design });
  const styleHref = `data:text/css;charset=utf-8,${encodeURIComponent(stylesheet)}`;
  return document
    .replace("__SITEPILOT_PREVIEW_STYLESHEET__", styleHref)
    .replace("<body>", `<body data-sitepilot-design-hash="${escapeHtml(design.designHash)}" data-sitepilot-design-id="${escapeHtml(design.id)}">`);
}

function renderPage(route, design = null) {
  if (design) return renderBoundDesign(route, design);
  const designPage = design?.pageTree?.find((page) => page.page === route.page && page.route === route.route);
  const componentById = new Map((designPage?.components || []).map((component) => [component.registryId, component]));
  const components = route.components.map((component) => {
    const designComponent = componentById.get(component.registryId);
    const props = designComponent?.props && Object.keys(designComponent.props).length ? `<details><summary>Design properties</summary><pre>${escapeHtml(JSON.stringify(designComponent.props, null, 2))}</pre></details>` : "";
    return `<section data-component="${escapeHtml(component.name)}" data-design-instance="${escapeHtml(designComponent?.instanceId || "")}"><h2>${escapeHtml(component.name)}</h2><p>Candidate component preview. Source: <code>${escapeHtml(component.source.repository)}@${escapeHtml(component.source.commit.slice(0, 12))}:${escapeHtml(component.source.path)}</code></p>${props}${component.name === "ContactForm" ? '<form><label>Email <input type="email" required></label><button type="submit">Send inquiry</button></form>' : ""}</section>`;
  }).join("");
  const designMeta = design ? `<p data-sitepilot-design-hash="${escapeHtml(design.designHash)}">Design revision: <code>${escapeHtml(design.id)}</code></p>` : "<p>Page plan preview; no design revision attached.</p>";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(route.page)} | SitePilot preview</title><style>body{font:16px system-ui;max-width:960px;margin:40px auto;padding:0 20px;color:#18212b}section{border:1px solid #d0d7de;padding:24px;margin:20px 0}code{color:#536273;overflow-wrap:anywhere}a{color:#0969da}input,button{font:inherit;padding:8px;margin:8px 0}label{display:grid;max-width:420px}details{margin-top:12px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f6f8;padding:10px}</style></head><body><p><a href="/">SitePilot preview</a></p><h1>${escapeHtml(route.page)}</h1><p>Candidate page structure, not a production release.</p>${designMeta}${components}</body></html>`;
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
      const html = renderPage(route, this.plan.design);
      if (!html) {
        response.writeHead(409, { "content-type": "text/plain; charset=utf-8" });
        return response.end("Candidate route does not match its bound design revision");
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src data: 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'; frame-ancestors 'none'" });
      response.end(html);
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
