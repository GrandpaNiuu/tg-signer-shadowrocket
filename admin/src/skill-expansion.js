const EXPANDED_SKILLS = new Set(["bot_flow", "send_media", "chat_snapshot", "account_audit"]);
const FLOW_ACTIONS = new Set(["send", "wait_message", "read_buttons", "click_button"]);
const TARGET_PATTERN = /^(?:@[A-Za-z][A-Za-z0-9_]{4,31}|-?\d{1,20})$/;
const ASSET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/;
const MAX_FLOW_STEPS = 20;
const MAX_FLOW_TIMEOUT = 600;

const PRESENTATIONS = Object.freeze({
  bot_flow: Object.freeze({
    name: "通用机器人流程",
    shortName: "机器人流程",
    badge: "多步骤",
    icon: "流",
    description: "按受限步骤发送消息、等待回复、读取按钮、点击按钮并确认结果。",
    suitableFor: "需要多轮交互且流程固定的 Telegram 机器人。",
  }),
  send_media: Object.freeze({
    name: "发送媒体",
    shortName: "媒体发送",
    badge: "受控媒体",
    icon: "媒",
    description: "发送经过 Worker 登记校验的图片、文档或视频，并保存 Telegram message_id。",
    suitableFor: "定时发送固定图片、文件或视频。",
  }),
  chat_snapshot: Object.freeze({
    name: "聊天快照",
    shortName: "消息采集",
    badge: "只读",
    icon: "采",
    description: "采集指定聊天最近消息，可按关键词过滤；不调用 AI。",
    suitableFor: "给后台分析或人工检查准备最近聊天文本。",
  }),
  account_audit: Object.freeze({
    name: "账号健康检查",
    shortName: "账号检查",
    badge: "诊断",
    icon: "检",
    description: "检查 Session、get_me、Telegram 身份、代理连接和本次 FloodWait 状态。",
    suitableFor: "定期确认账号是否仍可正常连接 Telegram。",
  }),
});

function text(value) { return String(value ?? ""); }
function trimmed(value) { return text(value).trim(); }
function integer(value, field, min, max) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${field} 必须是 ${min}–${max} 的整数。`);
  }
  return number;
}
function optionalInteger(value, field, min, max) {
  if (value === "" || value === null || value === undefined) return null;
  return integer(value, field, min, max);
}
function requiredText(value, field, max) {
  const output = trimmed(value);
  if (!output || output.length > max) throw new Error(`${field}不能为空且不能超过 ${max} 个字符。`);
  return output;
}
function target(value) {
  const output = requiredText(value, "目标", 128);
  if (!TARGET_PATTERN.test(output)) throw new Error("目标必须是 @用户名、@机器人、频道用户名或数字 Chat ID。");
  return output;
}
function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function parseJsonObject(value) {
  const source = trimmed(value);
  if (!source) return {};
  try {
    const parsed = JSON.parse(source);
    return safeObject(parsed);
  } catch {
    return {};
  }
}
function escapeHtml(value) {
  return text(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

export function normalizeFlowSteps(rawSteps) {
  if (!Array.isArray(rawSteps) || rawSteps.length < 1 || rawSteps.length > MAX_FLOW_STEPS) {
    throw new Error(`机器人流程必须包含 1–${MAX_FLOW_STEPS} 个步骤。`);
  }
  let totalTimeout = 0;
  const steps = rawSteps.map((raw, index) => {
    const input = safeObject(raw);
    const action = requiredText(input.action, `第 ${index + 1} 步动作`, 40);
    if (!FLOW_ACTIONS.has(action)) throw new Error(`第 ${index + 1} 步动作不受支持。`);
    const timeout = integer(input.timeout, `第 ${index + 1} 步超时`, 1, 120);
    totalTimeout += timeout;
    const step = { action, timeout };
    if (action === "send") step.text = requiredText(input.text, `第 ${index + 1} 步消息`, 4000);
    if (action === "click_button") step.button = requiredText(input.button, `第 ${index + 1} 步按钮`, 128);
    if (action === "wait_message") {
      const match = trimmed(input.match);
      const matchAny = Array.isArray(input.match_any)
        ? input.match_any.map((item) => trimmed(item)).filter(Boolean)
        : text(input.match_any).split(/[，,\n]/).map((item) => item.trim()).filter(Boolean);
      if (match.length > 200 || matchAny.some((item) => item.length > 200) || matchAny.length > 20) {
        throw new Error(`第 ${index + 1} 步匹配关键词无效。`);
      }
      if (!match && !matchAny.length) throw new Error(`第 ${index + 1} 步至少填写一个匹配关键词。`);
      if (match) step.match = match;
      if (matchAny.length) step.match_any = matchAny;
    }
    return step;
  });
  if (totalTimeout > MAX_FLOW_TIMEOUT) throw new Error(`所有步骤超时合计不能超过 ${MAX_FLOW_TIMEOUT} 秒。`);
  return steps;
}

export function paramsFromLegacy(skillKey, { bot = "", command = "", threadId = null, deleteAfter = null } = {}) {
  const parsed = parseJsonObject(command);
  if (skillKey === "bot_flow") {
    const source = Array.isArray(parsed.steps) ? parsed : {};
    return {
      target: trimmed(parsed.target || bot),
      steps: Array.isArray(source.steps) ? source.steps : [],
      message_thread_id: parsed.message_thread_id ?? threadId ?? null,
    };
  }
  if (skillKey === "send_media") {
    return {
      target: trimmed(parsed.target || bot),
      file_id: trimmed(parsed.file_id),
      media_type: trimmed(parsed.media_type || "photo"),
      caption: parsed.caption ?? null,
      message_thread_id: parsed.message_thread_id ?? threadId ?? null,
      delete_after: parsed.delete_after ?? deleteAfter ?? null,
    };
  }
  if (skillKey === "chat_snapshot") {
    return {
      target: trimmed(parsed.target || bot),
      limit: Number.isSafeInteger(parsed.limit) ? parsed.limit : 20,
      keyword: parsed.keyword ?? (trimmed(command) && !trimmed(command).startsWith("{") ? trimmed(command) : null),
    };
  }
  return {};
}

export function validateExpandedParams(skillKey, rawParams) {
  const input = safeObject(rawParams);
  if (skillKey === "bot_flow") {
    return {
      target: target(input.target),
      steps: normalizeFlowSteps(input.steps),
      message_thread_id: optionalInteger(input.message_thread_id, "Thread ID", 1, Number.MAX_SAFE_INTEGER),
    };
  }
  if (skillKey === "send_media") {
    const fileId = requiredText(input.file_id, "媒体资产", 160);
    if (!ASSET_ID_PATTERN.test(fileId)) throw new Error("媒体资产 ID 无效，请重新选择已登记媒体。");
    const mediaType = requiredText(input.media_type, "媒体类型", 20);
    if (!["photo", "document", "video"].includes(mediaType)) throw new Error("媒体类型必须是 photo、document 或 video。");
    const caption = input.caption === null || input.caption === undefined || input.caption === ""
      ? null : requiredText(input.caption, "Caption", 1024);
    return {
      target: target(input.target),
      file_id: fileId,
      media_type: mediaType,
      caption,
      message_thread_id: optionalInteger(input.message_thread_id, "Thread ID", 1, Number.MAX_SAFE_INTEGER),
      delete_after: optionalInteger(input.delete_after, "Delete After", 0, 86400),
    };
  }
  if (skillKey === "chat_snapshot") {
    const keyword = input.keyword === null || input.keyword === undefined || input.keyword === ""
      ? null : requiredText(input.keyword, "关键词", 200);
    return { target: target(input.target), limit: integer(input.limit ?? 20, "采集数量", 1, 50), keyword };
  }
  if (skillKey === "account_audit") return {};
  throw new Error("当前任务类型不属于扩展 Skill。");
}

function actionLabel(action) {
  return ({ send: "发送消息", wait_message: "等待并匹配回复", read_buttons: "读取按钮", click_button: "点击按钮" })[action] || action;
}
function stepPayloadMarkup(step) {
  if (step.action === "send") {
    return `<div class="field span-2"><label class="required">发送内容</label><textarea data-flow-value="text" maxlength="4000" placeholder="例如：/start">${escapeHtml(step.text || "")}</textarea></div>`;
  }
  if (step.action === "wait_message") {
    return `<div class="field"><label>必须包含</label><input data-flow-value="match" maxlength="200" value="${escapeHtml(step.match || "")}" placeholder="例如：签到"></div>
      <div class="field"><label>任一关键词</label><textarea data-flow-value="match_any" maxlength="2000" placeholder="成功, 完成">${escapeHtml((step.match_any || []).join(", "))}</textarea></div>`;
  }
  if (step.action === "click_button") {
    return `<div class="field span-2"><label class="required">按钮文字</label><input data-flow-value="button" maxlength="128" value="${escapeHtml(step.button || "")}" placeholder="例如：每日签到"></div>`;
  }
  return `<div class="notice span-2"><span aria-hidden="true">i</span><span>读取当前回复中的 Callback 按钮，并写入步骤日志，不执行 URL、支付、WebApp 或登录按钮。</span></div>`;
}
function flowStepMarkup(step, index) {
  const action = FLOW_ACTIONS.has(step.action) ? step.action : "send";
  return `<article class="skill-flow-step" data-flow-step>
    <header><strong>步骤 <span data-flow-number>${index + 1}</span></strong><button class="button small ghost danger" type="button" data-skill-action="remove-step">删除</button></header>
    <div class="form-grid">
      <div class="field"><label class="required">动作</label><select data-flow-value="action">${[...FLOW_ACTIONS].map((item) => `<option value="${item}" ${item === action ? "selected" : ""}>${actionLabel(item)}</option>`).join("")}</select></div>
      <div class="field"><label class="required">单步超时（秒）</label><input data-flow-value="timeout" type="number" min="1" max="120" value="${escapeHtml(step.timeout ?? 30)}"></div>
      <div class="form-grid span-2" data-flow-payload>${stepPayloadMarkup({ ...step, action })}</div>
    </div>
  </article>`;
}
function defaultFlowSteps() {
  return [
    { action: "send", text: "/start", timeout: 20 },
    { action: "wait_message", match_any: ["签到", "领取"], timeout: 30 },
    { action: "click_button", button: "签到", timeout: 20 },
    { action: "wait_message", match_any: ["成功", "完成", "已签到"], timeout: 30 },
  ];
}
function fieldValue(form, selector) { return form.querySelector(selector)?.value ?? ""; }
function formControl(form, name) { return form.elements.namedItem(name); }
function fieldContainer(form, selector) { return form.querySelector(selector)?.closest(".field") || null; }
function setHidden(element, hidden) { if (element && element.hidden !== hidden) element.hidden = hidden; }
function statusNode(builder) { return builder.querySelector("[data-skill-status]"); }
function setStatus(builder, message, kind = "") {
  const node = statusNode(builder);
  if (!node) return;
  node.textContent = message || "";
  node.className = `field-help skill-expansion-status${kind ? ` ${kind}` : ""}`;
}

async function apiRequest(path, { method = "GET", body } = {}) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    headers: { accept: "application/json", "content-type": "application/json", "x-requested-with": "tg-checkin-admin" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok) throw new Error(payload?.error?.message || "请求未完成，请稍后重试。");
  return payload?.data ?? payload ?? null;
}

const taskParamsCache = new Map();
let mediaAssetsCache = null;
async function loadTaskParams(taskId) {
  if (!taskId) return null;
  if (!taskParamsCache.has(taskId)) {
    taskParamsCache.set(taskId, apiRequest(`/api/v1/tasks/${encodeURIComponent(taskId)}`).then((task) => safeObject(task?.params)));
  }
  return taskParamsCache.get(taskId);
}
async function loadMediaAssets({ refresh = false } = {}) {
  if (refresh || !mediaAssetsCache) {
    mediaAssetsCache = apiRequest("/api/v1/media-assets?limit=100").then((payload) => Array.isArray(payload) ? payload : []);
  }
  return mediaAssetsCache;
}

function builderShell() {
  return `<section class="skill-expansion-builder" data-skill-builder><div data-skill-builder-content></div><p class="field-help skill-expansion-status" data-skill-status aria-live="polite"></p></section>`;
}
function ensureBuilder(form) {
  let wrapper = form.querySelector("[data-skill-expansion]");
  if (wrapper) return wrapper;
  wrapper = document.createElement("div");
  wrapper.className = "field span-2";
  wrapper.dataset.skillExpansion = "true";
  wrapper.innerHTML = builderShell();
  const signer = fieldContainer(form, "#task-signer-import");
  if (signer) signer.insertAdjacentElement("afterend", wrapper);
  else form.querySelector(".form-grid")?.append(wrapper);
  return wrapper;
}
function legacySnapshot(form) {
  return {
    bot: fieldValue(form, "#task-bot"),
    command: fieldValue(form, "#task-command"),
    threadId: fieldValue(form, "#task-thread"),
    deleteAfter: fieldValue(form, "#task-delete-after"),
  };
}

function botFlowMarkup(params) {
  const steps = Array.isArray(params.steps) && params.steps.length ? params.steps : defaultFlowSteps();
  return `<div class="notice mb-sm"><span aria-hidden="true">✓</span><span>只允许固定 Telegram 动作，不执行 Python、Shell、URL 按钮、支付按钮或 WebApp。每一步都必须设置超时，最多 ${MAX_FLOW_STEPS} 步。</span></div>
    <div class="field"><label class="required" for="skill-flow-target">机器人目标</label><input id="skill-flow-target" data-skill-field="target" maxlength="128" value="${escapeHtml(params.target || "")}" placeholder="@example_bot"></div>
    <div class="skill-flow-list" data-flow-list>${steps.map(flowStepMarkup).join("")}</div>
    <button class="button small" type="button" data-skill-action="add-step">+ 添加步骤</button>`;
}
function mediaOptions(assets, selected) {
  if (!assets.length) return '<option value="">暂无已登记媒体</option>';
  return `<option value="">请选择</option>${assets.map((asset) => `<option value="${escapeHtml(asset.id)}" data-media-type="${escapeHtml(asset.media_type)}" ${String(selected || "") === String(asset.id) ? "selected" : ""}>${escapeHtml(asset.name)} · ${escapeHtml(asset.media_type)} · ${escapeHtml(asset.source_chat_id)} / ${escapeHtml(asset.source_message_id)}</option>`).join("")}`;
}
function sendMediaMarkup(params, assets) {
  return `<div class="notice mb-sm"><span aria-hidden="true">i</span><span>不能填写服务器路径或任意 URL。媒体必须先登记为 Worker 管理的 Telegram 源消息，再由 Runner 读取并发送。</span></div>
    <div class="form-grid">
      <div class="field"><label class="required" for="skill-media-target">发送目标</label><input id="skill-media-target" data-skill-field="target" maxlength="128" value="${escapeHtml(params.target || "")}" placeholder="@channel 或 Chat ID"></div>
      <div class="field"><label class="required" for="skill-media-asset">已登记媒体</label><select id="skill-media-asset" data-skill-field="file_id">${mediaOptions(assets, params.file_id)}</select></div>
      <div class="field span-2"><label for="skill-media-caption">Caption</label><textarea id="skill-media-caption" data-skill-field="caption" maxlength="1024" placeholder="可选">${escapeHtml(params.caption || "")}</textarea></div>
    </div>
    <details class="skill-media-register"><summary class="field-label">登记新的 Telegram 媒体源</summary><div class="form-grid">
      <div class="field"><label>名称</label><input data-media-register="name" maxlength="100" placeholder="例如：每日海报"></div>
      <div class="field"><label>类型</label><select data-media-register="media_type"><option value="photo">photo 图片</option><option value="document">document 文档</option><option value="video">video 视频</option></select></div>
      <div class="field"><label>源 Chat ID / @用户名</label><input data-media-register="source_chat_id" maxlength="128" placeholder="@source_channel 或 -100..."></div>
      <div class="field"><label>源 Message ID</label><input data-media-register="source_message_id" type="number" min="1" placeholder="123"></div>
      <div class="field span-2"><button class="button small" type="button" data-skill-action="register-media">登记并选择</button><button class="button small ghost danger" type="button" data-skill-action="delete-media">删除当前资产</button></div>
    </div></details>`;
}
function snapshotMarkup(params) {
  return `<div class="notice mb-sm"><span aria-hidden="true">i</span><span>只采集消息文本和 Caption，不下载附件，也不会调用 AI。执行结果保存在当前用户的执行记录中。</span></div>
    <div class="form-grid">
      <div class="field"><label class="required" for="skill-snapshot-target">聊天目标</label><input id="skill-snapshot-target" data-skill-field="target" maxlength="128" value="${escapeHtml(params.target || "")}" placeholder="@group 或 Chat ID"></div>
      <div class="field"><label class="required" for="skill-snapshot-limit">最近消息数量</label><input id="skill-snapshot-limit" data-skill-field="limit" type="number" min="1" max="50" value="${escapeHtml(params.limit ?? 20)}"></div>
      <div class="field span-2"><label for="skill-snapshot-keyword">关键词过滤</label><input id="skill-snapshot-keyword" data-skill-field="keyword" maxlength="200" value="${escapeHtml(params.keyword || "")}" placeholder="可选；只保留包含此文字的消息"></div>
    </div>`;
}
function auditMarkup() {
  return `<div class="notice"><span aria-hidden="true">✓</span><span>该任务不需要目标或命令。执行时检查当前所选 Telegram 账号的 Session、get_me、身份信息、代理连接和本次是否触发 FloodWait；不会回传代理地址或密码。</span></div>`;
}

function collectFlowRows(form) {
  return [...form.querySelectorAll("[data-flow-step]")].map((row) => {
    const action = fieldValue(row, '[data-flow-value="action"]');
    const step = { action, timeout: Number(fieldValue(row, '[data-flow-value="timeout"]')) };
    if (action === "send") step.text = fieldValue(row, '[data-flow-value="text"]');
    if (action === "wait_message") {
      step.match = fieldValue(row, '[data-flow-value="match"]');
      step.match_any = fieldValue(row, '[data-flow-value="match_any"]');
    }
    if (action === "click_button") step.button = fieldValue(row, '[data-flow-value="button"]');
    return step;
  });
}
function collectParams(form, skillKey) {
  if (skillKey === "bot_flow") {
    return validateExpandedParams(skillKey, {
      target: fieldValue(form, '[data-skill-field="target"]'),
      steps: collectFlowRows(form),
      message_thread_id: fieldValue(form, "#task-thread"),
    });
  }
  if (skillKey === "send_media") {
    const select = form.querySelector('[data-skill-field="file_id"]');
    const option = select?.selectedOptions?.[0];
    return validateExpandedParams(skillKey, {
      target: fieldValue(form, '[data-skill-field="target"]'),
      file_id: select?.value || "",
      media_type: option?.dataset?.mediaType || "",
      caption: fieldValue(form, '[data-skill-field="caption"]'),
      message_thread_id: fieldValue(form, "#task-thread"),
      delete_after: fieldValue(form, "#task-delete-after"),
    });
  }
  if (skillKey === "chat_snapshot") {
    return validateExpandedParams(skillKey, {
      target: fieldValue(form, '[data-skill-field="target"]'),
      limit: Number(fieldValue(form, '[data-skill-field="limit"]')),
      keyword: fieldValue(form, '[data-skill-field="keyword"]'),
    });
  }
  return validateExpandedParams(skillKey, {});
}
function commonTaskPayload(form, skillKey, params) {
  const data = new FormData(form);
  const optional = (name) => data.get(name) === "" ? null : Number(data.get(name));
  return {
    name: trimmed(data.get("name")),
    account_id: trimmed(data.get("account_id")),
    skill_key: skillKey,
    params,
    cron: trimmed(data.get("cron")),
    timezone: trimmed(data.get("timezone")),
    retry: Number(data.get("retry")),
    timeout_seconds: Number(data.get("timeout_seconds")),
    thread_id: optional("thread_id"),
    delete_after_seconds: optional("delete_after_seconds"),
    enabled: data.get("enabled") === "on",
  };
}
function validateCommonPayload(payload) {
  if (!payload.name || payload.name.length > 100) throw new Error("请输入 1–100 个字符的任务名称。");
  if (!payload.account_id) throw new Error("请选择 Telegram 账号。");
  if (!payload.cron || payload.cron.length > 96) throw new Error("执行时间无效。");
  if (!payload.timezone || payload.timezone.length > 64) throw new Error("请选择时区。");
  integer(payload.retry, "重试次数", 0, 5);
  integer(payload.timeout_seconds, "任务超时", 10, 900);
  let retryDelay = 0;
  for (let index = 0; index < payload.retry; index += 1) retryDelay += Math.min(60, 2 * (2 ** index));
  if (payload.timeout_seconds * (payload.retry + 1) + retryDelay > 900) throw new Error("Timeout 与 Retry 的最坏执行时间必须不超过 900 秒。");
  if (payload.skill_key === "send_media" && payload.delete_after_seconds !== null
    && payload.delete_after_seconds >= payload.timeout_seconds - 10) {
    throw new Error("Delete After 必须至少比任务超时短 10 秒。");
  }
}

async function renderBuilder(form, skillKey, params, { refreshAssets = false } = {}) {
  const wrapper = ensureBuilder(form);
  const content = wrapper.querySelector("[data-skill-builder-content]");
  let markup = "";
  if (skillKey === "bot_flow") markup = botFlowMarkup(params);
  if (skillKey === "send_media") markup = sendMediaMarkup(params, await loadMediaAssets({ refresh: refreshAssets }));
  if (skillKey === "chat_snapshot") markup = snapshotMarkup(params);
  if (skillKey === "account_audit") markup = auditMarkup();
  content.innerHTML = markup;
  wrapper.hidden = false;
  form.dataset.skillExpansionRendered = `${skillKey}:${form.dataset.id || "new"}`;
}
function configureLegacyFields(form, skillKey) {
  const targetField = fieldContainer(form, "#task-bot");
  const commandField = fieldContainer(form, "#task-command");
  const signerField = fieldContainer(form, "#task-signer-import");
  const threadField = fieldContainer(form, "#task-thread");
  const deleteField = fieldContainer(form, "#task-delete-after");
  const expanded = EXPANDED_SKILLS.has(skillKey);
  setHidden(targetField, expanded);
  setHidden(commandField, expanded);
  setHidden(signerField, skillKey !== "tg_signer");
  setHidden(threadField, !["send_text", "bot_flow", "send_media"].includes(skillKey));
  setHidden(deleteField, !["send_text", "send_media"].includes(skillKey));
  const wrapper = ensureBuilder(form);
  setHidden(wrapper, !expanded);
}

async function hydrateForm(form) {
  const skillKey = fieldValue(form, "#task-skill");
  configureLegacyFields(form, skillKey);
  if (!EXPANDED_SKILLS.has(skillKey)) return;
  const renderKey = `${skillKey}:${form.dataset.id || "new"}`;
  if (form.dataset.skillExpansionRendered === renderKey) return;
  const legacy = paramsFromLegacy(skillKey, legacySnapshot(form));
  await renderBuilder(form, skillKey, legacy);
  const taskId = form.dataset.id;
  if (taskId) {
    try {
      const stored = await loadTaskParams(taskId);
      if (form.isConnected && fieldValue(form, "#task-skill") === skillKey) await renderBuilder(form, skillKey, stored);
    } catch (error) {
      setStatus(ensureBuilder(form), error.message, "error");
    }
  }
}

function updateSkillCopy() {
  const select = document.querySelector("#task-skill");
  if (select) {
    for (const option of select.options) {
      const presentation = PRESENTATIONS[option.value];
      if (presentation && option.textContent !== presentation.name) option.textContent = presentation.name;
    }
  }
  for (const card of document.querySelectorAll(".skill-card")) {
    const key = card.querySelector(".skill-meta strong.mono")?.textContent?.trim();
    const presentation = PRESENTATIONS[key];
    if (!presentation) continue;
    const title = card.querySelector("h2");
    const icon = card.querySelector(".skill-icon");
    const badge = card.querySelector(".skill-card-head .badge");
    const description = card.querySelector(":scope > p");
    if (title && title.textContent !== presentation.name) title.textContent = presentation.name;
    if (icon && icon.textContent !== presentation.icon) icon.textContent = presentation.icon;
    if (badge && !badge.classList.contains("disabled") && badge.textContent !== presentation.badge) badge.textContent = presentation.badge;
    if (description && description.textContent !== presentation.description) description.textContent = presentation.description;
  }
}

function collectUnvalidatedParams(form) {
  const select = form.querySelector('[data-skill-field="file_id"]');
  return {
    target: fieldValue(form, '[data-skill-field="target"]'),
    file_id: select?.value || "",
    media_type: select?.selectedOptions?.[0]?.dataset?.mediaType || "photo",
    caption: fieldValue(form, '[data-skill-field="caption"]'),
  };
}
async function registerMediaAsset(form, button) {
  const builder = ensureBuilder(form);
  button.disabled = true;
  try {
    const body = {
      name: requiredText(fieldValue(form, '[data-media-register="name"]'), "媒体名称", 100),
      media_type: requiredText(fieldValue(form, '[data-media-register="media_type"]'), "媒体类型", 20),
      source_chat_id: target(fieldValue(form, '[data-media-register="source_chat_id"]')),
      source_message_id: integer(fieldValue(form, '[data-media-register="source_message_id"]'), "源 Message ID", 1, Number.MAX_SAFE_INTEGER),
    };
    const asset = await apiRequest("/api/v1/media-assets", { method: "POST", body });
    mediaAssetsCache = null;
    const current = collectUnvalidatedParams(form);
    current.file_id = asset.id;
    current.media_type = asset.media_type;
    await renderBuilder(form, "send_media", current, { refreshAssets: true });
    setStatus(ensureBuilder(form), "媒体已登记并选中。", "success");
  } catch (error) {
    setStatus(builder, error.message, "error");
  } finally {
    button.disabled = false;
  }
}
async function deleteMediaAsset(form, button) {
  const builder = ensureBuilder(form);
  const id = fieldValue(form, '[data-skill-field="file_id"]');
  if (!id) return setStatus(builder, "请先选择要删除的媒体资产。", "error");
  button.disabled = true;
  try {
    await apiRequest(`/api/v1/media-assets/${encodeURIComponent(id)}`, { method: "DELETE" });
    mediaAssetsCache = null;
    const current = collectUnvalidatedParams(form);
    current.file_id = "";
    await renderBuilder(form, "send_media", current, { refreshAssets: true });
    setStatus(ensureBuilder(form), "媒体资产已删除。", "success");
  } catch (error) {
    setStatus(builder, error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function submitExpandedTask(event, form) {
  const skillKey = fieldValue(form, "#task-skill");
  if (!EXPANDED_SKILLS.has(skillKey)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const builder = ensureBuilder(form);
  const button = document.querySelector('button[type="submit"][form="task-form"]');
  if (button) { button.disabled = true; button.textContent = "正在保存…"; }
  try {
    const params = collectParams(form, skillKey);
    const payload = commonTaskPayload(form, skillKey, params);
    validateCommonPayload(payload);
    const id = form.dataset.id;
    await apiRequest(id ? `/api/v1/tasks/${encodeURIComponent(id)}` : "/api/v1/tasks", {
      method: id ? "PATCH" : "POST",
      body: payload,
    });
    setStatus(builder, id ? "任务已更新。" : "任务已创建。", "success");
    window.location.reload();
  } catch (error) {
    setStatus(builder, error.message, "error");
    if (button) { button.disabled = false; button.textContent = "保存任务"; }
  }
}

let observer = null;
let scheduled = false;
async function applyExpansion() {
  if (typeof document === "undefined") return;
  observer?.disconnect();
  try {
    updateSkillCopy();
    const form = document.querySelector("#task-form");
    if (form) await hydrateForm(form);
  } finally {
    observer?.observe(document.body, { childList: true, subtree: true });
  }
}
function scheduleApply() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(async () => {
    scheduled = false;
    await applyExpansion();
  });
}

if (typeof document !== "undefined") {
  observer = new MutationObserver(scheduleApply);
  document.addEventListener("change", (event) => {
    const form = event.target?.closest?.("#task-form");
    if (!form) return;
    if (event.target.matches("#task-skill")) {
      delete form.dataset.skillExpansionRendered;
      scheduleApply();
    }
    if (event.target.matches('[data-flow-value="action"]')) {
      const payload = event.target.closest("[data-flow-step]")?.querySelector("[data-flow-payload]");
      if (payload) payload.innerHTML = stepPayloadMarkup({ action: event.target.value });
    }
  });
  document.addEventListener("click", (event) => {
    const button = event.target?.closest?.("[data-skill-action]");
    const form = button?.closest?.("#task-form");
    if (!button || !form) return;
    const action = button.dataset.skillAction;
    if (action === "add-step") {
      const list = form.querySelector("[data-flow-list]");
      const count = list?.querySelectorAll("[data-flow-step]").length || 0;
      if (count >= MAX_FLOW_STEPS) return setStatus(ensureBuilder(form), `最多只能添加 ${MAX_FLOW_STEPS} 个步骤。`, "error");
      list?.insertAdjacentHTML("beforeend", flowStepMarkup({ action: "send", text: "", timeout: 30 }, count));
    }
    if (action === "remove-step") {
      const rows = form.querySelectorAll("[data-flow-step]");
      if (rows.length <= 1) return setStatus(ensureBuilder(form), "机器人流程至少保留一个步骤。", "error");
      button.closest("[data-flow-step]")?.remove();
      [...form.querySelectorAll("[data-flow-number]")].forEach((node, index) => { node.textContent = String(index + 1); });
    }
    if (action === "register-media") registerMediaAsset(form, button);
    if (action === "delete-media") deleteMediaAsset(form, button);
  });
  document.addEventListener("submit", (event) => {
    const form = event.target?.closest?.("#task-form");
    if (form) submitExpandedTask(event, form);
  }, true);
  window.addEventListener("hashchange", scheduleApply);
  scheduleApply();
}

export const __test = {
  ASSET_ID_PATTERN,
  EXPANDED_SKILLS,
  FLOW_ACTIONS,
  MAX_FLOW_STEPS,
  MAX_FLOW_TIMEOUT,
  PRESENTATIONS,
};
