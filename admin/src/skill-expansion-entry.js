const ACTIVE_SKILLS = new Set(["send_media"]);
const RETIRED_SKILLS = new Set(["account_audit", "bot_flow", "chat_snapshot"]);
const OPEN_TIMEOUT_MS = 15_000;

const DEFINITIONS = Object.freeze({
  send_media: Object.freeze({
    button: "创建媒体发送任务",
    defaultName: "定时发送媒体",
    summary: "在指定时间，把 Telegram 中已经存在的图片、文档或视频发送到目标聊天。",
    required: "需要填写：执行账号、发送目标、源媒体消息、执行时间。",
    example: "例如：每天 09:00 把频道消息 123 中的图片发送到客户群。",
  }),
});

let pending = null;
let scheduled = false;
let retryTimer = null;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}
function skillKey(card) {
  return card.querySelector(".skill-meta strong.mono")?.textContent?.trim() || "";
}
function notify(message, kind = "error") {
  const region = document.querySelector("#toast-region");
  if (!region) {
    window.alert(message);
    return;
  }
  const item = document.createElement("div");
  item.className = `toast ${kind}`;
  item.setAttribute("role", "status");
  item.textContent = message;
  region.append(item);
  window.setTimeout(() => item.remove(), 6000);
}
function purposeMarkup(definition) {
  return `<div class="skill-purpose" data-expanded-skill-purpose>
    <strong>实际用途</strong>
    <p>${escapeHtml(definition.summary)}</p>
    <p>${escapeHtml(definition.required)}</p>
    <p><strong>示例：</strong>${escapeHtml(definition.example)}</p>
  </div>`;
}
function removeRetiredEntries() {
  for (const card of document.querySelectorAll(".skill-grid .skill-card")) {
    if (RETIRED_SKILLS.has(skillKey(card))) card.remove();
  }
  const select = document.querySelector("#task-skill");
  if (select) {
    for (const option of [...select.options]) {
      if (RETIRED_SKILLS.has(option.value)) option.remove();
    }
  }
}
function enhanceSkillCards() {
  for (const card of document.querySelectorAll(".skill-grid .skill-card:not([data-skill-hub-capability])")) {
    const key = skillKey(card);
    const definition = DEFINITIONS[key];
    if (!definition) continue;
    if (!card.querySelector("[data-expanded-skill-purpose]")) {
      card.querySelector(".skill-meta")?.insertAdjacentHTML("beforebegin", purposeMarkup(definition));
    }
    if (card.querySelector("[data-expanded-skill-create]")) continue;
    const disabled = Boolean(card.querySelector(".badge.disabled"));
    const actions = document.createElement("div");
    actions.className = "actions mt-md";
    actions.dataset.expandedSkillEntry = "true";
    actions.innerHTML = `<button class="button primary" type="button" data-expanded-skill-create="${key}" ${disabled ? "disabled" : ""}>${escapeHtml(definition.button)}</button>`;
    card.append(actions);
  }
}
function clearPending() {
  pending = null;
  if (retryTimer !== null) {
    window.clearTimeout(retryTimer);
    retryTimer = null;
  }
}
function retryPending(delay = 80) {
  if (retryTimer !== null) return;
  retryTimer = window.setTimeout(() => {
    retryTimer = null;
    applyPending();
  }, delay);
}
function selectPendingSkill(form) {
  const select = form.querySelector("#task-skill");
  const option = select && [...select.options].find((item) => item.value === pending.key && !item.disabled);
  if (!option) {
    notify("媒体发送任务尚未完成部署，请刷新页面后重试。");
    clearPending();
    return;
  }
  select.value = pending.key;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  const name = form.querySelector("#task-name");
  if (name && !name.value.trim()) name.value = DEFINITIONS[pending.key].defaultName;
  window.setTimeout(() => {
    form.querySelector("[data-skill-builder]")?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, 80);
  clearPending();
}
function applyPending() {
  if (!pending) return;
  if (Date.now() - pending.startedAt > OPEN_TIMEOUT_MS) {
    notify("创建表单未能打开。请确认已经添加并启用了 Telegram 账号，然后重试。");
    clearPending();
    return;
  }
  if (!String(location.hash).startsWith("#/tasks")) {
    location.hash = "#/tasks";
    retryPending();
    return;
  }
  const form = document.querySelector("#task-form");
  if (form) {
    selectPendingSkill(form);
    return;
  }
  const add = document.querySelector('[data-action="add-task"]');
  if (add?.disabled) {
    notify("当前没有可用的 Telegram 账号。请先完成账号登录并启用账号。");
    clearPending();
    return;
  }
  if (add) add.click();
  retryPending();
}
function scheduleApply() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    removeRetiredEntries();
    enhanceSkillCards();
    applyPending();
  });
}

if (typeof document !== "undefined") {
  const observer = new MutationObserver(scheduleApply);
  observer.observe(document.body, { childList: true, subtree: true });
  document.addEventListener("click", (event) => {
    const button = event.target?.closest?.("[data-expanded-skill-create]");
    if (!button || button.disabled) return;
    const key = String(button.dataset.expandedSkillCreate || "");
    if (!ACTIVE_SKILLS.has(key)) return;
    event.preventDefault();
    pending = { key, startedAt: Date.now() };
    applyPending();
  });
  window.addEventListener("hashchange", scheduleApply);
  scheduleApply();
}

export const __test = {
  ACTIVE_SKILLS,
  DEFINITIONS,
  OPEN_TIMEOUT_MS,
  RETIRED_SKILLS,
};
