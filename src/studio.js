const $ = (selector) => document.querySelector(selector);
const node = (tag, text, className) => { const item = document.createElement(tag); if (text !== undefined) item.textContent = String(text); if (className) item.className = className; return item; };
let projectId = null;
let runId = null;
let designDraft = null;
let currentRun = null;
let currentCandidate = null;
let currentPreview = null;
let intakePreview = null;

function notice(message, error = false) {
  const target = $("#notice");
  target.textContent = message;
  target.classList.toggle("error", error);
}

async function api(method, route, body, credential = "api") {
  const selector = credential === "reviewer" ? "#review-token" : credential === "l2" ? "#l2-token" : "#api-token";
  const token = $(selector).value.trim();
  if (!token) throw new Error(credential === "reviewer" ? "需要审核凭据" : credential === "l2" ? "需要 L2 执行凭据" : "需要 API 凭据");
  const response = await fetch(route, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || result.code || `HTTP ${response.status}`);
  return result;
}

async function action(fn) {
  try { notice(await fn() || "已更新"); } catch (error) { notice(error.message, true); }
}

async function loadProjects() {
  const { projects } = await api("GET", "/projects");
  $("#connection-status").textContent = "已连接";
  const list = $("#project-list");
  list.replaceChildren();
  for (const project of projects.toReversed()) {
    const button = node("button", project.goal);
    button.type = "button";
    button.classList.toggle("active", project.id === projectId);
    button.onclick = () => action(() => selectProject(project.id));
    list.append(button);
  }
  if (projectId && projects.some((project) => project.id === projectId)) await selectProject(projectId, false);
}

function modelConfigFromForm() {
  const baseUrl = $("#model-base-url").value.trim();
  const model = $("#model-name").value.trim();
  const apiMode = $("#model-api-mode").value;
  const apiKey = $("#model-api-key").value;
  if (!baseUrl || !model || !apiKey) throw new Error("请填写模型 URL、模型名称和 API Key");
  return { baseUrl, model, apiMode, apiKey };
}

async function loadModelStatus() {
  const status = await api("GET", "/model/status");
  const label = $("#model-status");
  if (!status.configured) {
    label.textContent = "未配置";
    return status;
  }
  label.textContent = `${status.model || "已配置"} · ${status.apiMode === "codex_responses" ? "Responses" : "Chat Completions"} · Key 已载入`;
  if (status.baseUrl) $("#model-base-url").value = status.baseUrl;
  if (status.model) $("#model-name").value = status.model;
  if (status.apiMode) $("#model-api-mode").value = status.apiMode;
  return status;
}

async function selectProject(id, reloadList = true) {
  projectId = id;
  const { runs } = await api("GET", `/projects/${encodeURIComponent(id)}/runs`);
  runId = runs.at(-1)?.id || null;
  if (reloadList) await loadProjects();
  await showRun();
}

async function showRun() {
  const target = $("#run-detail");
  target.replaceChildren();
  if (!runId) { target.textContent = "此项目尚无 Run。"; return; }
  const run = await api("GET", `/runs/${encodeURIComponent(runId)}`);
  currentRun = run;
  const agentState = await api("GET", `/runs/${encodeURIComponent(runId)}/agent`);
  const agentOutput = $("#agent-output");
  const decisionOutput = $("#agent-decisions");
  decisionOutput.replaceChildren();
  agentOutput.hidden = !agentState.agentState;
  decisionOutput.hidden = !agentState.decisions?.length;
  if (agentState.agentState) {
    agentOutput.textContent = JSON.stringify({ status: agentState.agentState.status, questions: agentState.agentState.questions, artifacts: agentState.artifacts.map(({ artifactId, type, role, status }) => ({ artifactId, type, role, status })) }, null, 2);
  }
  for (const decision of agentState.decisions || []) {
    const item = node("article", undefined, "agent-decision");
    item.append(node("strong", `${decision.role || "Agent"} · ${decision.action || "decision"}`));
    item.append(node("p", decision.whyNow));
    item.append(node("p", `预期观察：${decision.expectedObservation}`));
    item.append(node("small", `风险：${decision.risk} · 停止条件：${(decision.stopIf || []).join("、") || "未填写"}`));
    decisionOutput.append(item);
  }
  $("#run-agents").disabled = !run.strategy || run.status === "superseded";
  const designResult = await api("GET", `/runs/${encodeURIComponent(runId)}/design-drafts`);
  designDraft = designResult.designs.at(-1) || null;
  const { candidates } = await api("GET", "/candidates");
  currentCandidate = run.candidateIds?.length ? candidates.find((candidate) => candidate.id === run.candidateIds.at(-1)) || null : null;
  currentPreview = null;
  const details = node("dl");
  for (const [label, value] of [["Run", run.id], ["状态", run.checkpoint], ["策略", run.strategy?.strategy || "待生成"], ["页面", (run.strategy?.pageHierarchy || []).join(", ")]]) {
    details.append(node("dt", label), node("dd", value));
  }
  target.append(details);
  const brief = run.inputSnapshot && run.inputSnapshot.requirementBrief;
  if (brief && brief.summary) target.append(node("p", brief.summary, "intake-run-summary"));
  const questions = run.strategy?.openQuestions || [];
  if (questions.length) {
    const box = node("div", undefined, "questions");
    box.append(node("h3", "待补资料"));
    const list = node("ul");
    for (const question of questions) list.append(node("li", question.question || question.field));
    box.append(list);
    const form = node("form");
    const allowed = new Set(["audience", "primaryConversion", "brandConstraints", "contentAvailable"]);
    for (const question of questions.filter((item) => allowed.has(item.field))) {
      const label = node("label", question.question || question.field);
      const input = node("input"); input.name = question.field; input.required = true; label.append(input); form.append(label);
    }
    if (form.children.length) {
      const submit = node("button", "提交资料并创建新 Run", "primary"); submit.type = "submit"; form.append(submit);
      form.onsubmit = (event) => { event.preventDefault(); action(async () => { const data = Object.fromEntries(new FormData(form)); for (const key of ["brandConstraints", "contentAvailable"]) if (data[key]) data[key] = data[key].split(",").map((value) => value.trim()).filter(Boolean); const next = await api("POST", `/runs/${encodeURIComponent(runId)}/answers`, data); runId = next.id; await showRun(); }); };
      box.append(form);
    }
    target.append(box);
  }
  $("#research-status").textContent = run.research ? `${run.research.repository} @ ${run.research.commit}，${run.research.evidence.length} 条证据` : "尚未检索组件";
  $("#plan-output").hidden = !run.pagePlan;
  if (run.pagePlan) $("#plan-output").textContent = JSON.stringify({ routes: run.pagePlan.routes.map(({ route, file, components }) => ({ route, file, components: components.map(({ name }) => name) })), sourceManifestHash: run.pagePlan.sourceManifestHash }, null, 2);
  $("#create-design").disabled = !run.pagePlan;
  renderDesignDraft();
  renderDelivery();
}

function renderDelivery(result) {
  const status = $("#delivery-status");
  const output = $("#delivery-output");
  if (result !== undefined) {
    output.hidden = false;
    const view = result?.candidate ? { ...result, candidate: {
      id: result.candidate.id,
      parentId: result.candidate.parentId,
      status: result.candidate.status,
      candidateHash: result.candidate.candidateHash,
      designDraftId: result.candidate.designDraftId,
      designHash: result.candidate.revision?.designHash || null,
      cmsSnapshotId: result.candidate.cmsSnapshot?.cmsSnapshotId || null,
      buildPassed: Boolean(result.candidate.build?.passed),
      qaPassed: Boolean(result.candidate.quality?.passed),
    } } : result;
    if (view?.generated) delete view.generated;
    output.textContent = JSON.stringify(view, null, 2);
  }
  const hasPlan = Boolean(currentRun?.pagePlan && designDraft);
  const alreadyGenerated = currentRun?.candidateIds?.some((id) => currentCandidate?.id === id && currentCandidate.designDraftId === designDraft?.id);
  $("#create-candidate").disabled = !hasPlan || Boolean(alreadyGenerated);
  $("#create-payload").disabled = !currentCandidate?.build?.passed || Boolean(currentCandidate.cmsSnapshot);
  $("#start-preview").disabled = !currentCandidate?.build?.passed;
  $("#run-qa").disabled = !currentCandidate || !currentPreview;
  if (!currentCandidate) status.textContent = hasPlan ? "设计已就绪，可以生成代码候选。" : "需要先生成页面计划和设计草稿。";
  else status.textContent = `候选 ${currentCandidate.id} · ${currentCandidate.cmsSnapshot ? "含 Payload 草稿" : "代码候选"} · QA ${currentCandidate.quality?.passed ? "通过" : "待运行"}`;
}

function renderDesignDraft() {
  const target = $("#design-preview");
  const status = $("#design-status");
  const feedback = $("#feedback-form");
  target.replaceChildren();
  if (!designDraft) {
    status.textContent = "页面计划生成后创建首版设计。";
    target.textContent = "设计草稿会在这里显示。";
    feedback.hidden = true;
    return;
  }
  status.textContent = `版本 ${designDraft.id} · hash ${designDraft.designHash.slice(0, 12)} · ${designDraft.openQuestions.length} 个待确认项`;
  for (const page of designDraft.pageTree) {
    const card = node("article", undefined, "design-page");
    card.append(node("h3", `${page.page} · ${page.route}`));
    const list = node("ol");
    for (const component of page.components) {
      const item = node("li", `${component.name} · ${component.instanceId}`);
      const props = Object.keys(component.props || {}).length ? `属性：${JSON.stringify(component.props)}` : "默认属性";
      item.append(node("small", props, "muted"));
      list.append(item);
    }
    card.append(list); target.append(card);
  }
  feedback.hidden = false;
}

function checkbox(text) { const label = node("label"); const input = node("input"); input.type = "checkbox"; label.append(input, document.createTextNode(text)); return { label, input }; }

function renderIntakePreview(preview) {
  const brief = preview.requirementBrief;
  const summary = $("#intake-summary");
  const details = $("#intake-details");
  summary.replaceChildren(node("p", brief.summary));
  details.replaceChildren();
  for (const [label, value] of [["目标受众", brief.audience], ["转化目标", brief.primaryConversion]]) {
    if (!value) continue;
    const row = node("p");
    row.append(node("strong", label + "："), document.createTextNode(value.value + " "), node("small", "原文：“" + value.quote + "”", "muted"));
    details.append(row);
  }
  for (const [label, values] of [["语言", brief.locales], ["品牌限制", brief.brandConstraints], ["已有资料", brief.contentAvailable], ["功能需求", brief.requestedFeatures]]) {
    if (!values || !values.length) continue;
    const group = node("div");
    group.append(node("strong", label));
    const list = node("ul");
    for (const value of values) {
      const item = node("li");
      item.append(document.createTextNode(value.value));
      if (value.quote) item.append(node("small", " 原文：“" + value.quote + "”", "muted"));
      list.append(item);
    }
    group.append(list);
    details.append(group);
  }
  if (brief.recommendedPages && brief.recommendedPages.length) details.append(node("p", "建议页面：" + brief.recommendedPages.join("、")));
  if (brief.designSuggestions && brief.designSuggestions.length) details.append(node("p", "设计建议：" + brief.designSuggestions.join("；")));
  if (brief.assumptions && brief.assumptions.length) details.append(node("p", "待确认的设计假设：" + brief.assumptions.join("；"), "muted"));
  if (brief.openQuestions && brief.openQuestions.length) {
    details.append(node("strong", "需要补充的信息"));
    const list = node("ul");
    for (const question of brief.openQuestions) list.append(node("li", question.question + (question.reason ? "（" + question.reason + "）" : "")));
    details.append(list);
  }
}

async function loadReviews() {
  const [{ registry }, { candidates }] = await Promise.all([api("GET", "/components"), api("GET", "/candidates")]);
  const components = $("#components"); components.replaceChildren();
  for (const block of registry.blocks.filter((item) => item.state === "candidate")) {
    const item = node("article", undefined, "review-item");
    item.append(node("h3", `${block.name} · ${block.kind}`), node("p", block.repository), node("code", `${block.path} @ ${block.commit}`), node("p", `许可声明：${block.license || "未提供"}`));
    const license = checkbox("已核对上游许可证与文件来源"); const tests = checkbox("已运行或查验证据所列测试");
    const notes = node("textarea"); notes.placeholder = "填写许可证和测试证据位置"; notes.required = true;
    const approve = node("button", "批准组件", "primary"); approve.type = "button";
    approve.onclick = () => action(async () => { if (!license.input.checked || !tests.input.checked || !notes.value.trim()) throw new Error("请逐项核对并填写证据位置"); await api("POST", `/components/${encodeURIComponent(block.id)}/review`, { approved: true, licenseVerified: true, testsPassed: true, notes: notes.value.trim() }, "reviewer"); await loadReviews(); });
    item.append(license.label, tests.label, notes, approve); components.append(item);
  }
  if (!components.children.length) components.append(node("p", "暂无待审核组件", "muted"));
  const list = $("#candidates"); list.replaceChildren();
  for (const candidate of candidates.toReversed()) {
    const item = node("article", undefined, "review-item");
    item.append(node("h3", candidate.id), node("p", `状态：${candidate.status} · QA：${candidate.quality?.passed ? "通过" : "未通过"}`), node("code", candidate.candidateHash));
    if (candidate.quality?.passed && !candidate.review) {
      const decision = checkbox("已核对候选、QA 报告和来源"); const notes = node("textarea"); notes.placeholder = "审核意见"; const approve = node("button", "提交审核", "primary"); approve.type = "button";
      approve.onclick = () => action(async () => { if (!decision.input.checked || !notes.value.trim()) throw new Error("请核对候选并填写审核意见"); await api("POST", `/candidates/${encodeURIComponent(candidate.id)}/review`, { approved: true, notes: notes.value.trim() }, "reviewer"); await loadReviews(); });
      item.append(decision.label, notes, approve);
    }
    list.append(item);
  }
  if (!list.children.length) list.append(node("p", "暂无候选交付", "muted"));
}

$("#connect").onclick = () => action(async () => { await loadProjects(); await loadModelStatus(); if (!$("#review-view").hidden) await loadReviews(); });
$("#model-test").onclick = () => action(async () => {
  const result = await api("POST", "/model/test", modelConfigFromForm());
  return `模型连接成功：${result.model} · ${result.apiMode === "codex_responses" ? "Responses" : "Chat Completions"}`;
});
$("#model-apply").onclick = () => action(async () => {
  const config = modelConfigFromForm();
  await api("POST", "/model/test", config);
  const result = await api("POST", "/model/config", config);
  $("#model-api-key").value = "";
  $("#model-status").textContent = `${result.model} · ${result.apiMode === "codex_responses" ? "Responses" : "Chat Completions"} · Key 已载入`;
  return "模型配置已应用到当前进程";
});
$("#model-clear").onclick = () => action(async () => {
  const result = await api("POST", "/model/config", { clear: true });
  $("#model-api-key").value = "";
  $("#model-status").textContent = result.configured ? `${result.model} · 环境配置` : "未配置";
  return result.configured ? "已清除 Studio 配置，恢复服务端环境配置" : "已清除模型配置";
});
$("#review-token-field").style.display = "none";
$("#l2-token-field").style.display = "none";
$("#refresh").onclick = () => action(loadProjects);
$("#tab-client").onclick = () => { $("#client-view").hidden = false; $("#review-view").hidden = true; $("#review-token-field").style.display = "none"; $("#l2-token-field").style.display = "none"; $("#tab-client").setAttribute("aria-selected", "true"); $("#tab-review").setAttribute("aria-selected", "false"); };
$("#tab-review").onclick = () => { $("#client-view").hidden = true; $("#review-view").hidden = false; $("#review-token-field").style.display = "grid"; $("#l2-token-field").style.display = "none"; $("#tab-client").setAttribute("aria-selected", "false"); $("#tab-review").setAttribute("aria-selected", "true"); action(loadReviews); };
$("#research-form").onsubmit = (event) => { event.preventDefault(); action(async () => { if (!runId) throw new Error("请先选择项目 Run"); const result = await api("POST", `/runs/${encodeURIComponent(runId)}/research`, Object.fromEntries(new FormData(event.target))); $("#research-status").textContent = `${result.repository} @ ${result.commit}，${result.evidence.length} 条证据`; await showRun(); }); };
$("#run-agents").onclick = () => action(async () => {
  if (!runId) throw new Error("请先选择项目 Run");
  const form = new FormData($("#research-form"));
  const repository = String(form.get("repository") || "").trim();
  const expectedCommit = String(form.get("expectedCommit") || "").trim();
  if (Boolean(repository) !== Boolean(expectedCommit)) throw new Error("CodeAtlas 仓库 ID 和固定 commit 必须同时填写");
  const button = $("#run-agents"); button.disabled = true; button.textContent = "Agent 规划中…";
  try {
    const result = await api("POST", `/runs/${encodeURIComponent(runId)}/agent`, repository ? { repository, expectedCommit } : {});
    $("#agent-output").hidden = false;
    $("#agent-output").textContent = JSON.stringify({ status: result.status, questions: result.questions, artifacts: result.artifacts.map(({ artifactId, type, role, status }) => ({ artifactId, type, role, status })) }, null, 2);
    await showRun();
    return result.status === "needs_input" ? "总控 Agent 需要补充信息" : "策略与组件研究已生成，可继续设计流程";
  } finally {
    button.disabled = false; button.textContent = "总控 Agent 规划";
  }
});
$("#create-plan").onclick = () => action(async () => { if (!runId) throw new Error("请先选择项目 Run"); await api("POST", `/runs/${encodeURIComponent(runId)}/page-plan`, {}); await showRun(); });
$("#create-design").onclick = () => action(async () => {
  if (!runId) throw new Error("请先选择项目 Run");
  await api("POST", `/runs/${encodeURIComponent(runId)}/design-drafts`, {});
  await showRun();
});
$("#feedback-form").onsubmit = (event) => { event.preventDefault(); action(async () => {
  if (!designDraft) throw new Error("请先创建设计草稿");
  const feedback = $("#design-feedback").value.trim();
  let props;
  try { props = JSON.parse($("#design-props").value); } catch { throw new Error("属性补丁必须是 JSON 对象"); }
  if (!props || typeof props !== "object" || Array.isArray(props)) throw new Error("属性补丁必须是 JSON 对象");
  const page = designDraft.pageTree[0]; const component = page?.components[0];
  if (!component) throw new Error("当前设计没有可修改的组件");
  await api("POST", `/design-drafts/${encodeURIComponent(designDraft.id)}/patches`, { expectedDesignHash: designDraft.designHash, feedback, operations: [{ op: "set_props", page: page.page, componentId: component.instanceId, props }] });
  $("#design-feedback").value = "";
  await showRun();
}); };
$("#create-candidate").onclick = () => action(async () => {
  if (!runId || !designDraft) throw new Error("请先生成页面计划和设计草稿");
  if (!$("#review-token").value.trim() || !$("#l2-token").value.trim()) {
    $("#review-token-field").style.display = "grid";
    $("#l2-token-field").style.display = "grid";
    throw new Error("填写审核与 L2 执行凭据后，再生成候选");
  }
  const grant = await api("POST", "/runs/" + encodeURIComponent(runId) + "/grants", { tool: "generate_candidate", expiresAt: new Date(Date.now() + 60_000).toISOString() }, "reviewer");
  const result = await api("POST", "/runs/" + encodeURIComponent(runId) + "/generate", { grantId: grant.id }, "l2");
  currentCandidate = result.candidate;
  currentPreview = null;
  await showRun();
  renderDelivery({ candidate: result.candidate, build: result.build });
});
$("#create-payload").onclick = () => action(async () => {
  if (!currentCandidate) throw new Error("请先生成候选");
  let contentByPage;
  try { contentByPage = JSON.parse($("#payload-content").value); } catch { throw new Error("客户内容必须是 JSON 对象"); }
  if (!contentByPage || typeof contentByPage !== "object" || Array.isArray(contentByPage)) throw new Error("客户内容必须是 JSON 对象");
  const receipt = await api("POST", "/candidates/" + encodeURIComponent(currentCandidate.id) + "/payload-draft", {
    expectedCmsSnapshot: $("#payload-snapshot").value.trim(),
    idempotencyKey: $("#payload-idempotency").value.trim(),
    contentByPage,
  });
  currentCandidate = receipt.candidate;
  currentPreview = null;
  await showRun();
  renderDelivery(receipt);
});
$("#start-preview").onclick = () => action(async () => {
  if (!currentCandidate) throw new Error("请先生成候选");
  currentPreview = await api("POST", "/candidates/" + encodeURIComponent(currentCandidate.id) + "/preview", {});
  $("#qa-preview-id").value = currentPreview.sessionId;
  renderDelivery({ candidate: currentCandidate, preview: currentPreview, previewType: "local-read-only" });
});
$("#run-qa").onclick = () => action(async () => {
  if (!currentCandidate || !currentPreview) throw new Error("请先启动该候选的本地预览");
  const report = await api("POST", "/candidates/" + encodeURIComponent(currentCandidate.id) + "/qa", {
    qaPreviewId: $("#qa-preview-id").value.trim() || currentPreview.sessionId,
    routes: currentRun?.pagePlan?.routes.map((route) => route.route) || ["/"],
    locales: currentRun?.inputSnapshot?.locale || ["en"],
  });
  currentCandidate.quality = { passed: report.passed, reportHash: report.reportHash, candidateHash: report.candidateHash };
  renderDelivery({ candidate: currentCandidate, preview: currentPreview, qa: report, previewType: "local-read-only" });
});

$("#project-form").onsubmit = (event) => { event.preventDefault(); action(async () => {
  const requestText = new FormData(event.target).get("requestText").trim();
  if (!requestText) throw new Error("请先描述网站需求");
  intakePreview = await api("POST", "/intake/preview", { requestText });
  renderIntakePreview(intakePreview);
  $("#intake-review").hidden = false;
  $("#confirm-intake").disabled = false;
}); };
$("#project-form [name=requestText]").addEventListener("input", () => {
  intakePreview = null;
  $("#intake-review").hidden = true;
  $("#confirm-intake").disabled = true;
});
$("#confirm-intake").onclick = () => action(async () => {
  if (!intakePreview) throw new Error("请先分析需求");
  const values = Object.fromEntries(new FormData($("#project-form")));
  const supplemental = {};
  if (values.industry) supplemental.industry = values.industry;
  if (values.audience.trim()) supplemental.audience = values.audience.trim();
  if (values.primaryConversion.trim()) supplemental.primaryConversion = values.primaryConversion.trim();
  for (const key of ["brandConstraints", "contentAvailable", "locale"]) {
    if (values[key].trim()) supplemental[key] = values[key].split(",").map((value) => value.trim()).filter(Boolean);
  }
  const created = await api("POST", "/intake/confirm", { intakeId: intakePreview.intakeId, supplemental });
  projectId = created.project.id;
  runId = created.run.id;
  intakePreview = null;
  $("#intake-review").hidden = true;
  $("#confirm-intake").disabled = true;
  $("#project-form").reset();
  await loadProjects();
});
