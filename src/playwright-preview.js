import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

import { PolicyError } from "./core.js";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);

export class PlaywrightPreviewAdapter {
  constructor({ previews = {}, executablePath = "/usr/bin/google-chrome", artifactRoot } = {}) {
    if (!artifactRoot || !path.isAbsolute(artifactRoot)) throw new PolicyError("QA artifact directory must be absolute", "CONFIG_REQUIRED");
    this.artifactRoot = path.resolve(artifactRoot);
    this.executablePath = executablePath;
    this.previews = new Map(Object.entries(previews));
    for (const [id, preview] of this.previews) {
      if (!preview || typeof preview.baseUrl !== "string" || typeof preview.candidateHash !== "string" || !preview.candidateHash) throw new PolicyError("QA preview must bind a candidate hash", "CONFIG_REQUIRED");
      const url = new URL(preview.baseUrl);
      if (!id || url.protocol !== "http:" || !LOCAL_HOSTS.has(url.hostname) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new PolicyError("QA previews must be fixed localhost HTTP origins", "POLICY_DENIED");
    }
  }

  async inspect({ qaPreviewId, candidateHash, routes, locales, viewports, testMode }) {
    const preview = this.previews.get(qaPreviewId);
    if (!preview) throw new PolicyError("QA preview ID is not registered", "RESOURCE_NOT_FOUND");
    if (preview.candidateHash !== candidateHash) throw new PolicyError("QA preview does not match candidate", "STALE_REVISION");
    const baseUrl = preview.baseUrl;
    if (testMode !== "read-only") throw new PolicyError("Browser QA only supports read-only mode", "POLICY_DENIED");
    if (!Array.isArray(routes) || !routes.length || routes.length > 20 || routes.some((route) => typeof route !== "string" || !/^\/[A-Za-z0-9/_-]*$/.test(route) || route.includes(".."))) throw new PolicyError("QA routes are invalid", "INVALID_INPUT");
    if (!Array.isArray(viewports) || !viewports.length || viewports.length > 4 || viewports.some(({ width, height }) => !Number.isInteger(width) || !Number.isInteger(height) || width < 320 || width > 2560 || height < 400 || height > 1600)) throw new PolicyError("QA viewports are invalid", "INVALID_INPUT");
    if (!Array.isArray(locales) || !locales.length || locales.length > 4 || locales.some((locale) => !/^[a-z]{2}(?:-[A-Z]{2})?$/.test(locale))) throw new PolicyError("QA locales are invalid", "INVALID_INPUT");
    const origin = new URL(baseUrl).origin;
    const browser = await chromium.launch({ executablePath: this.executablePath, headless: true });
    const observations = [];
    try {
      await fs.mkdir(this.artifactRoot, { recursive: true });
      for (const route of routes) for (const viewport of viewports) {
        const context = await browser.newContext({ viewport, serviceWorkers: "block", acceptDownloads: false });
        await context.route("**/*", (request) => {
          const url = new URL(request.request().url());
          return url.origin === origin && ["GET", "HEAD"].includes(request.request().method()) ? request.continue() : request.abort();
        });
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        const response = await page.goto(new URL(route, origin).href, { waitUntil: "domcontentloaded", timeout: 15_000 });
        const state = await page.evaluate(() => ({
          title: document.title.trim(),
          lang: document.documentElement.lang,
          overflow: document.documentElement.scrollWidth > window.innerWidth + 2,
          links: [...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")),
          forms: [...document.forms].map((form) => ({ controls: [...form.querySelectorAll("input,select,textarea")].filter((el) => el.type !== "hidden").map((el) => ({ labelled: Boolean(el.labels?.length || el.getAttribute("aria-label") || el.getAttribute("aria-labelledby")) })) })),
          description: Boolean(document.querySelector('meta[name="description"]')?.content),
          heading: Boolean(document.querySelector("h1")),
        }));
        const brokenLinks = [];
        const internalLinks = [...new Set(state.links.filter((link) => link && !link.startsWith("#") && !link.startsWith("mailto:") && !link.startsWith("tel:")).map((link) => new URL(link, origin)).filter((url) => url.origin === origin).map((url) => `${url.origin}${url.pathname}${url.search}`))];
        if (internalLinks.length > 30) brokenLinks.push("too many links to check");
        for (const href of internalLinks.slice(0, 30)) {
          try {
            const linked = await context.request.get(href, { maxRedirects: 0, timeout: 5000 });
            if (linked.status() >= 400 || linked.status() >= 300 && linked.status() < 400) brokenLinks.push(`${href}: HTTP ${linked.status()}`);
          } catch { brokenLinks.push(`${href}: request failed`); }
        }
        const name = `${qaPreviewId.replace(/[^A-Za-z0-9_-]/g, "_")}-${route.replace(/[^A-Za-z0-9_-]/g, "_")}-${viewport.width}x${viewport.height}.png`;
        const screenshot = path.join(this.artifactRoot, name);
        await page.screenshot({ path: screenshot, fullPage: true });
        observations.push({ route, viewport, status: response?.status() || 0, finalUrl: page.url(), state, errors, brokenLinks, screenshot });
        await context.close();
      }
    } finally { await browser.close(); }
    const all = (predicate) => observations.every(predicate);
    const checks = {
      links: { passed: all((item) => item.status === 200 && item.finalUrl.startsWith(origin) && !item.brokenLinks.length && item.state.links.every((link) => link?.startsWith("#") || link?.startsWith("/") || link?.startsWith("mailto:") || link?.startsWith("tel:") || (link?.startsWith("http") && new URL(link).origin === origin))), details: "HTTP responses and link targets" },
      locale: { passed: all((item) => locales.some((locale) => item.state.lang === locale)), details: "HTML language" },
      responsive: { passed: all((item) => !item.state.overflow && !item.errors.length), details: "Viewport overflow and page errors" },
      form: { passed: all((item) => item.state.forms.length > 0 && item.state.forms.every((form) => form.controls.length > 0 && form.controls.every((control) => control.labelled))), details: "Form controls and labels" },
      seo: { passed: all((item) => item.state.title && item.state.description && item.state.heading), details: "Title, description and H1" },
    };
    return { checks, observations };
  }
}
