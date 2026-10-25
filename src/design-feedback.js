const MAX_FEEDBACK_LENGTH = 2000;

function cleanText(value) {
  return String(value || "").trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 500);
}

function assignment(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1] || match?.[2]) return cleanText((match[1] || match[2]).replace(/[。.!！?？,，;；]+$/, ""));
  }
  return "";
}

function validColor(value) {
  return /^#[0-9a-f]{6}$/i.test(value || "") ? value : null;
}

/** Translate a small, auditable feedback vocabulary into CanvasPatch operations. */
export function parseDesignFeedback({ feedback, page, component, designDraft } = {}) {
  const raw = String(feedback || "");
  if (raw.length > MAX_FEEDBACK_LENGTH) {
    const error = new Error(`客户反馈不能超过 ${MAX_FEEDBACK_LENGTH} 个字符。`);
    error.code = "FEEDBACK_TOO_LONG";
    throw error;
  }
  const text = raw.trim();
  if (!text) throw new Error("FEEDBACK_REQUIRED");
  if (!page || !component || !designDraft) throw new Error("DESIGN_TARGET_REQUIRED");
  const operations = [];

  const title = assignment(text, [
    /(?:主标题|标题|headline|heading|hero\s*title)\s*(?:改为|改成|换成|设置为|替换为)\s*(?:[“\"]([^”\"]+)[”\"]|(.+?))(?:$|[，,；;。.!！?？\n])/i,
  ]);
  if (title) operations.push({ op: "set_props", page: page.page, componentId: component.instanceId, props: { title } });

  const description = assignment(text, [
    /(?:副标题|描述|说明|description|subtitle|hero\s*description)\s*(?:改为|改成|换成|设置为|替换为)\s*(?:[“\"]([^”\"]+)[”\"]|(.+?))(?:$|[，,；;。.!！?？\n])/i,
  ]);
  if (description) operations.push({ op: "set_props", page: page.page, componentId: component.instanceId, props: { description } });

  const ctaLabel = assignment(text, [
    /(?:按钮(?:文案|文字)?|行动按钮|cta(?:\s*label)?)\s*(?:改为|改成|换成|设置为|替换为)\s*(?:[“\"]([^”\"]+)[”\"]|(.+?))(?:$|[，,；;。.!！?？\n])/i,
  ]);
  if (ctaLabel) operations.push({ op: "set_props", page: page.page, componentId: component.instanceId, props: { ctaLabel } });

  const colorMatch = text.match(/(?:主色|品牌色|primary\s*color)\s*(?:改为|改成|换成|设置为|替换为)\s*(#[0-9a-f]{6})/i);
  const primary = validColor(colorMatch?.[1]);
  if (primary) operations.push({ op: "set_tokens", tokens: { color: { primary } } });

  const spacingDelta = /(?:少一点|减少|更少|缩小|紧凑|compact|tighter)/i.test(text)
    ? -8
    : /(?:多一点|增加|更大|放大|宽松|spacious|more\s+space)/i.test(text) ? 8 : 0;
  if (spacingDelta) {
    if (/(?:手机|移动端|移动版|mobile)/i.test(text)) {
      const error = new Error("当前设计令牌只支持全站区块间距；请把这条要求改为全站留白调整，或先在桌面/平板/手机预览中确认整体效果。");
      error.code = "FEEDBACK_NOT_ACTIONABLE";
      throw error;
    }
    const current = Number(designDraft.designTokens?.spacing?.section);
    const section = Math.min(240, Math.max(16, (Number.isFinite(current) ? current : 64) + spacingDelta));
    operations.push({ op: "set_tokens", tokens: { spacing: { section } } });
  }

  if (!operations.length) {
    const error = new Error("暂时无法把这条反馈转换为受控设计修改；请说明标题、描述、按钮文案、主色或留白需要如何调整。");
    error.code = "FEEDBACK_NOT_ACTIONABLE";
    throw error;
  }
  return { feedback: text, operations };
}

