const EXPANDED_SKILLS = new Set(["send_media"]);
const TARGET_PATTERN = /^(?:@[A-Za-z][A-Za-z0-9_]{4,31}|-?\d{1,20}|me|self)$/i;
const ASSET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/;
const TELEGRAM_HOSTS = new Set(["t.me", "telegram.me"]);

const PRESENTATIONS = Object.freeze({
  send_media: Object.freeze({
    name: "定时发送任意内容",
    shortName: "任意内容",
    badge: "不限制消息类型",
    icon: "发",
    description: "把任意一条 Telegram 消息原样复制到机器人、用户、群组或频道，不限制文字、图片、视频、文件、语音或贴纸。",
    suitableFor: "定时发送海报、视频、文件、语音、贴纸、位置或其他 Telegram 内容。",
    formHelp: "直接指定要复制的 Telegram 消息，不需要登记素材，也不需要选择文件类型。",
  }),
});

function text(value) { return String(value ?? ""); }
function trimmed(value) { return text(value).trim(); }
function safeObject(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function parseJsonObject(value) {
  const source = trimmed(value);
  if (!source) return {};
  try { return safeObject(JSON.parse(source)); } catch { return {}; }
}
function escapeHtml(value) {
  return text(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}
function integer(value, field, min, max) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${field}必须是 ${min}–${max} 的整数。`);
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
function chatTarget(value, field = "目标") {
  const output = requiredText(value, field, 128);
  if (!TARGET_PATTERN.test(output)) throw new Error(`${field}必须是 @用户名、数字 Chat ID 或 me。`);
  return output.toLowerCase() === "self" ? "me" : output;
}

export function parseTelegramMessageLink(value) {
  const source = trimmed(value);
  let url;
  try { url = new URL(source); } catch { throw new Error("Telegram 消息链接格式不正确。"); }
  if (url.protocol === "tg:" && url.hostname.toLowerCase() === "privatepost") {
    const channel = url.searchParams.get("channel") || "";
    const post = url.searchParams.get("post") || "";
    if (!/^\d{1,17}$/.test(channel) || !/^\d+$/.test(post)) {
      throw new Error("Telegram 消息链接缺少频道或消息编号。");
    }
    return { source_chat_id: `-100${channel}`, source_message_id: integer(post, "消息编号", 1, Number.MAX_SAFE_INTEGER) };
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (url.protocol !== "https:" || !TELEGRAM_HOSTS.has(host)) {
    throw new Error("请粘贴以 https://t.me/ 开头的 Telegram 消息链接。");
  }
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "s") parts.shift();
  const message = parts.at(-1) || "";
  if (!/^\d+$/.test(message)) throw new Error("Telegram 消息链接中没有有效的消息编号。");
  if (parts[0] === "c") {
    const channel = parts[1] || "";
    if (!/^\d{1,17}$/.test(channel) || parts.length < 3) throw new Error("私有 Telegram 消息链接格式不正确。");
    return { source_chat_id: `-100${channel}`, source_message_id: integer(message, "消息编号", 1, Number.MAX_SAFE_INTEGER) };
  }
  const username = parts[0] || "";
  if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(username) || parts.length < 2) {
    throw new Error("公开 Telegram 消息链接格式不正确。");
  }
  return { source_chat_id: `@${username}`, source_message_id: integer(message, "消息编号", 1, Number.MAX_SAFE_INTEGER) };
}

function linkForSource(params) {
  const source = trimmed(params.source_chat_id);
  const messageId = Number(params.source_message_id);
  if (!messageId) return "";
  if (source.startsWith("@")) return `https://t.me/${source.slice(1)}/${messageId}`;
  if (/^-100\d+$/.test(source)) return `https://t.me/c/${source.slice(4)}/${messageId}`;
  return "";
}

export function paramsFromLegacy(skillKey, { bot = "", command = "", threadId = null, deleteAfter = null } = {}) {
  if (skillKey !== "send_media") return {};
  const parsed = parseJsonObject(command);
  const directSource = trimmed(parsed.source_chat_id) && parsed.source_message_id !== undefined && parsed.source_message_id !== null
    ? { source_chat_id: trimmed(parsed.source_chat_id), source_message_id: parsed.source_message_id }
    : {};
  return {
    target: trimmed(parsed.target || bot),
    ...directSource,
    file_id: trimmed(parsed.file_id),
    media_type: trimmed(parsed.media_type || "photo"),
    caption: parsed.caption ?? null,
    message_thread_id: parsed.message_thread_id ?? threadId ?? null,
    delete_after: parsed.delete_after ?? deleteAfter ?? null,
  };
}

export function validateExpandedParams(skillKey, rawParams) {
  if (skillKey !== "send_media") throw new Error("当前任务类型不属于任意内容发送任务。");
  const input = safeObject(rawParams);
  const common = {
    target: chatTarget(input.target, "发送目标"),
    caption: input.caption === null || input.caption === undefined ? null : text(input.caption),
    message_thread_id: optionalInteger(input.message_thread_id, "Thread ID", 1, Number.MAX_SAFE_INTEGER),
    delete_after: optionalInteger(input.delete_after, "Delete After", 0, 86400),
  };
  if (common.caption !== null && [...common.caption].length > 1024) throw new Error("附带说明不能超过 1024 个字符。");
  if (trimmed(input.source_link)) return { ...common, ...parseTelegramMessageLink(input.source_link) };
  if (trimmed(input.source_chat_id) || input.source_message_id !== null && input.source_message_id !== undefined && input.source_message_id !== "") {
    return {
      ...common,
      source_chat_id: chatTarget(input.source_chat_id, "来源会话"),
      source_message_id: integer(input.source_message_id, "来源消息编号", 1, Number.MAX_SAFE_INTEGER),
    };
  }
  if (trimmed(input.file_id)) {
    const fileId = requiredText(input.file_id, "旧媒体资产", 160);
    if (!ASSET_ID_PATTERN.test(fileId)) throw new Error("旧媒体资产无效。");
    const mediaType = requiredText(input.media_type, "旧媒体类型", 20);
    if (!["photo", "document", "video"].includes(mediaType)) throw new Error("旧媒体类型无效。");
    return { ...common, file_id: fileId, media_type: mediaType };
  }
  throw new Error("请粘贴 Telegram 消息链接，或展开高级来源填写会话和消息编号。");
}

function fieldValue(form, selector) { return form.querySelector(selector)?.value ?? ""; }
function fieldContainer(form, selector) { return form.querySelector(selector)?.closest(".field") || null; }
function setHidden(element, hidden) { if (element && element.hidden !== hidden) element.hidden = hidden; }
function setTextContentIfChanged(element, value) {
  if (!element || element.textContent === value) return false;
  element.textContent = value;
  return true;
}
function setStatus(builder, message, kind = "") {
  const node = builder.querySelector("[data-skill-status]");
  if (!node) return;
  node.textContent = message || "";
  node.className = `field-help skill-expansion-status${kind ? ` ${kind}` : ""}`;
}
function fieldLabel(field) {
  return ({
    account_id: "Telegram 账号", skill_key: "任务类型", cron: "执行时间", timezone: "时区",
    retry: "重试次数", timeout_seconds: "任务超时", "params.target": "发送目标",
    "params.source_chat_id": "来源会话", "params.source_message_id": "来源消息编号",
    "params.caption": "附带说明", "params.message_thread_id": "Thread ID",
    "params.delete_after": "发送后删除",
  })[field] || field;
}
async function apiRequest(path, { method = "GET", body } = {}) {
  const response = await fetch(path, {
    method, credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer",
    headers: { accept: "application/json", "content-type": "application/json", "x-requested-with": "tg-checkin-admin" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok) {
    const fields = payload?.error?.details?.fields || payload?.error?.fields || [];
    if (Array.isArray(fields) && fields.length) throw new Error(`请检查：${fields.map(fieldLabel).join("、")}。`);
    throw new Error(payload?.error?.message || "请求未完成，请稍后重试。");
  }
  return payload?.data ?? payload ?? null;
}

const taskParamsCache = new Map();
async function loadTaskParams(taskId) {
  if (!taskId) return null;
  if (!taskParamsCache.has(taskId)) {
    taskParamsCache.set(taskId, apiRequest(`/api/v1/tasks/${encodeURIComponent(taskId)}`).then((task) => safeObject(task?.params)));
  }
  return taskParamsCache.get(taskId);
}
function ensureBuilder(form) {
  let wrapper = form.querySelector("[data-skill-expansion]");
  if (wrapper) return wrapper;
  wrapper = document.createElement("div");
  wrapper.className = "field span-2";
  wrapper.dataset.skillExpansion = "true";
  wrapper.innerHTML = '<section class="skill-expansion-builder" data-skill-builder><div data-skill-builder-content></div><p class="field-help skill-expansion-status" data-skill-status aria-live="polite"></p></section>';
  const scheduleAnchor = fieldContainer(form, "#task-schedule-mode");
  if (scheduleAnchor) scheduleAnchor.insertAdjacentElement("beforebegin", wrapper);
  else form.querySelector(".form-grid")?.append(wrapper);
  return wrapper;
}
function ensureSkillHelp(form) {
  const select = form.querySelector("#task-skill");
  if (!select) return null;
  let help = select.parentElement?.querySelector("[data-skill-help]");
  if (!help) {
    help = document.createElement("p");
    help.className = "field-help";
    help.dataset.skillHelp = "true";
    select.insertAdjacentElement("afterend", help);
  }
  return help;
}

function captionMode(params) {
  if (params.caption === "") return "remove";
  if (params.caption !== null && params.caption !== undefined) return "replace";
  return "keep";
}
function sendContentMarkup(params) {
  const legacy = Boolean(params.file_id && !params.source_chat_id);
  return `<div class="skill-purpose">
      <strong>发送什么由你决定</strong>
      <p>系统会复制整条 Telegram 消息，不判断消息类型。文字、相册中的单条内容、图片、视频、文件、音频、语音、贴纸、投票、联系人或位置都使用同一套流程。</p>
    </div>
    ${legacy ? '<div class="notice warning mb-sm"><span aria-hidden="true">!</span><span>这是旧版已登记媒体任务，仍可继续执行。选择新的来源消息后会自动升级为无需登记的任意内容任务。</span></div>' : ""}
    <div class="form-grid">
      <div class="field"><label class="required" for="skill-content-target">发送到哪里</label><input id="skill-content-target" data-skill-field="target" maxlength="128" value="${escapeHtml(params.target || "")}" placeholder="@用户名、Chat ID 或 me"><p class="field-help">机器人、用户、群组、频道或自己的收藏夹。</p></div>
      <div class="field"><label class="required" for="skill-content-link">要发送的 Telegram 消息</label><input id="skill-content-link" data-skill-field="source_link" inputmode="url" value="${escapeHtml(linkForSource(params))}" placeholder="https://t.me/channel/123"><p class="field-help">在 Telegram 中对任意消息选择“复制链接”，无需登记或选择类型。</p></div>
      <details class="field span-2"><summary class="field-label">无法复制链接？填写高级来源</summary><div class="form-grid mt-sm"><div class="field"><label for="skill-source-chat">来源会话</label><input id="skill-source-chat" data-skill-field="source_chat_id" maxlength="128" value="${escapeHtml(params.source_chat_id || "")}" placeholder="@频道、-100... 或 me"></div><div class="field"><label for="skill-source-message">来源消息编号</label><input id="skill-source-message" data-skill-field="source_message_id" type="number" min="1" value="${escapeHtml(params.source_message_id || "")}" placeholder="例如 123"></div></div></details>
      <input type="hidden" data-skill-field="legacy_file_id" value="${escapeHtml(params.file_id || "")}"><input type="hidden" data-skill-field="legacy_media_type" value="${escapeHtml(params.media_type || "photo")}">
      <div class="field"><label for="skill-caption-mode">原消息说明文字</label><select id="skill-caption-mode" data-skill-field="caption_mode"><option value="keep" ${captionMode(params) === "keep" ? "selected" : ""}>保留原说明</option><option value="replace" ${captionMode(params) === "replace" ? "selected" : ""}>替换说明</option><option value="remove" ${captionMode(params) === "remove" ? "selected" : ""}>移除说明</option></select></div>
      <div class="field"><label for="skill-content-caption">新说明 <small>仅“替换说明”时使用</small></label><textarea id="skill-content-caption" data-skill-field="caption" maxlength="1024" placeholder="输入新的说明文字">${escapeHtml(params.caption || "")}</textarea></div>
    </div>`;
}

function legacySnapshot(form) {
  return { bot: fieldValue(form, "#task-bot"), command: fieldValue(form, "#task-command"), threadId: fieldValue(form, "#task-thread"), deleteAfter: fieldValue(form, "#task-delete-after") };
}
function collectParams(form) {
  const mode = fieldValue(form, '[data-skill-field="caption_mode"]');
  const caption = mode === "keep" ? null : mode === "remove" ? "" : requiredText(fieldValue(form, '[data-skill-field="caption"]'), "新说明", 1024);
  return validateExpandedParams("send_media", {
    target: fieldValue(form, '[data-skill-field="target"]'),
    source_link: fieldValue(form, '[data-skill-field="source_link"]'),
    source_chat_id: fieldValue(form, '[data-skill-field="source_chat_id"]'),
    source_message_id: fieldValue(form, '[data-skill-field="source_message_id"]'),
    file_id: fieldValue(form, '[data-skill-field="legacy_file_id"]'),
    media_type: fieldValue(form, '[data-skill-field="legacy_media_type"]'),
    caption,
    message_thread_id: fieldValue(form, "#task-thread"),
    delete_after: fieldValue(form, "#task-delete-after"),
  });
}
function commonTaskPayload(form, params) {
  const data = new FormData(form);
  const optional = (name) => data.get(name) === "" ? null : Number(data.get(name));
  return {
    name: trimmed(data.get("name")), account_id: trimmed(data.get("account_id")), skill_key: "send_media", params,
    cron: trimmed(data.get("cron")), timezone: trimmed(data.get("timezone")), retry: Number(data.get("retry")),
    timeout_seconds: Number(data.get("timeout_seconds")), thread_id: optional("thread_id"),
    delete_after_seconds: optional("delete_after_seconds"), enabled: data.get("enabled") === "on",
  };
}
function validateCommonPayload(payload) {
  if (!payload.name || payload.name.length > 100) throw new Error("请输入 1–100 个字符的任务名称。");
  if (!payload.account_id) throw new Error("请选择执行任务的 Telegram 账号。");
  if (!payload.cron || payload.cron.length > 96) throw new Error("执行时间无效。");
  if (!payload.timezone || payload.timezone.length > 64) throw new Error("请选择时区。");
  integer(payload.retry, "重试次数", 0, 5);
  integer(payload.timeout_seconds, "任务超时", 10, 900);
  let retryDelay = 0;
  for (let index = 0; index < payload.retry; index += 1) retryDelay += Math.min(60, 2 * (2 ** index));
  if (payload.timeout_seconds * (payload.retry + 1) + retryDelay > 900) throw new Error("任务的超时与重试总预算不能超过 900 秒。");
  if (payload.delete_after_seconds !== null && payload.delete_after_seconds >= payload.timeout_seconds - 10) throw new Error("发送后删除时间必须至少比任务超时短 10 秒。");
}
function renderBuilder(form, params) {
  const wrapper = ensureBuilder(form);
  wrapper.querySelector("[data-skill-builder-content]").innerHTML = sendContentMarkup(params);
  wrapper.hidden = false;
  form.dataset.skillExpansionRendered = `send_media:${form.dataset.id || "new"}`;
}
function configureLegacyFields(form, skillKey) {
  const expanded = skillKey === "send_media";
  setHidden(fieldContainer(form, "#task-bot"), expanded);
  setHidden(fieldContainer(form, "#task-command"), expanded);
  setHidden(fieldContainer(form, "#task-signer-import"), skillKey !== "tg_signer");
  setHidden(fieldContainer(form, "#task-thread"), !["send_text", "send_media"].includes(skillKey));
  setHidden(fieldContainer(form, "#task-delete-after"), !["send_text", "send_media"].includes(skillKey));
  setHidden(ensureBuilder(form), !expanded);
  if (expanded) {
    const help = ensureSkillHelp(form);
    setTextContentIfChanged(help, PRESENTATIONS.send_media.formHelp);
  }
}
async function hydrateForm(form) {
  const skillKey = fieldValue(form, "#task-skill");
  configureLegacyFields(form, skillKey);
  if (skillKey !== "send_media") return;
  const renderKey = `send_media:${form.dataset.id || "new"}`;
  if (form.dataset.skillExpansionRendered === renderKey) return;
  renderBuilder(form, paramsFromLegacy("send_media", legacySnapshot(form)));
  if (!form.dataset.id) return;
  try {
    const stored = await loadTaskParams(form.dataset.id);
    if (form.isConnected && fieldValue(form, "#task-skill") === "send_media") renderBuilder(form, stored);
  } catch (error) { setStatus(ensureBuilder(form), error.message, "error"); }
}
function updateSkillOptionCopy(option) {
  if (option?.value !== "send_media" || option.textContent === PRESENTATIONS.send_media.name) return false;
  option.textContent = PRESENTATIONS.send_media.name;
  return true;
}
function updateSkillCopy() {
  const select = document.querySelector("#task-skill");
  if (select) for (const option of select.options) updateSkillOptionCopy(option);
}
async function submitExpandedTask(event, form) {
  if (fieldValue(form, "#task-skill") !== "send_media") return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const builder = ensureBuilder(form);
  const button = form.ownerDocument.querySelector('button[type="submit"][form="task-form"]');
  if (button) { button.disabled = true; button.textContent = "正在保存…"; }
  try {
    const payload = commonTaskPayload(form, collectParams(form));
    validateCommonPayload(payload);
    const id = form.dataset.id;
    await apiRequest(id ? `/api/v1/tasks/${encodeURIComponent(id)}` : "/api/v1/tasks", { method: id ? "PATCH" : "POST", body: payload });
    setStatus(builder, id ? "任意内容任务已更新。" : "任意内容任务已创建。", "success");
    window.location.reload();
  } catch (error) {
    setStatus(builder, error.message, "error");
    builder.scrollIntoView({ block: "center", behavior: "smooth" });
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
  } finally { observer?.observe(document.body, { childList: true, subtree: true }); }
}
function scheduleApply() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(async () => {
    try { await applyExpansion(); }
    finally { scheduled = false; }
  });
}
if (typeof document !== "undefined") {
  observer = new MutationObserver(scheduleApply);
  document.addEventListener("change", (event) => {
    const form = event.target?.closest?.("#task-form");
    if (form && event.target.matches("#task-skill")) { delete form.dataset.skillExpansionRendered; scheduleApply(); }
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
  PRESENTATIONS,
  TARGET_PATTERN,
  parseTelegramMessageLink,
  setTextContentIfChanged,
  updateSkillOptionCopy,
};
