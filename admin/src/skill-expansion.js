const EXPANDED_SKILLS = new Set(["send_media"]);
const TARGET_PATTERN = /^(?:@[A-Za-z][A-Za-z0-9_]{4,31}|-?\d{1,20})$/;
const ASSET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/;

const PRESENTATIONS = Object.freeze({
  send_media: Object.freeze({
    name: "发送媒体",
    shortName: "媒体发送",
    badge: "图片 / 文档 / 视频",
    icon: "媒",
    description: "把 Telegram 中已经存在的图片、文档或视频，在指定时间发送到机器人、用户、群组或频道。",
    suitableFor: "定时发送固定海报、文件、视频或频道素材。",
    formHelp: "该任务只负责发送媒体。请在下方填写发送目标，并登记或选择一条 Telegram 源媒体消息。",
  }),
});

function text(value) { return String(value ?? ""); }
function trimmed(value) { return text(value).trim(); }
function safeObject(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
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
function target(value, field = "目标") {
  const output = requiredText(value, field, 128);
  if (!TARGET_PATTERN.test(output)) throw new Error(`${field}必须是 @用户名或数字 Chat ID。`);
  return output;
}

export function paramsFromLegacy(skillKey, { bot = "", command = "", threadId = null, deleteAfter = null } = {}) {
  if (skillKey !== "send_media") return {};
  const parsed = parseJsonObject(command);
  return {
    target: trimmed(parsed.target || bot),
    file_id: trimmed(parsed.file_id),
    media_type: trimmed(parsed.media_type || "photo"),
    caption: parsed.caption ?? null,
    message_thread_id: parsed.message_thread_id ?? threadId ?? null,
    delete_after: parsed.delete_after ?? deleteAfter ?? null,
  };
}

export function validateExpandedParams(skillKey, rawParams) {
  if (skillKey !== "send_media") throw new Error("当前任务类型不属于媒体发送任务。");
  const input = safeObject(rawParams);
  const fileId = requiredText(input.file_id, "媒体资产", 160);
  if (!ASSET_ID_PATTERN.test(fileId)) throw new Error("媒体资产无效，请先登记并选择 Telegram 源媒体。");
  const mediaType = requiredText(input.media_type, "媒体类型", 20);
  if (!["photo", "document", "video"].includes(mediaType)) {
    throw new Error("媒体类型必须是图片、文档或视频。");
  }
  const caption = input.caption === null || input.caption === undefined || input.caption === ""
    ? null : requiredText(input.caption, "Caption", 1024);
  return {
    target: target(input.target, "发送目标"),
    file_id: fileId,
    media_type: mediaType,
    caption,
    message_thread_id: optionalInteger(input.message_thread_id, "Thread ID", 1, Number.MAX_SAFE_INTEGER),
    delete_after: optionalInteger(input.delete_after, "Delete After", 0, 86400),
  };
}

function fieldValue(form, selector) { return form.querySelector(selector)?.value ?? ""; }
function fieldContainer(form, selector) { return form.querySelector(selector)?.closest(".field") || null; }
function setHidden(element, hidden) { if (element && element.hidden !== hidden) element.hidden = hidden; }
function statusNode(builder) { return builder.querySelector("[data-skill-status]"); }
function setStatus(builder, message, kind = "") {
  const node = statusNode(builder);
  if (!node) return;
  node.textContent = message || "";
  node.className = `field-help skill-expansion-status${kind ? ` ${kind}` : ""}`;
}

function fieldLabel(field) {
  const labels = {
    account_id: "Telegram 账号",
    skill_key: "任务类型",
    cron: "执行时间",
    timezone: "时区",
    retry: "重试次数",
    timeout_seconds: "任务超时",
    "params.target": "发送目标",
    "params.file_id": "媒体资产",
    "params.media_type": "媒体类型",
    "params.caption": "Caption",
    "params.message_thread_id": "Thread ID",
    "params.delete_after": "Delete After",
  };
  return labels[field] || field;
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
  if (!response.ok) {
    const fields = payload?.error?.details?.fields || payload?.error?.fields || [];
    if (Array.isArray(fields) && fields.length) {
      throw new Error(`请检查：${fields.map(fieldLabel).join("、")}。`);
    }
    throw new Error(payload?.error?.message || "请求未完成，请稍后重试。");
  }
  return payload?.data ?? payload ?? null;
}

const taskParamsCache = new Map();
let mediaAssetsCache = null;
async function loadTaskParams(taskId) {
  if (!taskId) return null;
  if (!taskParamsCache.has(taskId)) {
    taskParamsCache.set(taskId, apiRequest(`/api/v1/tasks/${encodeURIComponent(taskId)}`)
      .then((task) => safeObject(task?.params)));
  }
  return taskParamsCache.get(taskId);
}
async function loadMediaAssets({ refresh = false } = {}) {
  if (refresh || !mediaAssetsCache) {
    mediaAssetsCache = apiRequest("/api/v1/media-assets?limit=100")
      .then((payload) => Array.isArray(payload) ? payload : []);
  }
  return mediaAssetsCache;
}

function builderShell() {
  return `<section class="skill-expansion-builder" data-skill-builder>
    <div data-skill-builder-content></div>
    <p class="field-help skill-expansion-status" data-skill-status aria-live="polite"></p>
  </section>`;
}
function ensureBuilder(form) {
  let wrapper = form.querySelector("[data-skill-expansion]");
  if (wrapper) return wrapper;
  wrapper = document.createElement("div");
  wrapper.className = "field span-2";
  wrapper.dataset.skillExpansion = "true";
  wrapper.innerHTML = builderShell();
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

function mediaOptions(assets, selected) {
  if (!assets.length) return '<option value="">暂无已登记媒体，请在下方先登记</option>';
  return `<option value="">请选择已登记媒体</option>${assets.map((asset) => `<option value="${escapeHtml(asset.id)}" data-media-type="${escapeHtml(asset.media_type)}" ${String(selected || "") === String(asset.id) ? "selected" : ""}>${escapeHtml(asset.name)} · ${escapeHtml(asset.media_type)} · ${escapeHtml(asset.source_chat_id)} / 消息 ${escapeHtml(asset.source_message_id)}</option>`).join("")}`;
}
function sendMediaMarkup(params, assets) {
  return `<div class="skill-purpose">
      <strong>这个任务会做什么</strong>
      <p>到达设定时间后，使用所选 Telegram 账号读取一条已经存在的媒体消息，并把其中的图片、文档或视频发送到目标聊天。它不会发送文字命令，也不会监听群消息。</p>
    </div>
    <div class="form-grid">
      <div class="field"><label class="required" for="skill-media-target">发送到哪里</label><input id="skill-media-target" data-skill-field="target" maxlength="128" value="${escapeHtml(params.target || "")}" placeholder="例如 @channel 或 -1001234567890"><p class="field-help">填写机器人、用户、群组或频道的 @用户名 / Chat ID。</p></div>
      <div class="field"><label class="required" for="skill-media-asset">发送什么媒体</label><select id="skill-media-asset" data-skill-field="file_id">${mediaOptions(assets, params.file_id)}</select><p class="field-help">媒体必须先从 Telegram 中的一条现有消息登记。</p></div>
      <div class="field span-2"><label for="skill-media-caption">附带文字 Caption <small>可选</small></label><textarea id="skill-media-caption" data-skill-field="caption" maxlength="1024" placeholder="发送媒体时附带的说明文字">${escapeHtml(params.caption || "")}</textarea></div>
    </div>
    <details class="skill-media-register" ${assets.length ? "" : "open"}>
      <summary class="field-label">登记 Telegram 中的源媒体消息</summary>
      <div class="notice mb-sm"><span aria-hidden="true">i</span><span>先在 Telegram 中找到要重复发送的图片、文档或视频。填写该聊天的 Chat ID 和该条消息的 Message ID。系统不接受电脑文件路径或任意网址。</span></div>
      <div class="form-grid">
        <div class="field"><label class="required">媒体名称</label><input data-media-register="name" maxlength="100" placeholder="例如：每日促销海报"></div>
        <div class="field"><label class="required">媒体类型</label><select data-media-register="media_type"><option value="photo">图片 photo</option><option value="document">文档 document</option><option value="video">视频 video</option></select></div>
        <div class="field"><label class="required">源 Chat ID / @用户名</label><input data-media-register="source_chat_id" maxlength="128" placeholder="例如 @source_channel 或 -100..."></div>
        <div class="field"><label class="required">源 Message ID</label><input data-media-register="source_message_id" type="number" min="1" placeholder="例如 123"></div>
        <div class="field span-2"><button class="button small primary" type="button" data-skill-action="register-media">登记并选中这个媒体</button><button class="button small ghost danger" type="button" data-skill-action="delete-media">删除当前媒体登记</button></div>
      </div>
    </details>`;
}

function legacySnapshot(form) {
  return {
    bot: fieldValue(form, "#task-bot"),
    command: fieldValue(form, "#task-command"),
    threadId: fieldValue(form, "#task-thread"),
    deleteAfter: fieldValue(form, "#task-delete-after"),
  };
}
function collectParams(form) {
  const select = form.querySelector('[data-skill-field="file_id"]');
  const option = select?.selectedOptions?.[0];
  return validateExpandedParams("send_media", {
    target: fieldValue(form, '[data-skill-field="target"]'),
    file_id: select?.value || "",
    media_type: option?.dataset?.mediaType || "",
    caption: fieldValue(form, '[data-skill-field="caption"]'),
    message_thread_id: fieldValue(form, "#task-thread"),
    delete_after: fieldValue(form, "#task-delete-after"),
  });
}
function collectUnvalidatedParams(form) {
  const select = form.querySelector('[data-skill-field="file_id"]');
  return {
    target: fieldValue(form, '[data-skill-field="target"]'),
    file_id: select?.value || "",
    media_type: select?.selectedOptions?.[0]?.dataset?.mediaType || "photo",
    caption: fieldValue(form, '[data-skill-field="caption"]'),
    message_thread_id: fieldValue(form, "#task-thread"),
    delete_after: fieldValue(form, "#task-delete-after"),
  };
}
function commonTaskPayload(form, params) {
  const data = new FormData(form);
  const optional = (name) => data.get(name) === "" ? null : Number(data.get(name));
  return {
    name: trimmed(data.get("name")),
    account_id: trimmed(data.get("account_id")),
    skill_key: "send_media",
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
  if (!payload.account_id) throw new Error("请选择执行任务的 Telegram 账号。");
  if (!payload.cron || payload.cron.length > 96) throw new Error("执行时间无效。");
  if (!payload.timezone || payload.timezone.length > 64) throw new Error("请选择时区。");
  integer(payload.retry, "重试次数", 0, 5);
  integer(payload.timeout_seconds, "任务超时", 10, 900);
  let retryDelay = 0;
  for (let index = 0; index < payload.retry; index += 1) retryDelay += Math.min(60, 2 * (2 ** index));
  if (payload.timeout_seconds * (payload.retry + 1) + retryDelay > 900) {
    throw new Error("Timeout 与 Retry 的最坏执行时间必须不超过 900 秒。");
  }
  if (payload.delete_after_seconds !== null && payload.delete_after_seconds >= payload.timeout_seconds - 10) {
    throw new Error("Delete After 必须至少比任务超时短 10 秒。");
  }
}

async function renderBuilder(form, params, { refreshAssets = false } = {}) {
  const wrapper = ensureBuilder(form);
  const content = wrapper.querySelector("[data-skill-builder-content]");
  content.innerHTML = sendMediaMarkup(params, await loadMediaAssets({ refresh: refreshAssets }));
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
    if (help) help.textContent = PRESENTATIONS.send_media.formHelp;
  }
}
async function hydrateForm(form) {
  const skillKey = fieldValue(form, "#task-skill");
  configureLegacyFields(form, skillKey);
  if (skillKey !== "send_media") return;
  const renderKey = `send_media:${form.dataset.id || "new"}`;
  if (form.dataset.skillExpansionRendered === renderKey) return;
  const legacy = paramsFromLegacy("send_media", legacySnapshot(form));
  await renderBuilder(form, legacy);
  const taskId = form.dataset.id;
  if (taskId) {
    try {
      const stored = await loadTaskParams(taskId);
      if (form.isConnected && fieldValue(form, "#task-skill") === "send_media") {
        await renderBuilder(form, stored);
      }
    } catch (error) {
      const builder = ensureBuilder(form);
      setStatus(builder, error.message, "error");
    }
  }
}
function updateSkillCopy() {
  const select = document.querySelector("#task-skill");
  if (select) {
    for (const option of select.options) {
      if (option.value === "send_media" && option.textContent !== PRESENTATIONS.send_media.name) {
        option.textContent = PRESENTATIONS.send_media.name;
      }
    }
  }
  for (const card of document.querySelectorAll(".skill-card")) {
    const key = card.querySelector(".skill-meta strong.mono")?.textContent?.trim();
    if (key !== "send_media") continue;
    const title = card.querySelector("h2");
    const icon = card.querySelector(".skill-icon");
    const badge = card.querySelector(".skill-card-head .badge");
    const description = card.querySelector(":scope > p");
    if (title && title.textContent !== PRESENTATIONS.send_media.name) title.textContent = PRESENTATIONS.send_media.name;
    if (icon && icon.textContent !== PRESENTATIONS.send_media.icon) icon.textContent = PRESENTATIONS.send_media.icon;
    if (badge && !badge.classList.contains("disabled") && badge.textContent !== PRESENTATIONS.send_media.badge) badge.textContent = PRESENTATIONS.send_media.badge;
    if (description && description.textContent !== PRESENTATIONS.send_media.description) description.textContent = PRESENTATIONS.send_media.description;
  }
}

async function registerMediaAsset(form, button) {
  const builder = ensureBuilder(form);
  button.disabled = true;
  try {
    const body = {
      name: requiredText(fieldValue(form, '[data-media-register="name"]'), "媒体名称", 100),
      media_type: requiredText(fieldValue(form, '[data-media-register="media_type"]'), "媒体类型", 20),
      source_chat_id: target(fieldValue(form, '[data-media-register="source_chat_id"]'), "源 Chat ID"),
      source_message_id: integer(fieldValue(form, '[data-media-register="source_message_id"]'), "源 Message ID", 1, Number.MAX_SAFE_INTEGER),
    };
    const asset = await apiRequest("/api/v1/media-assets", { method: "POST", body });
    mediaAssetsCache = null;
    const current = collectUnvalidatedParams(form);
    current.file_id = asset.id;
    current.media_type = asset.media_type;
    await renderBuilder(form, current, { refreshAssets: true });
    setStatus(ensureBuilder(form), "媒体已登记并选中。现在填写发送目标和执行时间，然后保存任务。", "success");
  } catch (error) {
    setStatus(builder, error.message, "error");
    builder.scrollIntoView({ block: "center", behavior: "smooth" });
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
    await renderBuilder(form, current, { refreshAssets: true });
    setStatus(ensureBuilder(form), "媒体登记已删除。", "success");
  } catch (error) {
    setStatus(builder, error.message, "error");
  } finally {
    button.disabled = false;
  }
}
async function submitExpandedTask(event, form) {
  if (fieldValue(form, "#task-skill") !== "send_media") return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const builder = ensureBuilder(form);
  const button = form.ownerDocument.querySelector('button[type="submit"][form="task-form"]');
  if (button) { button.disabled = true; button.textContent = "正在保存…"; }
  try {
    const params = collectParams(form);
    const payload = commonTaskPayload(form, params);
    validateCommonPayload(payload);
    const id = form.dataset.id;
    await apiRequest(id ? `/api/v1/tasks/${encodeURIComponent(id)}` : "/api/v1/tasks", {
      method: id ? "PATCH" : "POST",
      body: payload,
    });
    setStatus(builder, id ? "媒体任务已更新。" : "媒体任务已创建。", "success");
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
  });
  document.addEventListener("click", (event) => {
    const button = event.target?.closest?.("[data-skill-action]");
    const form = button?.closest?.("#task-form");
    if (!button || !form) return;
    if (button.dataset.skillAction === "register-media") registerMediaAsset(form, button);
    if (button.dataset.skillAction === "delete-media") deleteMediaAsset(form, button);
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
};
