import {
  REALTIME_AUTOMATIONS,
  SCHEDULED_AUTOMATIONS,
  automationDefinition,
} from "./automation-catalog.js";

let pendingScheduledDraft = null;
let pendingScheduledTimer = null;
let ruleSectionLoading = false;

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
  element.innerHTML = `<span aria-hidden="true">${kind === "error" ? "!" : "✓"}</span><div><strong>${escapeHtml(title)}</strong>${message ? `<span>${escapeHtml(message)}</span>` : ""}</div>`;
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
  return card.dataset.automationKey || card.querySelector(".skill-meta strong.mono")?.textContent.trim() || "";
}

function addScheduledActions() {
  for (const card of document.querySelectorAll(".skill-grid .skill-card:not([data-skill-hub-capability])")) {
    if (card.querySelector("[data-skill-hub-existing-action]")) continue;
    const key = existingSkillKey(card);
    const definition = automationDefinition(key);
    if (!definition || !SCHEDULED_AUTOMATIONS.includes(key)) continue;
    const disabled = Boolean(card.querySelector(".badge.disabled"));
    const actions = document.createElement("div");
    actions.className = "actions mt-md";
    actions.dataset.skillHubExistingAction = "true";
    actions.innerHTML = `<button class="button primary" type="button" data-skill-hub-action="create-scheduled" data-skill-key="${escapeHtml(key)}" ${disabled ? "disabled" : ""}>${escapeHtml(definition.actionLabel)}</button>`;
    card.append(actions);
  }
}

function capabilityCard(definition) {
  return `<article class="skill-card" data-automation-key="${escapeHtml(definition.key)}" data-skill-hub-capability="${escapeHtml(definition.key)}">
    <div class="skill-card-head"><div><div class="skill-icon" aria-hidden="true">${escapeHtml(definition.icon)}</div><h2>${escapeHtml(definition.title)}</h2></div><span class="badge enabled">${escapeHtml(definition.badge)}</span></div>
    <p>${escapeHtml(definition.description)}</p>
    <div class="notice"><span aria-hidden="true">i</span><span><strong>适合：</strong>${escapeHtml(definition.purpose)}</span></div>
    <div class="skill-meta"><span>运行方式<strong>${escapeHtml(definition.execution)}</strong></span><span>需要填写<strong>${escapeHtml(definition.required)}</strong></span></div>
    <div class="actions mt-md"><button class="button primary" type="button" data-skill-hub-action="create-realtime" data-rule-kind="${escapeHtml(definition.key)}">${escapeHtml(definition.actionLabel)}</button></div>
  </article>`;
}

function ensureCapabilityCards() {
  const grid = document.querySelector(".skill-grid");
  if (!grid) return;
  addScheduledActions();
  for (const key of REALTIME_AUTOMATIONS) {
    const definition = automationDefinition(key);
    if (!definition || definition.audience === "admin" && !isAdministrator()) continue;
    if (grid.querySelector(`[data-skill-hub-capability="${key}"]`)) continue;
    grid.insertAdjacentHTML("beforeend", capabilityCard(definition));
  }
  if (!isAdministrator()) {
    grid.querySelectorAll("[data-skill-hub-capability]").forEach((card) => card.remove());
  }
}

function schedulePendingDraftAttempt(delay = 60) {
  clearTimeout(pendingScheduledTimer);
  pendingScheduledTimer = setTimeout(applyPendingScheduledDraft, delay);
}

function openScheduledDraft(skillKey, { focusInspection = false } = {}) {
  pendingScheduledDraft = { skillKey, focusInspection, startedAt: Date.now() };
  if (!String(location.hash).startsWith("#/tasks")) location.hash = "#/tasks";
  schedulePendingDraftAttempt(0);
}

function applyPendingScheduledDraft() {
  if (!pendingScheduledDraft) return;
  if (Date.now() - pendingScheduledDraft.startedAt > 15_000) {
    pendingScheduledDraft = null;
    notify("无法打开创建窗口", "页面加载超时，请到“自动消息”页面重试。", "error");
    return;
  }
  if (!String(location.hash).startsWith("#/tasks")) {
    schedulePendingDraftAttempt();
    return;
  }
  let form = document.querySelector("#task-form");
  if (!form) {
    const addButton = document.querySelector('[data-action="add-task"]');
    if (addButton && !addButton.disabled) addButton.click();
    form = document.querySelector("#task-form");
  }
  const select = form?.querySelector("#task-skill");
  const option = select && [...select.options].find((item) => item.value === pendingScheduledDraft.skillKey && !item.disabled);
  if (!form || !select || !option) {
    schedulePendingDraftAttempt();
    return;
  }
  select.value = pendingScheduledDraft.skillKey;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  const name = form.querySelector("#task-name");
  const definition = automationDefinition(pendingScheduledDraft.skillKey);
  if (name && !name.value.trim() && definition?.defaultName) name.value = definition.defaultName;
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

function triggerModeLabel(mode) {
  return ({
    keyword: "消息包含关键词",
    reply_to_own: "回复我发送的消息",
    keyword_or_reply_to_own: "关键词或回复我的消息",
  })[mode] || "消息包含关键词";
}

function triggerModeOptions(selected = "keyword") {
  return ["keyword", "reply_to_own", "keyword_or_reply_to_own"]
    .map((mode) => `<option value="${mode}" ${mode === selected ? "selected" : ""}>${triggerModeLabel(mode)}</option>`)
    .join("");
}

function syncRealtimeTriggerForm(form) {
  if (!form || form.dataset.kind !== "keyword_reply") return;
  const mode = form.querySelector("#hub-rule-trigger")?.value || "keyword";
  const keywordField = form.querySelector("[data-realtime-keyword-field]");
  const caseField = form.querySelector("[data-realtime-case-field]");
  const keyword = form.querySelector("#hub-rule-keyword");
  const keywordOnly = mode === "reply_to_own";
  if (keywordField) keywordField.hidden = keywordOnly;
  if (caseField) caseField.hidden = keywordOnly;
  if (keyword) keyword.required = !keywordOnly;
}

function realtimeFormMarkup(kind, accounts, rule = null) {
  const keywordReply = kind === "keyword_reply";
  const triggerMode = rule?.trigger_mode || "keyword";
  return `<form id="skill-hub-realtime-form" data-id="${escapeHtml(rule?.id || "")}" data-kind="${escapeHtml(kind)}" novalidate><div class="form-grid">
    <div class="field span-2"><label class="required" for="hub-rule-name">规则名称</label><input id="hub-rule-name" name="name" maxlength="100" required value="${escapeHtml(rule?.name || "")}" placeholder="${keywordReply ? "例如：价格咨询自动回复" : "例如：采购关键词监控"}"></div>
    <div class="field"><label class="required" for="hub-rule-account">Telegram 账号</label><select id="hub-rule-account" name="account_id" required>${accountOptions(accounts, rule?.account_id)}</select></div>
    ${keywordReply ? `<div class="field"><label class="required" for="hub-rule-trigger">触发条件</label><select id="hub-rule-trigger" name="trigger_mode" required>${triggerModeOptions(triggerMode)}</select></div>` : ""}
    <div class="field" data-realtime-case-field><label for="hub-rule-case">匹配方式</label><select id="hub-rule-case" name="case_sensitive"><option value="false" ${rule?.case_sensitive ? "" : "selected"}>不区分大小写</option><option value="true" ${rule?.case_sensitive ? "selected" : ""}>区分大小写</option></select></div>
    <div class="field span-2"><label class="required" for="hub-rule-chat">监听范围</label><input id="hub-rule-chat" name="chat_selector" maxlength="128" required value="${escapeHtml(rule?.chat_selector || "*")}" placeholder="*、@群组用户名或数字 Chat ID"><p class="field-help">填写 * 表示该账号收到的所有适用会话。</p></div>
    <div class="field span-2" data-realtime-keyword-field><label ${keywordReply ? 'class="required"' : ""} for="hub-rule-keyword">关键词</label><input id="hub-rule-keyword" name="keyword" maxlength="200" ${keywordReply && triggerMode !== "reply_to_own" ? "required" : ""} value="${escapeHtml(rule?.keyword || "")}" placeholder="${keywordReply ? "例如：价格、客服" : "可留空监控全部消息"}"></div>
    ${keywordReply ? `<div class="field span-2"><div class="notice"><span aria-hidden="true">i</span><span>选择“回复我发送的消息”后，只要群成员使用 Telegram 的“回复”功能回复所选账号发出的消息，就会触发；无需关键词。</span></div></div><div class="field span-2"><label class="required" for="hub-rule-response">自动回复内容</label><textarea id="hub-rule-response" name="response_text" maxlength="2000" required placeholder="触发后发送的固定回复">${escapeHtml(rule?.response_text || "")}</textarea></div>` : ""}
    <div class="field span-2"><div class="notice"><span aria-hidden="true">✓</span><span><strong>每次命中都会由通知机器人汇报</strong><br>回执包含用户、规则、账号、会话、发送者、消息摘要${keywordReply ? "和实际回复内容" : ""}。</span></div></div>
    <div class="field span-2"><label class="check-row"><input type="checkbox" name="enabled" ${rule?.enabled === false ? "" : "checked"}>保存后启用规则</label></div>
  </div></form>`;
}

async function openRealtimeRule(kind, rule = null) {
  if (!isAdministrator()) return;
  const definition = automationDefinition(kind);
  if (!definition || !REALTIME_AUTOMATIONS.includes(kind)) return;
  try {
    const accounts = await connectedAccounts();
    if (!accounts.length) {
      notify("没有可用账号", "请先完成 Telegram 手机号登录并确认账号已连接。", "error");
      return;
    }
    openHubModal({
      title: rule ? `编辑${definition.shortName}规则` : definition.actionLabel,
      description: "实时监听服务持续运行，不占用定时任务；命中事件会写入执行记录。",
      body: realtimeFormMarkup(kind, accounts, rule),
      footer: `<span class="field-help">保存后，监听服务会在下一次同步时加载</span><div><button class="button" type="button" data-skill-hub-action="close-modal">取消</button><button class="button primary" type="submit" form="skill-hub-realtime-form">保存规则</button></div>`,
    });
    syncRealtimeTriggerForm(document.querySelector("#skill-hub-realtime-form"));
  } catch (error) {
    notify("无法创建规则", error.message, "error");
  }
}

async function submitRealtimeRule(form) {
  if (!form.checkValidity()) {
    form.reportValidity();
    notify("请完成必填项", "规则名称、Telegram 账号和监听范围不能为空。", "error");
    return;
  }
  const data = new FormData(form);
  const id = form.dataset.id;
  const kind = form.dataset.kind;
  const payload = {
    account_id: String(data.get("account_id") || ""),
    kind,
    name: String(data.get("name") || "").trim(),
    chat_selector: String(data.get("chat_selector") || "*").trim(),
    trigger_mode: kind === "keyword_reply" ? String(data.get("trigger_mode") || "keyword") : "keyword",
    keyword: String(data.get("keyword") || "").trim(),
    response_text: kind === "keyword_reply" ? String(data.get("response_text") || "").trim() : "",
    case_sensitive: data.get("case_sensitive") === "true",
    notify_on_match: true,
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
    notify(id ? "规则已更新" : "规则已创建", "实时监听服务会在下一次同步时加载。", "success");
    await renderRealtimeRuleSection({ force: true });
  } catch (error) {
    notify("保存失败", error.message, "error");
    if (button) {
      button.disabled = false;
      button.textContent = "保存规则";
    }
  }
}

function ruleKindLabel(kind) {
  return automationDefinition(kind)?.shortName || "实时规则";
}

function realtimeRulesMarkup(rules) {
  if (!rules.length) return '<p class="field-help">尚未创建实时自动化规则。</p>';
  return `<div class="service-list">${rules.map((rule) => `<div class="service-row"><div><strong>${escapeHtml(rule.name)}</strong><small>${escapeHtml(rule.account_name || "—")} · ${escapeHtml(ruleKindLabel(rule.kind))} · 范围 ${escapeHtml(rule.chat_selector || "*")}${rule.kind === "keyword_reply" ? ` · ${escapeHtml(triggerModeLabel(rule.trigger_mode || "keyword"))}` : ""}${rule.keyword ? ` · 关键词 ${escapeHtml(rule.keyword)}` : ""}</small><small>每次命中均由通知机器人汇报</small></div><div class="actions"><span class="badge ${rule.enabled ? "success" : "pending"}">${rule.enabled ? "监听中" : "已停用"}</span><button class="button small ghost" type="button" data-skill-hub-action="toggle-rule" data-id="${escapeHtml(rule.id)}" data-enabled="${rule.enabled ? "true" : "false"}">${rule.enabled ? "停用" : "启用"}</button><button class="button small ghost" type="button" data-skill-hub-action="edit-rule" data-id="${escapeHtml(rule.id)}">编辑</button><button class="button small ghost danger" type="button" data-skill-hub-action="delete-rule" data-id="${escapeHtml(rule.id)}">删除</button></div></div>`).join("")}</div>`;
}

async function renderRealtimeRuleSection({ force = false } = {}) {
  if (!isAdministrator() || !String(location.hash).startsWith("#/tasks")) return;
  const taskTable = document.querySelector("#tasks-table");
  const parentCard = taskTable?.closest("section.card");
  if (!parentCard || ruleSectionLoading) return;
  let section = document.querySelector("[data-skill-hub-realtime-tasks]");
  if (!section) {
    section = document.createElement("section");
    section.className = "card mt-md";
    section.dataset.skillHubRealtimeTasks = "true";
    parentCard.insertAdjacentElement("afterend", section);
  }
  if (!force && section.dataset.loaded === "true") return;
  ruleSectionLoading = true;
  section.innerHTML = '<div class="card-body"><p class="field-help">正在加载实时自动化规则…</p></div>';
  try {
    const rules = listFrom(await request("/api/v1/admin/realtime-rules"), ["rules"]);
    if (!section.isConnected) return;
    section.dataset.loaded = "true";
    section._rules = rules;
    const keywordDefinition = automationDefinition("keyword_reply");
    const monitorDefinition = automationDefinition("group_monitor");
    section.innerHTML = `<div class="card-head"><div><h2>实时自动化规则</h2><p>与上方按时间执行的任务不同：这些规则持续监听消息，每次命中都会由通知机器人发送完整回执。</p></div><button class="button small ghost" type="button" data-skill-hub-action="refresh-rules">刷新</button></div><div class="card-body"><div class="actions mb-md"><button class="button primary" type="button" data-skill-hub-action="create-realtime" data-rule-kind="keyword_reply">${escapeHtml(keywordDefinition.actionLabel)}</button><button class="button" type="button" data-skill-hub-action="create-realtime" data-rule-kind="group_monitor">${escapeHtml(monitorDefinition.actionLabel)}</button></div>${realtimeRulesMarkup(rules)}</div>`;
  } catch (error) {
    if (section.isConnected) section.innerHTML = `<div class="card-body"><div class="notice danger"><span aria-hidden="true">!</span><span>${escapeHtml(error.message)}</span></div></div>`;
  } finally {
    ruleSectionLoading = false;
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
    notify("规则状态已更新");
    await renderRealtimeRuleSection({ force: true });
  } catch (error) {
    button.disabled = false;
    notify("更新失败", error.message, "error");
  }
}

async function deleteRule(button) {
  if (!window.confirm("确认删除这条实时自动化规则？")) return;
  button.disabled = true;
  try {
    await request(`/api/v1/admin/realtime-rules/${encodeURIComponent(button.dataset.id)}`, { method: "DELETE" });
    notify("规则已删除");
    await renderRealtimeRuleSection({ force: true });
  } catch (error) {
    button.disabled = false;
    notify("删除失败", error.message, "error");
  }
}

async function refresh() {
  ensureCapabilityCards();
  applyPendingScheduledDraft();
  await renderRealtimeRuleSection();
}

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-skill-hub-action]");
  if (!button) return;
  const action = button.dataset.skillHubAction;
  if (action === "close-modal") return closeHubModal();
  if (action === "create-scheduled") return openScheduledDraft(button.dataset.skillKey || "send_text");
  if (action === "create-realtime") return openRealtimeRule(button.dataset.ruleKind || "keyword_reply");
  if (action === "refresh-rules") return renderRealtimeRuleSection({ force: true });
  if (action === "toggle-rule") return toggleRule(button);
  if (action === "delete-rule") return deleteRule(button);
  if (action === "edit-rule") {
    try {
      const rule = await ruleById(button.dataset.id);
      if (rule) return openRealtimeRule(rule.kind, rule);
      notify("没有找到规则", "请刷新页面后重试。", "error");
    } catch (error) {
      notify("无法读取规则", error.message, "error");
    }
  }
});

document.addEventListener("submit", (event) => {
  if (event.target.id !== "skill-hub-realtime-form") return;
  event.preventDefault();
  submitRealtimeRule(event.target);
});

document.addEventListener("change", (event) => {
  if (event.target.id !== "hub-rule-trigger") return;
  syncRealtimeTriggerForm(event.target.closest("form"));
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
