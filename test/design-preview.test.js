import test from "node:test";
import assert from "node:assert/strict";

import { SitePilotStore } from "../src/core.js";
import { createServer } from "../src/server.js";
import { renderDesignPreviewDocument, renderDesignPreviewStylesheet } from "../src/design-preview.js";

function draft(overrides = {}) {
  return {
    id: "design_current",
    designHash: "a".repeat(64),
    designTokens: { color: { primary: "#0b6e4f", surface: "#ffffff", text: "#18212b" }, spacing: { section: 72 }, typography: { body: "system-ui", heading: "system-ui" } },
    pageTree: [
      { page: "home", route: "/", components: [
        { instanceId: "hero_1", name: "Hero", props: { title: "Welcome <script>alert(1)</script>", description: "Evidence-led overview" } },
        { instanceId: "products_1", name: "ProductGrid", props: { items: [{ title: "Product A", description: "A precise description" }] } },
      ] },
      { page: "about", route: "/about", components: [{ instanceId: "about_1", name: "ContentGrid", props: { title: "About us" } }] },
    ],
    ...overrides,
  };
}

test("design preview renders the selected page with bounded tokens and mapped components", () => {
  const html = renderDesignPreviewDocument({ designDraft: draft(), page: "home", locale: "en", audience: "buyers" });
  const css = renderDesignPreviewStylesheet({ designDraft: draft() });
  assert.match(html, /<h1>Welcome &lt;script&gt;alert\(1\)&lt;\/script&gt;<\/h1>/);
  assert.match(html, /Product A/);
  assert.match(html, /data-instance="hero_1"/);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /style-src data:/);
  assert.match(html, /__SITEPILOT_PREVIEW_STYLESHEET__/);
  assert.match(css, /color:#0b6e4f/);
  assert.doesNotMatch(html, /<script(?:\s|>)/i);
});

test("design preview renders page navigation and uses only validated CSS token values", () => {
  const value = draft({
    designTokens: { color: { primary: "red; background:url(https://bad.test)", surface: "#ffffff", text: "#18212b" }, spacing: { section: 9999 }, typography: { body: "system-ui; background:url(x)", heading: "system-ui" } },
  });
  const html = renderDesignPreviewDocument({ designDraft: value, page: "about", locale: "zh-CN" });
  const css = renderDesignPreviewStylesheet({ designDraft: value });
  assert.match(html, /aria-current="page">about/);
  assert.match(html, /class="preview-section"/);
  assert.doesNotMatch(css, /background:url\(/i);
  assert.match(css, /padding:240px 0/);
});

test("design preview safely renders customer-controlled item text and stays non-submitting", () => {
  const value = draft({ pageTree: [{ page: "contact", route: "/contact", components: [
    { instanceId: "contact_1", name: "ContactForm", props: { title: "Contact", ctaLabel: "<img src=x onerror=alert(1)>", items: [{ question: "<svg onload=alert(1)>", answer: "text" }] } },
  ] }] });
  const html = renderDesignPreviewDocument({ designDraft: value, page: "contact", locale: "en" });
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img|<svg|<form/i);
  assert.match(html, /form-action 'none'/);
});

test("invalid or empty drafts produce no preview document", () => {
  assert.equal(renderDesignPreviewDocument(), "");
  assert.equal(renderDesignPreviewDocument({ designDraft: { pageTree: [] } }), "");
});

test("Studio serves the design renderer as a same-origin module and permits only blob frames", async () => {
  const server = createServer(new SitePilotStore());
  const get = (url) => new Promise((resolve, reject) => {
    const req = { method: "GET", url, headers: {} };
    const res = {
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(body) { resolve({ status: this.status, headers: this.headers, body: String(body) }); },
    };
    try { server.emit("request", req, res); } catch (error) { reject(error); }
  });
  const [studio, renderer] = await Promise.all([get("/studio"), get("/design-preview.js")]);
  assert.equal(studio.status, 200);
  assert.match(studio.body, /type="module" src="\/studio\.js"/);
  assert.match(studio.headers["content-security-policy"], /frame-src blob:/);
  assert.match(studio.headers["content-security-policy"], /style-src 'self' data:/);
  assert.equal(renderer.status, 200);
  assert.match(renderer.headers["content-type"], /javascript/);
  assert.match(renderer.body, /renderDesignPreviewDocument/);
});
