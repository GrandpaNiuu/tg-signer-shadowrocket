export const SKILL_PRESENTATIONS = Object.freeze({
  send_text: Object.freeze({
    name: "发送消息或机器人命令",
    shortName: "发送消息/命令",
    badge: "推荐",
    icon: "发",
    description: "向机器人、用户、群组或频道发送一段文字或命令。适合 /checkin 签到、每日提醒和普通消息。",
    suitableFor: "大多数普通任务；第一次创建任务建议选择这个。",
    formHelp: "用于发送普通文字或 /checkin 等机器人命令。大多数用户选择这个任务类型。",
    requiredFields: "接收方、消息、执行时间",
  }),
  tg_signer: Object.freeze({
    name: "高级自动签到流程",
    shortName: "高级自动签到",
    badge: "高级功能",
    icon: "签",
    description: "按照已有的 tg-signer 配置执行多步骤签到，例如发送命令、等待机器人回复或点击按钮。",
    suitableFor: "已经从 tg-signer 导出配置、并且理解多步骤签到规则的高级用户。",
    formHelp: "只有已经准备好 tg-signer 导出配置时才选择。普通签到和发送消息请使用“发送消息或机器人命令”。",
    requiredFields: "接收方、消息、高级签到配置",
  }),
});

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

function updateTaskForm() {
  const select = document.querySelector("#task-skill");
  if (!select) return;

  for (const option of select.options) {
    const presentation = skillPresentation(option.value);
    const suffix = option.disabled ? "（已停用）" : "";
    const label = `${presentation.name}${option.value === "send_text" ? "（推荐）" : ""}${suffix}`;
    if (option.textContent !== label) option.textContent = label;
  }

  const presentation = skillPresentation(select.value);
  ensureSkillHelp(select).textContent = presentation.formHelp;

  const skillLabel = document.querySelector('label[for="task-skill"]');
  if (skillLabel) skillLabel.textContent = "任务类型";

  const targetLabel = document.querySelector('label[for="task-bot"]');
  if (targetLabel) targetLabel.textContent = "发送给谁（机器人 / 用户 / 群组 / 频道）";
  const targetInput = document.querySelector("#task-bot");
  if (targetInput) targetInput.placeholder = "例如：@example_bot、@username 或 Chat ID";

  const commandLabel = document.querySelector('label[for="task-command"]');
  if (commandLabel) commandLabel.textContent = "要发送的消息或命令";
  const commandInput = document.querySelector("#task-command");
  if (commandInput) commandInput.placeholder = "例如：/checkin、签到、每日提醒内容";

  const signerLabel = document.querySelector('label[for="task-signer-import"]');
  const signerField = signerLabel?.closest(".field");
  if (signerLabel) signerLabel.innerHTML = "高级签到配置 <small>只有“高级自动签到流程”需要</small>";
  if (signerField) signerField.hidden = select.value !== "tg_signer";
  const signerInput = document.querySelector("#task-signer-import");
  if (signerInput) signerInput.placeholder = "粘贴 tg-signer 导出的 JSON 或 Base64 配置；普通用户不需要填写";
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
    const text = details.textContent;
    for (const key of Object.keys(SKILL_PRESENTATIONS)) {
      if (text.endsWith(` · ${key}`)) {
        details.textContent = `${text.slice(0, -key.length)}${skillPresentation(key).shortName}`;
        break;
      }
    }
  }
}

function updateSkillCards() {
  for (const card of document.querySelectorAll(".skill-card")) {
    const keyElement = card.querySelector(".skill-meta strong.mono");
    const key = keyElement?.textContent.trim();
    if (!key) continue;
    const presentation = skillPresentation(key);

    const title = card.querySelector("h2");
    if (title) title.textContent = presentation.name;
    const icon = card.querySelector(".skill-icon");
    if (icon) icon.textContent = presentation.icon;
    const status = card.querySelector(".skill-card-head .badge");
    if (status && !status.classList.contains("disabled")) status.textContent = presentation.badge;
    const description = card.querySelector(":scope > p");
    if (description) description.textContent = presentation.description;

    let suitable = card.querySelector("[data-skill-suitable]");
    if (!suitable) {
      suitable = document.createElement("div");
      suitable.className = "notice";
      suitable.dataset.skillSuitable = "true";
      card.querySelector(".skill-meta")?.insertAdjacentElement("beforebegin", suitable);
    }
    suitable.textContent = `适合：${presentation.suitableFor}`;

    const meta = [...card.querySelectorAll(".skill-meta > span")];
    const labels = ["内部标识（无需修改）", "执行程序版本", "配置格式版本", "需要填写"];
    meta.forEach((item, index) => {
      if (labels[index]) replaceTextNode(item, labels[index]);
    });
    const required = meta[3]?.querySelector("strong");
    if (required) required.textContent = presentation.requiredFields;
  }
}

function updatePageCopy() {
  const view = document.querySelector("#view");
  if (!view) return;

  const heading = view.querySelector(".page-head h1");
  if (heading?.textContent.trim() === "Skills") heading.textContent = "任务类型";
  const pageDescription = view.querySelector(".page-head p");
  if (heading?.textContent.trim() === "任务类型" && pageDescription) {
    pageDescription.textContent = "选择任务实际要做的事情；普通用户通常只需要“发送消息或机器人命令”。";
  }

  const registryNotice = view.querySelector(".notice.mb-md span:last-child");
  if (heading?.textContent.trim() === "任务类型" && registryNotice) {
    registryNotice.textContent = "任务类型是平台预先审核并部署的执行方式，用户不能上传代码。看不懂内部标识时，直接按照中文用途选择即可。";
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
const observer = new MutationObserver(() => {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    applySkillGuidance();
  });
});

export function applySkillGuidance() {
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
    if (event.target?.matches?.("#task-skill")) applySkillGuidance();
  });
  window.addEventListener("hashchange", applySkillGuidance);
  applySkillGuidance();
}
