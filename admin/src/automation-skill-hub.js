const CAPABILITIES = Object.freeze([
  {
    key: "bot_inspection",
    title: "自动识别机器人操作",
    icon: "识",
    badge: "用户与管理员",
    audience: "all",
    description: "选择 Telegram 账号并向机器人发送命令，读取机器人回复和可用按钮，再自动生成按钮签到任务配置。",
    suitable: "不知道机器人要点击哪个按钮，或希望系统自动读取回复结构时。",
    execution: "一次识别后生成任务",
    action: "inspection",
  },
  {
    key: "realtime_keyword_reply",
    title: "24 小时关键词自动回复",
    icon: "回",
    badge: "管理员专用",
    audience: "admin",
    description: "由 VPS Listener 长期监听指定会话，消息命中关键词后自动发送固定回复。",
    suitable: "客服问答、价格咨询、常见问题和全天候固定回复。",
    execution: "VPS Listener 常驻",
    action: "realtime",
    kind: "keyword_reply",
  },
  {
    key: "realtime_group_monitor",
    title: "全天候群消息监听",
    icon: "监",
    badge: "管理员专用",
    audience: "admin",
    description: "由 VPS Listener 持续监听指定群组，可按关键词筛选并在后台记录命中消息。",
    suitable: "采购线索、售后关键词、群内重要消息和业务提醒。",
    execution: "VPS Listener 常驻",
    action: "realtime",
    kind: "group_monitor",
  },
  {
    key: "account_connection_check",
    title: "账号连接检测",
    icon: "检",
    badge: "管理员专用",
    audience: "admin",
    description: "创建一次连接检测任务，验证 Telegram Session、应用凭据和代理是否仍然可用。",
    suitable: "账号异常、Session 失效、代理变更或部署后进行连接确认。",
    execution: "立即执行检测",
    action: "validation",
  },
]);

let pendingScheduledDraft = null;
let taskSectionLoading = false;

function isAdministrator() {
  const marker = document.querySelector("[data-admin-only]");
  return Boolean(marker && !marker.hidden);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function listFrom(payload, keys = []) {
  if (Array.isArray(payload)) return payload;
  for (const key of keys) {
    if (Array.isArray(payload?.[key])) return payload[key];
    if (Array.isArray(payload?.data?.[key])) return payload.data[key];
  }
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

async function request(path, { method = "GET", body } = {}) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? { accept: "application/json" } : {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `请求失败（HTTP ${response.status}）`);
    error.status = response.status;
    error.code = payload?.error?.code;
    throw error;
  }
  return payload?.data ?? payload;
}

function notify(title, message = "", kind = "success") {
  const region = document.querySelector("#toast-region");
  if (!region) return;
  const element = document.createElement("div");
  element.className = `toast ${kind === "error" ? "error" : ""}`;
  element.innerHTML = `<span aria-hidden="true">${kind === "error" ? "!" : "✓"}</span><div><strong>${escapeHtml(title)}</strong>${message ? escapeHtml(message) : ""}</div>`;
  region.append(element);
  setTimeout(() => element.remove(), 5200);
}

function closeHubModal() {
  const root = document.querySelector("#modal-root");
  if (!root) return;
  root.innerHTML = "";
  document.body.style.overflow = "";
}

function openHubModal({ title, description = "", body, footer = "" }) {
  const root = document.querySelector("#modal-root");
  if (!root) return;
  root.innerHTML = `<div class="modal-backdrop" data-skill-hub-backdrop>
    <section class="modal wide" role="dialog" aria-modal="true" aria-labelledby="skill-hub-modal-title">
      <header class="modal-head"><div><h2 id="skill-hub-modal-title">${escapeHtml(title)}</h2>${description ? `<p>${escapeHtml(description)}</p>` : ""}</div><button type="button" class="modal-close" data-skill-hub-action="close-modal" aria-label="关闭">×</button></header>
      <div class="modal-body">${body}</div>
      ${footer ? `<footer class="modal-foot">${footer}</footer>` : ""}
    </section>
  </div>`;
  document.body.style.overflow = "hidden";
  queueMicrotask(() => root.querySelector("input:not([type=hidden]), select, button")?.focus());
}

function existingSkillKey(card) {
  return card.querySelector(".skill-meta strong.mono")?.textContent.trim() || "";
}

function addExistingSkillActions() {
  for (const card of document.querySelectorAll(".skill-grid .skill-card:not([data-skill-hub-capability])")) {
    if (card.querySelector("[data-skill-hub-existing-action]")) continue;
    const key = existingSkillKey(card);
    if (!["send_text", "tg_signer"].includes(key)) continue;
    const disabled = Boolean(card.querySelector(".badge.disabled"));
    const actions = document.createElement("div");
    actions.className = "actions mt-md";
    actions.dataset.skillHubExistingAction = "true";
    actions.innerHTML = `<button class="button primary" type="button" data-skill-hub-action="create-scheduled" data-skill-key="${escapeHtml(key)}" ${disabled ? "disabled" : ""}>${key === "tg_signer" ? "创建按钮签到任务" : "创建消息任务"}</button>`;
    card.append(actions);
  }
}

function capabilityCard(definition) {
  return `<article class="skill-card" data-skill-hub-capability="${escapeHtml(definition.key)}">
    <div class="skill-card-head"><div><div class="skill-icon" aria-hidden="true">${escapeHtml(definition.icon)}</div><h2>${escapeHtml(definition.title)}</h2></div><span class="badge enabled">${escapeHtml(definition.badge)}</span></div>
    <p>${escapeHtml(definition.description)}</p>
    <div class="notice"><span aria-hidden="true">i</span><span>适合：${escapeHtml(definition.suitable)}</span></div>
    <div class="skill-meta"><span>内部标识（无需修改）<strong>${escapeHtml(definition.key)}</strong></span><span>执行方式<strong>${escapeHtml(definition.execution)}</strong></span><span>权限<strong>${definition.audience === "admin" ? "仅平台管理员" : "普通用户与管理员"}</strong></span><span>配置入口<strong>创建任务</strong></span></div>
    <div class="actions mt-md"><button class="button primary" type="button" data-skill-hub-action="${definition.action === "inspection" ? "create-inspection" : definition.action === "validation" ? "create-validation" : "create-realtime"}" ${definition.kind ? `data-rule-kind="${escapeHtml(definition.kind)}"` : ""}>${definition.action === "validation" ? "创建检测任务" : "创建任务"}</button></div>
  </article>`;
}

function ensureCapabilityCards() {
  const grid = document.querySelector(".skill-grid");
  if (!grid) return;
  addExistingSkillActions();
  const allowed = CAPABILITIES.filter((item) => item.audience === "all" || isAdministrator());
  for (const definition of allowed) {
    if (grid.querySelector(`[data-skill-hub-capability="${definition.key}"]`)) continue;
    grid.insertAdjacentHTML("beforeend", capabilityCard(definition));
  }
  if (!isAdministrator()) {
    grid.querySelectorAll('[data-skill-hub-capability][data-admin-capability="true"]').forEach((card) => card.remove());
  }
}

function openScheduledDraft(skillKey, { focusInspection = false } = {}) {
  pendingScheduledDraft = { skillKey, focusInspection, startedAt: Date.now() };
  if (!String(location.hash).startsWith("#/tasks")) location.hash = "#/tasks";
  queueMicrotask(applyPendingScheduledDraft);
}

function applyPendingScheduledDraft() {
  if (!pendingScheduledDraft || Date.now() - pendingScheduledDraft.startedAt > 15_000) {
    pendingScheduledDraft = null;
    return;
  }
  if (!String(location.hash).startsWith("#/tasks")) return;
  let form = document.querySelector("#task-form");
  if (!form) {
    const addButton = document.querySelector('[data-action="add-task"]');
    if (addButton && !addButton.disabled) addButton.click();
    form = document.querySelector("#task-form");
  }
  if (!form) return;
  const select = form.querySelector("#task-skill");
  if (select && [...select.options].some((option) => option.value === pendingScheduledDraft.skillKey && !option.disabled)) {
    select.value = pendingScheduledDraft.skillKey;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }
  if (pendingScheduledDraft.focusInspection) {
    setTimeout(() => {
      const controls = form.querySelector("[data-bot-inspection-controls]");
      controls?.scrollIntoView({ behavior: "smooth", block: "center" });
      controls?.querySelector("button")?.focus();
    }, 80);
  }
  pendingScheduledDraft = null;
}

async function connectedAccounts() {
  const payload = await request("/api/v1/accounts?limit=100");
  return listFrom(payload, ["accounts"]).filter((account) => account.enabled && account.status === "connected");
}

function accountOptions(accounts, selected = "") {
  return `<option value="">请选择 Telegram 账号</option>${accounts.map((account) => `<option value="${escapeHtml(account.id)}" ${String(account.id) === String(selected) ? "selected" : ""}>${escapeHtml(account.name)}</option>`).join("")}`;
}

function realtimeFormMarkup(kind, accounts, rule = null) {
  const keywordReply = kind === "keyword_reply";
  return `<form id="skill-hub-realtime-form" data-id="${escapeHtml(rule?.id || "")}" data-kind="${escapeHtml(kind)}" novalidate><div class="form-grid">
    <div class="field span-2"><label class="required" for="hub-rule-name">任务名称</label><input id="hub-rule-name" name="name" maxlength="100" required value="${escapeHtml(rule?.name || "")}" placeholder="${keywordReply ? "例如：价格咨询自动回复" : "例如：采购关键词监听"}"></div>
    <div class="field"><label class="required" for="hub-rule-account">Telegram 账号</label><select id="hub-rule-account" name="account_id" required>${accountOptions(accounts, rule?.account_id)}</select></div>
    <div class="field"><label for="hub-rule-case">匹配方式</label><select id="hub-rule-case" name="case_sensitive"><option value="false" ${rule?.case_sensitive ? "" : "selected"}>不区分大小写</option><option value="true" ${rule?.case_sensitive ? "selected" : ""}>区分大小写</option></select></div>
    <div class="field span-2"><label class="required" for="hub-rule-chat">监听范围</label><input id="hub-rule-chat" name="chat_selector" maxlength="128" required value="${escapeHtml(rule?.chat_selector || "*")}" placeholder="*、@群组用户名或数字 Chat ID"><p class="field-help">填写 * 表示该账号收到的所有适用会话。</p></div>
    <div class="field span-2"><label ${keywordReply ? 'class="required"' : ""} for="hub-rule-keyword">关键词</label><input id="hub-rule-keyword" name="keyword" maxlength="200" ${keywordReply ? "required" : ""} value="${escapeHtml(rule?.keyword || "")}" placeholder="${keywordReply ? "例如：价格、客服" : "可留空监听全部群消息"}"></div>
    ${keywordReply ? `<div class="field span-2"><label class="required" for="hub-rule-response">自动回复内容</label><textarea id="hub-rule-response" name="response_text" maxlength="2000" required placeholder="命中关键词后发送的固定回复">${escapeHtml(rule?.response_text || "")}</textarea></div>` : ""}
    <div class="field span-2"><label class="check-row"><input type="checkbox" name="enabled" ${rule?.enabled === false ? "" : "checked"}>保存后启用任务</label></div>
  </div></form>`;
}

async function openRealtimeTask(kind, rule = null) {
  if (!isAdministrator()) return;
  try {
    const accounts = await connectedAccounts();
    if (!accounts.length) {
      notify("没有可用账号", "请先完成 Telegram 手机号登录并确认账号已连接。", "error");
      return;
    }
    const keywordReply = kind === "keyword_reply";
    openHubModal({
      title: rule ? `编辑${keywordReply ? "关键词自动回复" : "群消息监听"}任务` : `创建${keywordReply ? "24 小时关键词自动回复" : "全天候群消息监听"}任务`,
      description: "任务保存后由 VPS Listener 常驻执行，不需要在设置页配置业务规则。",
      body: realtimeFormMarkup(kind, accounts, rule),
      footer: `<span class="field-help">同一账号的定时任务也会由 Listener 统一执行</span><div><button class="button" type="button" data-skill-hub-action="close-modal">取消</button><button class="button primary" type="submit" form="skill-hub-realtime-form">保存任务</button></div>`,
    });
  } catch (error) {
    notify("无法创建任务", error.message, "error");
  }
}

async function submitRealtimeTask(form) {
  const data = new FormData(form);
  const id = form.dataset.id;
  const kind = form.dataset.kind;
  const payload = {
    account_id: String(data.get("account_id") || ""),
    kind,
    name: String(data.get("name") || "").trim(),
    chat_selector: String(data.get("chat_selector") || "*").trim(),
    keyword: String(data.get("keyword") || "").trim(),
    response_text: kind === "keyword_reply" ? String(data.get("response_text") || "").trim() : "",
    case_sensitive: data.get("case_sensitive") === "true",
    enabled: data.get("enabled") === "on",
  };
  const button = document.querySelector(`button[type="submit"][form="${form.id}"]`);
  if (button) {
    button.disabled = true;
    button.textContent = "正在保存…";
  }
  try {
    await request(id ? `/api/v1/admin/realtime-rules/${encodeURIComponent(id)}` : "/api/v1/admin/realtime-rules", {
      method: id ? "PATCH" : "POST",
      body: payload,
    });
    closeHubModal();
    notify(id ? "任务已更新" : "任务已创建", "VPS Listener 会在下一次同步时加载。", "success");
    await renderRealtimeTaskSection({ force: true });
  } catch (error) {
    notify("保存失败", error.message, "error");
    if (button) {
      button.disabled = false;
      button.textContent = "保存任务";
    }
  }
}

async function openValidationTask() {
  if (!isAdministrator()) return;
  try {
    const accounts = await connectedAccounts();
    if (!accounts.length) {
      notify("没有可检测账号", "请先完成 Telegram 登录并启用账号。", "error");
      return;
    }
    openHubModal({
      title: "创建账号连接检测任务",
      description: "立即验证 Session、Telegram API 凭据和代理连接。",
      body: `<form id="skill-hub-validation-form"><div class="form-grid"><div class="field span-2"><label class="required" for="hub-validation-account">Telegram 账号</label><select id="hub-validation-account" name="account_id" required>${accountOptions(accounts)}</select></div></div><div class="notice mt-md"><span aria-hidden="true">i</span><span>检测会创建一次安全验证流程，不会修改账号 Session，也不会发送业务消息。</span></div></form>`,
      footer: `<span class="field-help">结果可在 Telegram 账号页面查看</span><div><button class="button" type="button" data-skill-hub-action="close-modal">取消</button><button class="button primary" type="submit" form="skill-hub-validation-form">创建并执行</button></div>`,
    });
  } catch (error) {
    notify("无法创建检测任务", error.message, "error");
  }
}

async function submitValidationTask(form) {
  const accountId = String(new FormData(form).get("account_id") || "");
  if (!accountId) {
    notify("请选择账号", "需要指定一个已连接的 Telegram 账号。", "error");
    return;
  }
  const button = document.querySelector(`button[type="submit"][form="${form.id}"]`);
  if (button) {
    button.disabled = true;
    button.textContent = "正在创建…";
  }
  try {
    await request(`/api/v1/accounts/${encodeURIComponent(accountId)}/validate`, { method: "POST", body: {} });
    closeHubModal();
    notify("检测任务已创建", "请稍后到 Telegram 账号页面查看连接状态。", "success");
  } catch (error) {
    notify("检测启动失败", error.message, "error");
    if (button) {
      button.disabled = false;
      button.textContent = "创建并执行";
    }
  }
}

function ruleKindLabel(kind) {
  return kind === "keyword_reply" ? "24小时关键词自动回复" : "全天候群消息监听";
}

function realtimeRulesMarkup(rules) {
  if (!rules.length) return '<p class="field-help">尚未创建管理员 24 小时任务。</p>';
  return `<div class="service-list">${rules.map((rule) => `<div class="service-row"><div><strong>${escapeHtml(rule.name)}</strong><small>${escapeHtml(rule.account_name || "—")} · ${escapeHtml(ruleKindLabel(rule.kind))} · 范围 ${escapeHtml(rule.chat_selector || "*")}${rule.keyword ? ` · 关键词 ${escapeHtml(rule.keyword)}` : ""}</small></div><div class="actions"><span class="badge ${rule.enabled ? "success" : "pending"}">${rule.enabled ? "运行中" : "已停用"}</span><button class="button small ghost" type="button" data-skill-hub-action="toggle-rule" data-id="${escapeHtml(rule.id)}" data-enabled="${rule.enabled ? "true" : "false"}">${rule.enabled ? "停用" : "启用"}</button><button class="button small ghost" type="button" data-skill-hub-action="edit-rule" data-id="${escapeHtml(rule.id)}">编辑</button><button class="button small ghost danger" type="button" data-skill-hub-action="delete-rule" data-id="${escapeHtml(rule.id)}">删除</button></div></div>`).join("")}</div>`;
}

async function renderRealtimeTaskSection({ force = false } = {}) {
  if (!isAdministrator() || !String(location.hash).startsWith("#/tasks")) return;
  const taskTable = document.querySelector("#tasks-table");
  const parentCard = taskTable?.closest("section.card");
  if (!parentCard || taskSectionLoading) return;
  let section = document.querySelector("[data-skill-hub-realtime-tasks]");
  if (!section) {
    section = document.createElement("section");
    section.className = "card mt-md";
    section.dataset.skillHubRealtimeTasks = "true";
    parentCard.insertAdjacentElement("afterend", section);
  }
  if (!force && section.dataset.loaded === "true") return;
  taskSectionLoading = true;
  section.innerHTML = '<div class="card-body"><p class="field-help">正在加载管理员 24 小时任务…</p></div>';
  try {
    const rules = listFrom(await request("/api/v1/admin/realtime-rules"), ["rules"]);
    if (!section.isConnected) return;
    section.dataset.loaded = "true";
    section._rules = rules;
    section.innerHTML = `<div class="card-head"><div><h2>管理员 24 小时任务</h2><p>这些任务由 VPS Listener 常驻执行；普通用户不会看到此区域。</p></div><button class="button small ghost" type="button" data-skill-hub-action="refresh-rules">刷新</button></div><div class="card-body"><div class="actions mb-md"><button class="button primary" type="button" data-skill-hub-action="create-realtime" data-rule-kind="keyword_reply">新建关键词回复</button><button class="button" type="button" data-skill-hub-action="create-realtime" data-rule-kind="group_monitor">新建群消息监听</button><button class="button" type="button" data-skill-hub-action="create-validation">账号连接检测</button></div>${realtimeRulesMarkup(rules)}</div>`;
  } catch (error) {
    if (section.isConnected) section.innerHTML = `<div class="card-body"><div class="notice danger"><span aria-hidden="true">!</span><span>${escapeHtml(error.message)}</span></div></div>`;
  } finally {
    taskSectionLoading = false;
  }
}

async function ruleById(id) {
  const section = document.querySelector("[data-skill-hub-realtime-tasks]");
  const cached = Array.isArray(section?._rules) ? section._rules.find((rule) => String(rule.id) === String(id)) : null;
  if (cached) return cached;
  const rules = listFrom(await request("/api/v1/admin/realtime-rules"), ["rules"]);
  return rules.find((rule) => String(rule.id) === String(id)) || null;
}

async function toggleRule(button) {
  button.disabled = true;
  try {
    await request(`/api/v1/admin/realtime-rules/${encodeURIComponent(button.dataset.id)}`, {
      method: "PATCH",
      body: { enabled: button.dataset.enabled !== "true" },
    });
    notify("任务状态已更新");
    await renderRealtimeTaskSection({ force: true });
  } catch (error) {
    button.disabled = false;
    notify("更新失败", error.message, "error");
  }
}

async function deleteRule(button) {
  if (!window.confirm("确认删除这个 24 小时任务？")) return;
  button.disabled = true;
  try {
    await request(`/api/v1/admin/realtime-rules/${encodeURIComponent(button.dataset.id)}`, { method: "DELETE" });
    notify("任务已删除");
    await renderRealtimeTaskSection({ force: true });
  } catch (error) {
    button.disabled = false;
    notify("删除失败", error.message, "error");
  }
}

async function refresh() {
  ensureCapabilityCards();
  applyPendingScheduledDraft();
  await renderRealtimeTaskSection();
}

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-skill-hub-action]");
  if (!button) return;
  const action = button.dataset.skillHubAction;
  if (action === "close-modal") return closeHubModal();
  if (action === "create-scheduled") return openScheduledDraft(button.dataset.skillKey || "send_text");
  if (action === "create-inspection") return openScheduledDraft("tg_signer", { focusInspection: true });
  if (action === "create-realtime") return openRealtimeTask(button.dataset.ruleKind || "keyword_reply");
  if (action === "create-validation") return openValidationTask();
  if (action === "refresh-rules") return renderRealtimeTaskSection({ force: true });
  if (action === "toggle-rule") return toggleRule(button);
  if (action === "delete-rule") return deleteRule(button);
  if (action === "edit-rule") {
    try {
      const rule = await ruleById(button.dataset.id);
      if (rule) return openRealtimeTask(rule.kind, rule);
      notify("没有找到任务", "请刷新页面后重试。", "error");
    } catch (error) {
      notify("无法读取任务", error.message, "error");
    }
  }
});

document.addEventListener("submit", (event) => {
  if (event.target.id === "skill-hub-realtime-form") {
    event.preventDefault();
    submitRealtimeTask(event.target);
  }
  if (event.target.id === "skill-hub-validation-form") {
    event.preventDefault();
    submitValidationTask(event.target);
  }
});

document.addEventListener("click", (event) => {
  if (event.target.matches("[data-skill-hub-backdrop]")) closeHubModal();
});

let scheduled = false;
const observer = typeof MutationObserver === "undefined" ? null : new MutationObserver(() => {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(async () => {
    scheduled = false;
    await refresh();
  });
});
if (observer) observer.observe(document.body, { childList: true, subtree: true });
window.addEventListener("hashchange", () => queueMicrotask(refresh));
queueMicrotask(refresh);
