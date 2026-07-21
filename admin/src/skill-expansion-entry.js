const ACTIVE_SKILLS = new Set(["bot_flow", "send_media", "chat_snapshot"]);
const RETIRED_SKILLS = new Set(["account_audit"]);
const OPEN_TIMEOUT_MS = 15_000;

const DEFINITIONS = Object.freeze({
  bot_flow: Object.freeze({
    button: "创建机器人流程任务",
    defaultName: "机器人交互流程",
    summary: "适合必须发送命令、等待机器人回复、读取按钮并点击后才能完成的固定流程。",
    steps: [
      "选择执行这个流程的 Telegram 账号。",
      "填写机器人用户名或数字 Chat ID，例如 @example_bot。",
      "按顺序配置发送、等待消息、读取按钮、点击按钮；每一步都要设置超时。",
      "设置执行时间并保存。执行详情会显示每一步的结果。",
    ],
    example: "/start → 等待“签到” → 点击“签到” → 等待“成功”",
  }),
  send_media: Object.freeze({
    button: "创建媒体发送任务",
    defaultName: "定时发送媒体",
    summary: "定时发送 Telegram 中已经存在的图片、文档或视频，不接受本地路径和任意网址。",
    steps: [
      "先确保执行账号能够读取保存源媒体的聊天或频道。",
      "在创建表单中登记源 Chat ID、源 Message ID 和媒体类型。",
      "选择登记后的媒体，填写发送目标与可选 Caption。",
      "设置执行时间；发送成功后执行记录会保存新的 message_id。",
    ],
    example: "源频道消息 123 → 登记为图片 → 每天发送到目标频道",
  }),
  chat_snapshot: Object.freeze({
    button: "创建聊天快照任务",
    defaultName: "采集最近聊天消息",
    summary: "读取指定聊天最近的文字消息或 Caption，结果保存在执行记录中，不调用 AI。",
    steps: [
      "选择有权访问目标聊天的 Telegram 账号。",
      "填写群组、频道用户名或数字 Chat ID。",
      "设置采集数量；需要时填写关键词过滤。",
      "设置执行时间，运行后到“执行记录”查看采集结果。",
    ],
    example: "读取 @sales_group 最近 20 条，并只保留包含“订单”的消息",
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

function guideMarkup(definition) {
  return `<details class="skill-usage" data-expanded-skill-guide>
    <summary>查看使用方法</summary>
    <div class="skill-usage-body">
      <p>${escapeHtml(definition.summary)}</p>
      <ol>${definition.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol>
      <p><strong>示例：</strong>${escapeHtml(definition.example)}</p>
    </div>
  </details>`;
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
    if (!card.querySelector("[data-expanded-skill-guide]")) {
      card.querySelector(".skill-meta")?.insertAdjacentHTML("afterend", guideMarkup(definition));
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
    notify("当前任务类型尚未部署完成，请刷新页面后重试。");
    clearPending();
    return;
  }
  select.value = pending.key;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  const name = form.querySelector("#task-name");
  if (name && !name.value.trim()) name.value = DEFINITIONS[pending.key].defaultName;
  window.setTimeout(() => {
    form.querySelector("[data-skill-builder]")?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, 50);
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
    notify("当前没有可用的 Telegram 账号。请先在“Telegram 账号”页面完成登录并启用账号。");
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
