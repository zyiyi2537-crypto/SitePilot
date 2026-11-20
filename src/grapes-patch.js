const TEXT_FIELDS = new Set(["title", "description", "eyebrow", "ctaLabel", "itemTitle", "itemDescription"]);
const PROP_KEYS = Object.freeze({
  title: ["title", "heading", "headline", "label"],
  description: ["description", "subtitle", "body", "summary"],
  eyebrow: ["eyebrow", "overline"],
  ctaLabel: ["ctaLabel", "buttonLabel", "cta"],
});

function reject(message, code = "SCHEMA_REJECTED") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function safeText(value, field) {
  if (typeof value !== "string") reject(`Canvas field ${field} must be text`);
  const text = value.trim();
  if (text.length > 500) reject(`Canvas field ${field} is too long`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text) || /^javascript:/i.test(text) || /<\/?[a-z][^>]*>/i.test(text)) reject(`Canvas field ${field} contains unsafe text`);
  return text;
}

function propKey(props, field) {
  return PROP_KEYS[field].find((key) => (typeof props[key] === "string" || typeof props[key] === "number") && String(props[key]).trim()) || PROP_KEYS[field][0];
}

function valuesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeFields(fields = {}) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) reject("Canvas fields must be an object");
  const normalized = {};
  for (const [field, value] of Object.entries(fields)) {
    if (!TEXT_FIELDS.has(field)) reject(`Canvas field is not editable: ${field}`);
    if (field.startsWith("item")) {
      if (!value || typeof value !== "object") reject(`Canvas field ${field} must be indexed text`);
      const entries = Object.entries(value);
      normalized[field] = Object.fromEntries(entries.map(([index, item]) => {
        const parsed = Number(index);
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 99) reject(`Canvas field ${field} has an invalid item index`);
        return [parsed, safeText(item, field)];
      }));
    } else {
      normalized[field] = safeText(value, field);
    }
  }
  return normalized;
}

/**
 * Convert the safe, marker-based output of the visual editor into SitePilot
 * design operations. This is deliberately independent of GrapesJS so it can
 * be tested and reused by another canvas implementation.
 */
export function createCanvasPatch({ page, components, expectedDesignHash, feedback = "Visual editor update", actor = "customer" } = {}) {
  if (!page || typeof page !== "object" || !Array.isArray(page.components)) reject("A design page is required", "INVALID_INPUT");
  if (!Array.isArray(components) || components.length !== page.components.length) reject("Visual editor must retain every approved component");
  if (typeof expectedDesignHash !== "string" || !/^[a-f0-9]{64}$/i.test(expectedDesignHash)) reject("A valid design hash is required", "STALE_REVISION");
  const expectedIds = new Set(page.components.map((component) => component.instanceId));
  const seen = new Set();
  const operations = [];
  const orderedIds = [];
  for (const edited of components) {
    if (!edited || typeof edited !== "object" || typeof edited.instanceId !== "string" || !expectedIds.has(edited.instanceId)) reject("Visual editor component is outside the approved page plan");
    if (seen.has(edited.instanceId)) reject("Visual editor contains duplicate component IDs");
    seen.add(edited.instanceId);
    orderedIds.push(edited.instanceId);
    const original = page.components.find((component) => component.instanceId === edited.instanceId);
    const fields = normalizeFields(edited.fields);
    const nextProps = structuredClone(original.props || {});
    const itemTitles = fields.itemTitle || {};
    const itemDescriptions = fields.itemDescription || {};
    const itemIndexes = [...new Set([...Object.keys(itemTitles), ...Object.keys(itemDescriptions)])].map(Number);
    if (itemIndexes.length) {
      const items = nextProps.items?.length ? nextProps.items : structuredClone(edited.baseItems || []);
      for (const i of itemIndexes) {
        if (typeof items[i] === "string" && itemDescriptions[i] === undefined) {
          items[i] = itemTitles[i];
          continue;
        }
        if (typeof items[i] === "string") items[i] = { title: items[i] };
        const item = items[i];
        if (!item || typeof item !== "object" || Array.isArray(item)) reject("Visual editor item is outside the component schema");
        for (const [changes, aliases] of [[itemTitles, ["title", "name", "label", "question"]], [itemDescriptions, ["description", "body", "answer", "summary"]]]) {
          if (changes[i] !== undefined) item[aliases.find(key => typeof item[key] === "string" && item[key].trim()) || aliases[0]] = changes[i];
        }
      }
      nextProps.items = items;
    }
    for (const field of ["title", "description", "eyebrow", "ctaLabel"]) {
      if (fields[field] !== undefined) nextProps[propKey(original.props || {}, field)] = fields[field];
    }
    if (!valuesEqual(nextProps, original.props || {})) operations.push({ op: "replace_props", page: page.page, componentId: edited.instanceId, props: nextProps });
  }
  const simulatedOrder = page.components.map((component) => component.instanceId);
  for (const [index, instanceId] of orderedIds.entries()) {
    const fromIndex = simulatedOrder.indexOf(instanceId);
    if (fromIndex !== index) {
      operations.push({ op: "move", page: page.page, componentId: instanceId, toIndex: index });
      simulatedOrder.splice(fromIndex, 1);
      simulatedOrder.splice(index, 0, instanceId);
    }
  }
  if (operations.length > 20) reject("Visual editor change exceeds the twenty-operation patch limit");
  return {
    expectedDesignHash,
    feedback: String(feedback || "Visual editor update").slice(0, 2000),
    actor: String(actor || "customer").slice(0, 80),
    operations,
  };
}

export function extractCanvasComponents(html, { documentFactory = globalThis.DOMParser } = {}) {
  if (typeof html !== "string" || html.length > 2_000_000) reject("Visual editor HTML is invalid", "SCHEMA_REJECTED");
  if (typeof documentFactory !== "function") reject("A browser DOM parser is required", "CONFIG_REQUIRED");
  const document = new documentFactory().parseFromString(html, "text/html");
  const main = document.querySelector("main");
  if (!main) reject("Visual editor removed the page main element");
  const result = [];
  for (const element of main.querySelectorAll(":scope > [data-instance]")) {
    const instanceId = element.getAttribute("data-instance");
    if (!instanceId || result.some((item) => item.instanceId === instanceId)) reject("Visual editor contains duplicate component markers");
    const fields = {};
    const itemFields = new Map();
    const baseItems = [];
    for (const fieldElement of element.querySelectorAll("[data-sp-field]")) {
      const field = fieldElement.getAttribute("data-sp-field");
      if (!TEXT_FIELDS.has(field)) reject("Unknown preview field marker");
      const itemIndex = fieldElement.closest("[data-sp-item-index]")?.getAttribute("data-sp-item-index");
      if (field === "itemTitle" || field === "itemDescription") {
        const index = Number(itemIndex);
        if (itemIndex == null || !Number.isInteger(index) || index < 0 || index > 99) reject("Visual editor item marker is invalid");
        if (!itemFields.has(field)) itemFields.set(field, []);
        itemFields.get(field)[index] = fieldElement.textContent || "";
        baseItems[index] ||= {};
        baseItems[index][field === "itemTitle" ? "title" : "description"] = fieldElement.textContent || "";
      } else {
        fields[field] = fieldElement.textContent || "";
      }
    }
    for (const [field, values] of itemFields) fields[field] = values;
    result.push({ instanceId, fields, baseItems });
  }
  return result;
}
