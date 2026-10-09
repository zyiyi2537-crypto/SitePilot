const $ = (selector) => document.querySelector(selector);
const node = (tag, text, className) => { const item = document.createElement(tag); if (text !== undefined) item.textContent = String(text); if (className) item.className = className; return item; };
let projectId = null;
let runId = null;

function notice(message, error = false) {
  const target = $("#notice");
  target.textContent = message;
  target.classList.toggle("error", error);
}

async function api(method, route, body, reviewer = false) {
  const token = $(reviewer ? "#review-token" : "#api-token").value.trim();
  if (!token) throw new Error(reviewer ? "需要审核凭据" : "需要 API 凭据");
  const response = await fetch(route, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || result.code || `HTTP ${response.status}`);
  return result;
}

async function action(fn) {
  try { await fn(); notice("已更新"); } catch (error) { notice(error.message, true); }
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
  const details = node("dl");
  for (const [label, value] of [["Run", run.id], ["状态", run.checkpoint], ["策略", run.strategy?.strategy || "待生成"], ["页面", (run.strategy?.pageHierarchy || []).join(", ")]]) {
    details.append(node("dt", label), node("dd", value));
  }
  target.append(details);
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
}

function checkbox(text) { const label = node("label"); const input = node("input"); input.type = "checkbox"; label.append(input, document.createTextNode(text)); return { label, input }; }

async function loadReviews() {
  const [{ registry }, { candidates }] = await Promise.all([api("GET", "/components"), api("GET", "/candidates")]);
  const components = $("#components"); components.replaceChildren();
  for (const block of registry.blocks.filter((item) => item.state === "candidate")) {
    const item = node("article", undefined, "review-item");
    item.append(node("h3", `${block.name} · ${block.kind}`), node("p", block.repository), node("code", `${block.path} @ ${block.commit}`), node("p", `许可声明：${block.license || "未提供"}`));
    const license = checkbox("已核对上游许可证与文件来源"); const tests = checkbox("已运行或查验证据所列测试");
    const notes = node("textarea"); notes.placeholder = "填写许可证和测试证据位置"; notes.required = true;
    const approve = node("button", "批准组件", "primary"); approve.type = "button";
    approve.onclick = () => action(async () => { if (!license.input.checked || !tests.input.checked || !notes.value.trim()) throw new Error("请逐项核对并填写证据位置"); await api("POST", `/components/${encodeURIComponent(block.id)}/review`, { approved: true, licenseVerified: true, testsPassed: true, notes: notes.value.trim() }, true); await loadReviews(); });
    item.append(license.label, tests.label, notes, approve); components.append(item);
  }
  if (!components.children.length) components.append(node("p", "暂无待审核组件", "muted"));
  const list = $("#candidates"); list.replaceChildren();
  for (const candidate of candidates.toReversed()) {
    const item = node("article", undefined, "review-item");
    item.append(node("h3", candidate.id), node("p", `状态：${candidate.status} · QA：${candidate.quality?.passed ? "通过" : "未通过"}`), node("code", candidate.candidateHash));
    if (candidate.quality?.passed && !candidate.review) {
      const decision = checkbox("已核对候选、QA 报告和来源"); const notes = node("textarea"); notes.placeholder = "审核意见"; const approve = node("button", "提交审核", "primary"); approve.type = "button";
      approve.onclick = () => action(async () => { if (!decision.input.checked || !notes.value.trim()) throw new Error("请核对候选并填写审核意见"); await api("POST", `/candidates/${encodeURIComponent(candidate.id)}/review`, { approved: true, notes: notes.value.trim() }, true); await loadReviews(); });
      item.append(decision.label, notes, approve);
    }
    list.append(item);
  }
  if (!list.children.length) list.append(node("p", "暂无候选交付", "muted"));
}

$("#connect").onclick = () => action(async () => { await loadProjects(); if (!$("#review-view").hidden) await loadReviews(); });
$("#review-token-field").style.display = "none";
$("#refresh").onclick = () => action(loadProjects);
$("#tab-client").onclick = () => { $("#client-view").hidden = false; $("#review-view").hidden = true; $("#review-token-field").style.display = "none"; $("#tab-client").setAttribute("aria-selected", "true"); $("#tab-review").setAttribute("aria-selected", "false"); };
$("#tab-review").onclick = () => { $("#client-view").hidden = true; $("#review-view").hidden = false; $("#review-token-field").style.display = "grid"; $("#tab-client").setAttribute("aria-selected", "false"); $("#tab-review").setAttribute("aria-selected", "true"); action(loadReviews); };
$("#project-form").onsubmit = (event) => { event.preventDefault(); action(async () => { const form = new FormData(event.target); const input = Object.fromEntries(form); input.contentAvailable = input.contentAvailable.split(",").map((value) => value.trim()).filter(Boolean); const project = await api("POST", "/projects", input); projectId = project.id; const run = await api("POST", `/projects/${encodeURIComponent(project.id)}/runs`, {}); runId = run.id; await loadProjects(); event.target.reset(); }); };
$("#research-form").onsubmit = (event) => { event.preventDefault(); action(async () => { if (!runId) throw new Error("请先选择项目 Run"); const result = await api("POST", `/runs/${encodeURIComponent(runId)}/research`, Object.fromEntries(new FormData(event.target))); $("#research-status").textContent = `${result.repository} @ ${result.commit}，${result.evidence.length} 条证据`; await showRun(); }); };
$("#create-plan").onclick = () => action(async () => { if (!runId) throw new Error("请先选择项目 Run"); await api("POST", `/runs/${encodeURIComponent(runId)}/page-plan`, {}); await showRun(); });
