const DEFAULT_TOKENS = Object.freeze({
  color: Object.freeze({ primary: "#155eef", surface: "#ffffff", text: "#18212b" }),
  spacing: Object.freeze({ section: 64 }),
  typography: Object.freeze({ body: "system-ui", heading: "system-ui" }),
});

const KNOWN_LOCALES = new Set(["zh-CN", "en", "en-US", "ja", "de", "fr"]);

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
}

function textValue(value, fallback = "") {
  return (typeof value === "string" || typeof value === "number") && String(value).trim()
    ? String(value).trim().slice(0, 500)
    : fallback;
}

function firstText(props, keys, fallback) {
  for (const key of keys) {
    const value = textValue(props?.[key]);
    if (value) return value;
  }
  return fallback;
}

function safeTokens(value = {}) {
  const color = {};
  for (const key of ["primary", "surface", "text"]) {
    color[key] = /^#[0-9a-f]{6}$/i.test(value.color?.[key] || "") ? value.color[key] : DEFAULT_TOKENS.color[key];
  }
  const section = Number(value.spacing?.section);
  const heading = textValue(value.typography?.heading);
  const body = textValue(value.typography?.body);
  const safeFont = (font) => {
    const names = font.split(",").map((name) => name.trim().replace(/["']/g, "")).filter((name) => /^[A-Za-z0-9 _-]{1,60}$/.test(name));
    return names.length ? names.map((name) => `"${name}"`).join(",") : "system-ui";
  };
  return {
    color,
    spacing: { section: Number.isFinite(section) ? Math.min(240, Math.max(16, section)) : DEFAULT_TOKENS.spacing.section },
    typography: { heading: safeFont(heading), body: safeFont(body) },
  };
}

function renderItems(items, locale, defaults) {
  const values = Array.isArray(items) ? items.slice(0, 6) : [];
  const normalized = values.map((item) => {
    if (typeof item === "string") return { title: textValue(item), description: "" };
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const title = firstText(item, ["title", "name", "label", "question"], "");
    const description = firstText(item, ["description", "body", "answer", "summary"], "");
    return title || description ? { title: title || description, description: title ? description : "" } : null;
  }).filter(Boolean);
  return normalized.length ? normalized : defaults;
}

function renderCards(items) {
  return `<div class="preview-card-grid">${items.map((item) => `<article class="preview-card"><h3>${escapeHtml(item.title)}</h3>${item.description ? `<p>${escapeHtml(item.description)}</p>` : ""}</article>`).join("")}</div>`;
}

function renderComponent(component, locale, context) {
  const props = component.props || {};
  const name = String(component.name || "Component");
  const lower = name.toLowerCase().replace(/[^a-z]/g, "");
  const zh = locale === "zh";
  const marker = `data-component="${escapeHtml(name)}" data-instance="${escapeHtml(component.instanceId || "")}"`;
  const heading = (fallback) => escapeHtml(firstText(props, ["title", "heading", "headline", "label"], fallback));
  const description = (fallback) => escapeHtml(firstText(props, ["description", "subtitle", "body", "summary"], fallback));

  if (["hero", "herobanner", "masthead"].includes(lower)) {
    return `<section class="preview-hero" ${marker}><p class="preview-eyebrow">${escapeHtml(firstText(props, ["eyebrow", "overline"], zh ? "品牌介绍" : "ABOUT THE BRAND"))}</p><h1>${heading(zh ? `${context.audience || "理想客户"}，从这里开始` : `A better starting point for ${context.audience || "your next decision"}`)}</h1><p class="preview-lead">${description(context.businessGoal || (zh ? "围绕清晰的业务目标，呈现品牌、产品与可信信息。" : "A clear introduction to your brand, offer, and the value you bring."))}</p><span class="preview-button">${escapeHtml(firstText(props, ["ctaLabel", "buttonLabel", "cta"], context.primaryConversion || (zh ? "了解更多" : "Learn more")))}</span></section>`;
  }

  if (["productgrid", "featuregrid", "casegrid", "contentgrid"].includes(lower)) {
    const fallbackTitle = lower === "productgrid" ? (zh ? "产品与服务" : "Products and services") : lower === "casegrid" ? (zh ? "客户案例" : "Selected work") : lower === "featuregrid" ? (zh ? "为你创造的价值" : "Built around your needs") : (zh ? "深入了解" : "Explore more");
    const fallbackItems = (zh ? ["核心方案", "专业能力", "服务支持"] : ["Core offering", "Expertise", "Ongoing support"]).map((title) => ({ title, description: zh ? "具体内容待客户确认" : "Details pending customer approval" }));
    return `<section class="preview-section" ${marker}><div class="preview-section-heading"><p class="preview-eyebrow">${escapeHtml(zh ? "为你准备" : "WHAT WE OFFER")}</p><h2>${heading(fallbackTitle)}</h2><p>${description(zh ? "突出最重要的服务内容与实际价值。" : "A focused view of the services and value that matter most.")}</p></div>${renderCards(renderItems(props.items, locale, fallbackItems))}</section>`;
  }

  if (lower === "pricing") {
    const items = renderItems(props.items, locale, (zh ? ["基础方案", "成长方案", "企业方案"] : ["Starter", "Growth", "Enterprise"]).map((title) => ({ title, description: zh ? "价格与方案内容待确认" : "Pricing and plan details pending approval" })));
    return `<section class="preview-section" ${marker}><div class="preview-section-heading"><p class="preview-eyebrow">${escapeHtml(zh ? "合作方式" : "WAYS TO WORK TOGETHER")}</p><h2>${heading(zh ? "选择适合你的方案" : "Choose the right plan")}</h2></div>${renderCards(items)}</section>`;
  }

  if (lower === "faq") {
    const items = renderItems(props.items, locale, [{ title: zh ? "常见问题待确认" : "Questions to be confirmed", description: zh ? "客户常见问题与答案将在内容确认后补充。" : "Customer questions and approved answers will be added after review." }]);
    return `<section class="preview-section preview-faq" ${marker}><div class="preview-section-heading"><p class="preview-eyebrow">FAQ</p><h2>${heading(zh ? "你可能想了解" : "Frequently asked questions")}</h2></div>${items.map((item) => `<article class="preview-faq-item"><h3>${escapeHtml(item.title)}</h3>${item.description ? `<p>${escapeHtml(item.description)}</p>` : ""}</article>`).join("")}</section>`;
  }

  if (["technicalproof", "proof", "trustbar"].includes(lower)) {
    const items = renderItems(props.items, locale, (zh ? ["技术能力", "质量标准", "客户支持"] : ["Technical capability", "Quality standards", "Customer support"]).map((title) => ({ title, description: zh ? "证据与数据待核实" : "Evidence and supporting data pending review" })));
    return `<section class="preview-section preview-proof" ${marker}><div class="preview-section-heading"><p class="preview-eyebrow">${escapeHtml(zh ? "可信依据" : "THE PROOF")}</p><h2>${heading(zh ? "以可核实的实力建立信任" : "Proof that earns trust")}</h2></div>${renderCards(items)}</section>`;
  }

  if (["contactform", "contact", "inquiry"].includes(lower)) {
    return `<section class="preview-section preview-contact" id="contact" ${marker}><div class="preview-section-heading"><p class="preview-eyebrow">${escapeHtml(zh ? "下一步" : "NEXT STEP")}</p><h2>${heading(zh ? "联系我们" : "Talk with our team")}</h2><p>${description(zh ? "询盘表单内容待确认；此为不可提交的设计预览。" : "The inquiry form is a non-submitting design preview; content is pending approval.")}</p></div><div class="preview-form"><label>${escapeHtml(zh ? "姓名" : "Name")}<span></span></label><label>${escapeHtml(zh ? "工作邮箱" : "Work email")}<span></span></label><label>${escapeHtml(zh ? "需求说明" : "How can we help?")}<span class="preview-form-message"></span></label><span class="preview-button">${escapeHtml(firstText(props, ["ctaLabel", "buttonLabel"], zh ? "提交前待配置" : "Submit action pending"))}</span></div></section>`;
  }

  if (["cta", "calltoaction"].includes(lower)) {
    return `<section class="preview-cta" ${marker}><div><p class="preview-eyebrow">${escapeHtml(zh ? "准备开始了吗" : "READY WHEN YOU ARE")}</p><h2>${heading(zh ? "一起规划下一步" : "Let's plan the next step")}</h2><p>${description(zh ? "以清晰的行动引导客户联系或了解更多。" : "Give visitors a clear next step to continue the conversation.")}</p></div><span class="preview-button">${escapeHtml(firstText(props, ["ctaLabel", "buttonLabel", "cta"], context.primaryConversion || (zh ? "联系我们" : "Contact us")))}</span></section>`;
  }

  return `<section class="preview-section" ${marker}><div class="preview-section-heading"><p class="preview-eyebrow">${escapeHtml(zh ? "页面内容" : "PAGE CONTENT")}</p><h2>${heading(zh ? name : name.replace(/([a-z])([A-Z])/g, "$1 $2"))}</h2><p>${description(zh ? "此区块的内容与细节待客户确认。" : "Content and details for this section are pending customer approval.")}</p></div></section>`;
}

export function renderDesignPreviewStylesheet({ designDraft } = {}) {
  const tokens = safeTokens(designDraft?.designTokens);
  return `*{box-sizing:border-box}body{margin:0;background:#f6f8f6;color:${tokens.color.text};font-family:${tokens.typography.body},system-ui,sans-serif;font-size:16px;line-height:1.55}.preview-nav{height:72px;padding:0 clamp(20px,6vw,80px);display:flex;align-items:center;justify-content:space-between;background:${tokens.color.surface};border-bottom:1px solid #e2e8e3}.preview-brand{font-size:15px;font-weight:750}.preview-links{display:flex;gap:22px;color:#53645a;font-size:13px}.preview-links span{white-space:nowrap}.preview-links [aria-current=page]{color:${tokens.color.primary};font-weight:700}.preview-main{max-width:1120px;margin:0 auto;padding:0 28px}.preview-hero{margin:36px 0;padding:clamp(34px,7vw,82px);background:${tokens.color.surface};border:1px solid #e2e8e3;border-radius:8px}.preview-eyebrow{text-transform:uppercase;font-size:11px;letter-spacing:0;color:${tokens.color.primary};font-weight:750;margin:0 0 12px}.preview-hero h1{max-width:760px;font-family:${tokens.typography.heading},system-ui,sans-serif;font-size:52px;line-height:1.12;margin:0 0 18px}.preview-lead{font-size:18px;color:#56655d;max-width:680px;margin:0 0 26px}.preview-button{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 18px;border-radius:4px;background:${tokens.color.primary};color:white;font-weight:700;font-size:14px}.preview-section{padding:${tokens.spacing.section}px 0;border-bottom:1px solid #e0e7e2}.preview-section-heading{max-width:700px;margin-bottom:24px}.preview-section-heading h2,.preview-cta h2{font-family:${tokens.typography.heading},system-ui,sans-serif;font-size:30px;line-height:1.2;margin:0 0 12px}.preview-section-heading>p:last-child,.preview-cta>div>p:last-child{color:#64736a;margin:0}.preview-card-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.preview-card{background:${tokens.color.surface};border:1px solid #e0e7e2;border-radius:6px;padding:20px;min-height:130px}.preview-card h3,.preview-faq-item h3{font-size:16px;margin:0 0 8px}.preview-card p,.preview-faq-item p{color:#64736a;font-size:14px;margin:0}.preview-proof .preview-card{border-top:3px solid ${tokens.color.primary}}.preview-faq-item{padding:18px 0;border-top:1px solid #e0e7e2}.preview-contact{display:grid;grid-template-columns:1fr 1fr;gap:32px;align-items:start}.preview-form{display:grid;gap:12px;background:${tokens.color.surface};padding:20px;border:1px solid #e0e7e2;border-radius:6px}.preview-form label{font-size:12px;color:#607067;display:grid;gap:6px}.preview-form label span{height:40px;border:1px solid #ccd7cf;border-radius:4px;background:white}.preview-form label .preview-form-message{height:88px}.preview-cta{margin:48px 0;padding:32px;display:flex;align-items:center;justify-content:space-between;gap:20px;background:${tokens.color.surface};border:1px solid #e0e7e2;border-radius:8px}.preview-cta h2{margin-bottom:8px}.preview-cta>div>p:last-child{margin:0}.preview-footer{padding:28px 0 36px;color:#718077;font-size:12px}@media(max-width:720px){.preview-nav{height:60px;padding:0 18px}.preview-links{gap:10px;max-width:55%;overflow:hidden;font-size:11px}.preview-main{padding:0 18px}.preview-hero{margin:18px 0;padding:32px 24px}.preview-hero h1{font-size:36px}.preview-lead{font-size:16px}.preview-section{padding:44px 0}.preview-section-heading h2,.preview-cta h2{font-size:25px}.preview-card-grid{grid-template-columns:1fr}.preview-card{min-height:0}.preview-contact{grid-template-columns:1fr;gap:18px}.preview-cta{margin:30px 0;padding:24px;align-items:flex-start;flex-direction:column}}`;
}

export function renderDesignPreviewDocument({ designDraft, page, locale = "zh-CN", industry = "", audience = "", primaryConversion = "", businessGoal = "" } = {}) {
  if (!designDraft || !Array.isArray(designDraft.pageTree) || designDraft.pageTree.length === 0) return "";
  const selected = designDraft.pageTree.find((item) => item.page === page) || designDraft.pageTree[0];
  const lang = KNOWN_LOCALES.has(locale) ? locale : "zh-CN";
  const language = lang.toLowerCase().startsWith("zh") ? "zh" : "en";
  const pages = designDraft.pageTree;
  const nav = pages.map((item) => `<span${item.page === selected.page ? ' aria-current="page"' : ""}>${escapeHtml(item.page)}</span>`).join("");
  const components = selected.components.map((component) => renderComponent(component, language, { industry, audience, primaryConversion, businessGoal })).join("");
  const title = language === "zh" ? "网站设计预览" : "Website design preview";
  const brand = language === "zh" ? "品牌名称待确认" : "Brand name pending";
  const disclaimer = language === "zh" ? "方向草稿 · 内容与事实待客户审核" : "Direction draft · content and claims await customer review";
  return `<!doctype html><html lang="${escapeHtml(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src data:; img-src data:; form-action 'none'; base-uri 'none'"><link rel="stylesheet" href="__SITEPILOT_PREVIEW_STYLESHEET__"><title>${escapeHtml(title)} · ${escapeHtml(selected.page)}</title></head><body><header class="preview-nav"><strong class="preview-brand">${escapeHtml(brand)}</strong><nav class="preview-links" aria-label="${escapeHtml(language === "zh" ? "页面导航" : "Page navigation")}">${nav}</nav></header><main class="preview-main"><p class="preview-eyebrow">${escapeHtml(disclaimer)}</p>${components}<footer class="preview-footer">${escapeHtml(industry || (language === "zh" ? "网站策略草稿" : "Website strategy draft"))} · ${escapeHtml(selected.route)}</footer></main></body></html>`;
}
