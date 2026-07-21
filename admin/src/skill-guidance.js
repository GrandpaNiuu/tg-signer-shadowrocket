export const SKILL_PRESENTATIONS = Object.freeze({
  send_text: Object.freeze({
    name: "发送一次消息或命令",
    shortName: "发送消息/命令",
    badge: "最简单",
    icon: "发",
    description: "到达设定时间后，向机器人、用户、群组或频道发送一段文字或命令，然后结束。",
    suitableFor: "普通消息、每日提醒，以及发送 /checkin 就能完成的签到。",
    formHelp: "只发送一次内容，不等待机器人回复，也不会点击按钮。",
    requiredFields: "接收方、消息、执行时间",
  }),
  tg_signer: Object.freeze({
    name: "机器人按钮签到",
    shortName: "按钮签到",
    badge: "自动等待",
    icon: "签",
    description: "先向机器人发送命令，再自动等待回复、寻找指定按钮并点击，还可以根据回复关键词确认签到成功。",
    suitableFor: "发送命令后还需要点击“签到”“领取”等按钮的机器人。",
    formHelp: "只需填写按钮文字和成功关键词，平台会自动生成并加密保存执行流程。",
    requiredFields: "接收方、消息、按钮文字、执行时间",
  }),
});

const EXTERNALLY_PRESENTED_SKILLS = new Set([
  "bot_flow",
  "send_media",
  "chat_snapshot",
  "account_audit",
]);

const GUIDED_FLOW_KIND = "telegram_guided_signin";
const GUIDED_FLOW_VERSION = 1;

export function skillPresentation(key) {
  const normalized = String(key || "").trim();
  return SKILL_PRESENTATIONS[normalized] || {
    name: "其他已部署任务类型",
    shortName: "其他任务类型",
    badge: "已部署",
    icon: "任",
    description: "由平台管理员预先部署的任务执行方式。创建任务前请先确认具体用途。",
    suitableFor: "仅在管理员明确说明用途后使用。",
    formHelp: "这是平台预先部署的任务类型；不清楚用途时请不要选择。",
    requiredFields: "请按管理员说明填写",
  };
}

export function guidedFlowConfiguration({
  target,
  text,
  buttonText = "",
  successKeywords = "",
  waitSeconds = 30,
  messageThreadId = "",
} = {}) {
  const keywords = String(successKeywords || "")
    .split(/[，,\n]/)
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 10);
  const wait = Math.min(120, Math.max(5, Number(waitSeconds) || 30));
  const thread = String(messageThreadId || "").trim();
  return {
    kind: GUIDED_FLOW_KIND,
    version: GUIDED_FLOW_VERSION,
    target: String(target || "").trim(),
    text: String(text || ""),
    button_text: String(buttonText || "").trim(),
    success_keywords: keywords,
    wait_seconds: wait,
    ...(thread ? { message_thread_id: Number(thread) } : {}),
  };
}

function replaceTextNode(element, value) {
  if (!element) return;
  const textNode = [...element.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
  if (textNode && textNode.textContent.trim() !== value) textNode.textContent = value;
}

function updateNavigation() {
  const link = document.querySelector('[data-route="skills"]');
  replaceTextNode(link, "任务类型");
  if (location.hash === "#/skills" || location.hash.startsWith("#/skills?")) {
    const breadcrumb = document.querySelector("#breadcrumb");
    if (breadcrumb) breadcrumb.textContent = "任务类型";
    document.title = "任务类型 · Telegram 自动消息";
  }
}

function ensureSkillHelp(select) {
  let help = select.parentElement?.querySelector("[data-skill-help]");
  if (!help) {
    help = document.createElement("p");
    help.className = "field-help";
    help.dataset.skillHelp = "true";
    select.insertAdjacentElement("afterend", help);
  }
  return help;
}

function guidedBuilderMarkup(existing) {
  return `<div class="notice mb-sm"><span aria-hidden="true">✓</span><span><strong>不用填写 JSON</strong><br>平台会根据下面几项自动生成签到流程，并加密保存在服务端。</span></div>
    ${existing ? '<div class="notice warning mb-sm"><span aria-hidden="true">!</span><span>此任务已有加密配置。只修改时间等普通选项会保留原配置；填写下面的签到步骤后会替换原配置。</span></div>' : ""}
    <div class="form-grid">
      <div class="field"><label for="guided-button-text">需要点击的按钮文字</label><input id="guided-button-text" data-guided-field="buttonText" maxlength="128" autocomplete="off" placeholder="例如：签到、领取、打卡"><p class="field-help">机器人回复中只要按钮包含这些文字，平台就会点击。没有按钮可留空。</p></div>
      <div class="field"><label for="guided-success-keywords">成功回复包含</label><input id="guided-success-keywords" data-guided-field="successKeywords" maxlength="500" autocomplete="off" placeholder="例如：签到成功, 已签到, 获得积分"><p class="field-help">多个关键词用逗号分开。任意一个出现在回复中就判定成功；不需要确认可留空。</p></div>
      <div class="field"><label for="guided-wait-seconds">最长等待时间</label><input id="guided-wait-seconds" data-guided-field="waitSeconds" type="number" min="5" max="120" value="30"><p class="field-help">发送命令后等待机器人回复的秒数，建议保持 30 秒。</p></div>
    </div>`;
}

function ensureGuidedBuilder(form, legacyField) {
  let builder = form.querySelector("[data-guided-signin-builder]");
  let legacyDetails = form.querySelector("[data-legacy-signer-details]");
  if (!builder) {
    builder = document.createElement("section");
    builder.className = "field span-2";
    builder.dataset.guidedSigninBuilder = "true";
    builder.innerHTML = guidedBuilderMarkup(form.dataset.hasTgSignerImport === "true");

    legacyDetails = document.createElement("details");
    legacyDetails.className = "span-2";
    legacyDetails.dataset.legacySignerDetails = "true";
    const summary = document.createElement("summary");
    summary.className = "field-label";
    summary.textContent = "已有旧版 tg-signer 配置（仅高级用户）";
    const note = document.createElement("p");
    note.className = "field-help";
    note.textContent = "只有已经从 tg-signer 导出 JSON 或 Base64 的用户才需要展开。普通用户不要填写。";
    legacyField.parentElement?.insertBefore(builder, legacyField);
    legacyField.parentElement?.insertBefore(legacyDetails, legacyField);
    legacyDetails.append(summary, note, legacyField);
  }
  return { builder, legacyDetails };
}

function markGuidedTouched(form) {
  form.dataset.guidedSigninTouched = "true";
  delete form.dataset.legacySignerEdited;
}

function syncGuidedConfiguration(form, { force = false } = {}) {
  const select = form?.querySelector("#task-skill");
  const legacy = form?.querySelector("#task-signer-import");
  if (!form || select?.value !== "tg_signer" || !legacy) return;
  if (form.dataset.legacySignerEdited === "true") return;
  const existing = form.dataset.hasTgSignerImport === "true";
  const touched = form.dataset.guidedSigninTouched === "true";
  if (existing && !touched && !force) return;

  const values = Object.fromEntries([...form.querySelectorAll("[data-guided-field]")]
    .map((field) => [field.dataset.guidedField, field.value]));
  const config = guidedFlowConfiguration({
    target: form.elements.namedItem("bot")?.value,
    text: form.elements.namedItem("command")?.value,
    messageThreadId: form.elements.namedItem("thread_id")?.value,
    ...values,
  });
  legacy.value = JSON.stringify(config);
}

function updateTaskForm() {
  const select = document.querySelector("#task-skill");
  if (!select) return;
  const form = select.closest("form");
  if (!form) return;

  for (const option of select.options) {
    if (EXTERNALLY_PRESENTED_SKILLS.has(option.value)) continue;
    const presentation = skillPresentation(option.value);
    const suffix = option.disabled ? "（已停用）" : "";
    const label = `${presentation.name}${option.value === "send_text" ? "（推荐）" : ""}${suffix}`;
    if (option.textContent !== label) option.textContent = label;
  }

  if (!EXTERNALLY_PRESENTED_SKILLS.has(select.value)) {
    const presentation = skillPresentation(select.value);
    ensureSkillHelp(select).textContent = presentation.formHelp;
  }

  const skillLabel = document.querySelector('label[for="task-skill"]');
  if (skillLabel) skillLabel.textContent = "任务类型";

  const targetLabel = document.querySelector('label[for="task-bot"]');
  if (targetLabel) targetLabel.textContent = "发送给谁（机器人 / 用户 / 群组 / 频道）";
  const targetInput = document.querySelector("#task-bot");
  if (targetInput) targetInput.placeholder = "例如：@example_bot、@username 或 Chat ID";

  const commandLabel = document.querySelector('label[for="task-command"]');
  if (commandLabel) commandLabel.textContent = "先发送的消息或命令";
  const commandInput = document.querySelector("#task-command");
  if (commandInput) commandInput.placeholder = "例如：/checkin、/start、签到";

  const signerLabel = document.querySelector('label[for="task-signer-import"]');
  const legacyField = signerLabel?.closest(".field");
  if (signerLabel) signerLabel.innerHTML = "旧版配置 <small>留空保持现有配置</small>";
  if (legacyField) {
    legacyField.hidden = false;
    const { builder, legacyDetails } = ensureGuidedBuilder(form, legacyField);
    const visible = select.value === "tg_signer";
    builder.hidden = !visible;
    legacyDetails.hidden = !visible;
    const signerInput = document.querySelector("#task-signer-import");
    if (signerInput) signerInput.placeholder = "粘贴已有 tg-signer JSON 或 Base64；普通用户不需要填写";
    if (visible && form.dataset.hasTgSignerImport !== "true") syncGuidedConfiguration(form, { force: true });
  }
}

function updateTaskTable() {
  for (const heading of document.querySelectorAll("#tasks-table th")) {
    if (heading.textContent.trim() === "账号 / Skill") heading.textContent = "账号 / 任务类型";
  }
  for (const cell of document.querySelectorAll('#tasks-table td[data-label="账号 / Skill"], #tasks-table td[data-label="账号 / 任务类型"]')) {
    cell.dataset.label = "账号 / 任务类型";
    const keyElement = cell.querySelector(".cell-sub");
    if (!keyElement) continue;
    const key = cell.dataset.skillKey || keyElement.textContent.trim();
    cell.dataset.skillKey = key;
    keyElement.textContent = skillPresentation(key).shortName;
    keyElement.classList.remove("mono");
  }
}

function updateDashboardSkillLabels() {
  for (const details of document.querySelectorAll(".service-row small")) {
    const detailText = details.textContent;
    for (const key of Object.keys(SKILL_PRESENTATIONS)) {
      if (detailText.endsWith(` · ${key}`)) {
        details.textContent = `${detailText.slice(0, -key.length)}${skillPresentation(key).shortName}`;
        break;
      }
    }
  }
}

function updateSkillCards() {
  for (const card of document.querySelectorAll(".skill-card")) {
    const keyElement = card.querySelector(".skill-meta strong.mono");
    const key = keyElement?.textContent.trim();
    if (!key || EXTERNALLY_PRESENTED_SKILLS.has(key)) continue;
    const presentation = skillPresentation(key);

    const title = card.querySelector("h2");
    if (title && title.textContent !== presentation.name) title.textContent = presentation.name;
    const icon = card.querySelector(".skill-icon");
    if (icon && icon.textContent !== presentation.icon) icon.textContent = presentation.icon;
    const status = card.querySelector(".skill-card-head .badge");
    if (status && !status.classList.contains("disabled") && status.textContent !== presentation.badge) status.textContent = presentation.badge;
    const description = card.querySelector(":scope > p");
    if (description && description.textContent !== presentation.description) description.textContent = presentation.description;

    let suitable = card.querySelector("[data-skill-suitable]");
    if (!suitable) {
      suitable = document.createElement("div");
      suitable.className = "notice";
      suitable.dataset.skillSuitable = "true";
      card.querySelector(".skill-meta")?.insertAdjacentElement("beforebegin", suitable);
    }
    const suitableText = `适合：${presentation.suitableFor}`;
    if (suitable.textContent !== suitableText) suitable.textContent = suitableText;

    const meta = [...card.querySelectorAll(".skill-meta > span")];
    const labels = ["内部标识（无需修改）", "执行程序版本", "配置格式版本", "需要填写"];
    meta.forEach((item, index) => {
      if (labels[index]) replaceTextNode(item, labels[index]);
    });
    const required = meta[3]?.querySelector("strong");
    if (required && required.textContent !== presentation.requiredFields) required.textContent = presentation.requiredFields;
  }
}

function updatePageCopy() {
  const view = document.querySelector("#view");
  if (!view) return;

  const heading = view.querySelector(".page-head h1");
  if (heading?.textContent.trim() === "Skills") heading.textContent = "任务类型";
  const pageDescription = view.querySelector(".page-head p");
  if (heading?.textContent.trim() === "任务类型" && pageDescription) {
    const value = "选择任务实际要做的事情；普通消息选第一项，需要点击机器人按钮时选第二项。";
    if (pageDescription.textContent !== value) pageDescription.textContent = value;
  }

  const registryNotice = view.querySelector(".notice.mb-md span:last-child");
  if (heading?.textContent.trim() === "任务类型" && registryNotice) {
    const value = "任务类型是平台预先审核并部署的执行方式，用户不能上传代码。按照中文用途选择即可。";
    if (registryNotice.textContent !== value) registryNotice.textContent = value;
  }

  for (const paragraph of view.querySelectorAll(".empty-state p")) {
    if (paragraph.textContent.includes("选择账号和 Skill")) {
      paragraph.textContent = "选择账号和任务类型，再填写接收方、消息和执行时间即可开始。";
    }
    if (paragraph.textContent.includes("D1 migration") || paragraph.textContent.includes("Skills")) {
      paragraph.textContent = "当前没有可用的任务类型，请联系平台管理员检查部署状态。";
    }
  }

  updateTaskForm();
  updateTaskTable();
  updateDashboardSkillLabels();
  updateSkillCards();
}

let scheduled = false;
const observer = typeof MutationObserver === "undefined" ? null : new MutationObserver(() => {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    applySkillGuidance();
  });
});

export function applySkillGuidance() {
  if (!observer || typeof document === "undefined") return;
  observer.disconnect();
  try {
    updateNavigation();
    updatePageCopy();
  } finally {
    observer.observe(document.body, { childList: true, subtree: true });
  }
}

if (typeof document !== "undefined") {
  document.addEventListener("change", (event) => {
    const form = event.target?.closest?.("#task-form");
    if (event.target?.matches?.("#task-skill")) {
      if (form) markGuidedTouched(form);
      applySkillGuidance();
      if (form) syncGuidedConfiguration(form);
    }
  });
  document.addEventListener("input", (event) => {
    const form = event.target?.closest?.("#task-form");
    if (!form) return;
    if (event.target?.matches?.("#task-signer-import")) {
      form.dataset.legacySignerEdited = "true";
      delete form.dataset.guidedSigninTouched;
      return;
    }
    if (event.target?.matches?.("[data-guided-field], #task-bot, #task-command, #task-thread")) {
      markGuidedTouched(form);
      syncGuidedConfiguration(form);
    }
  });
  document.addEventListener("submit", (event) => {
    if (!event.target?.matches?.("#task-form")) return;
    const form = event.target;
    syncGuidedConfiguration(form, {
      force: form.dataset.hasTgSignerImport !== "true" || form.dataset.guidedSigninTouched === "true",
    });
  }, true);
  window.addEventListener("hashchange", applySkillGuidance);
  applySkillGuidance();
}

export const __test = {
  EXTERNALLY_PRESENTED_SKILLS,
};
