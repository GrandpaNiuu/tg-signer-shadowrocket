const SKILLS_ROUTE = "#/skills";
const TASKS_ROUTE = "#/tasks";

let syncScheduled = false;
let viewObserver = null;
let openingInspection = false;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function notify(title, message = "", kind = "success") {
  const region = document.querySelector("#toast-region");
  if (!region) return;
  const element = document.createElement("div");
  element.className = `toast ${kind === "error" ? "error" : ""}`;
  element.innerHTML = `<span aria-hidden="true">${kind === "error" ? "!" : "✓"}</span><div><strong>${escapeHtml(title)}</strong>${message ? `<p>${escapeHtml(message)}</p>` : ""}</div>`;
  region.append(element);
  setTimeout(() => element.remove(), 5200);
}

function skillKey(card) {
  return card?.dataset.automationKey
    || card?.querySelector(".skill-meta strong.mono")?.textContent.trim()
    || card?.querySelector(".skill-meta strong")?.textContent.trim()
    || "";
}

function signerCard() {
  return [...document.querySelectorAll(".skill-grid .skill-card:not([data-skill-hub-capability])")]
    .find((card) => skillKey(card) === "tg_signer") || null;
}

function mergeSignerCard() {
  if (!String(location.hash).startsWith(SKILLS_ROUTE)) return;
  const card = signerCard();
  const actions = card?.querySelector("[data-skill-hub-existing-action]");
  const manualButton = actions?.querySelector('[data-skill-hub-action="create-scheduled"][data-skill-key="tg_signer"]');
  if (!card || !actions || !manualButton) return;
  if (actions.dataset.signerSkillMerged === "true") return;

  // Mark before mutating descendants so the MutationObserver cannot re-enter this work.
  actions.dataset.signerSkillMerged = "true";

  const description = card.querySelector(":scope > p");
  const descriptionText = "向机器人发送命令并点击指定按钮。可以让系统先识别机器人回复和按钮，也可以直接手动填写。";
  if (description && description.textContent !== descriptionText) description.textContent = descriptionText;

  const noticeText = card.querySelector(":scope > .notice span:last-child");
  const noticeValue = "适合：需要发送命令后点击“签到”“领取”等按钮的机器人。首次配置建议使用自动识别。";
  if (noticeText && noticeText.textContent !== noticeValue) noticeText.textContent = noticeValue;

  manualButton.textContent = "手动配置";
  manualButton.classList.remove("primary");
  manualButton.classList.add("ghost");

  const automaticButton = document.createElement("button");
  automaticButton.type = "button";
  automaticButton.className = "button primary";
  automaticButton.dataset.signerSkillAction = "inspect-and-create";
  automaticButton.textContent = "自动识别并创建（推荐）";
  actions.prepend(automaticButton);
}

function inspectionControls(form = document.querySelector("#task-form")) {
  return form?.querySelector("[data-bot-inspection-controls]") || null;
}

function alignInspectionControls() {
  if (!String(location.hash).startsWith(TASKS_ROUTE)) return;
  const form = document.querySelector("#task-form");
  if (!form) return;
  const select = form.querySelector("#task-skill");
  const controls = inspectionControls(form);
  if (!select || !controls) return;

  const signerSelected = select.value === "tg_signer";
  if (controls.hidden === signerSelected) controls.hidden = !signerSelected;
  const ariaHidden = signerSelected ? "false" : "true";
  if (controls.getAttribute("aria-hidden") !== ariaHidden) controls.setAttribute("aria-hidden", ariaHidden);
  if (!signerSelected || controls.dataset.signerInspectionAligned === "true") return;

  // Mark before changing text nodes to prevent observer-driven recursion.
  controls.dataset.signerInspectionAligned = "true";
  const title = controls.querySelector("h3");
  const description = controls.querySelector(".card-head p");
  const inspectButton = controls.querySelector('[data-bot-inspection-action="inspect"]');
  if (title) title.textContent = "自动识别并创建（推荐）";
  if (description) description.textContent = "填写账号、机器人和命令后开始识别。系统会读取回复按钮并自动填入签到按钮，不会在识别阶段点击。";
  if (inspectButton) inspectButton.textContent = "开始识别机器人";
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function openAutomaticSignerFlow(button) {
  if (openingInspection) return;
  openingInspection = true;
  button.disabled = true;
  const oldLabel = button.textContent;
  button.textContent = "正在打开…";

  try {
    const card = signerCard();
    const manualButton = card?.querySelector('[data-skill-hub-action="create-scheduled"][data-skill-key="tg_signer"]');
    if (!manualButton || manualButton.disabled) {
      notify("无法创建任务", "机器人按钮签到任务类型当前不可用。", "error");
      return;
    }

    manualButton.click();
    for (let attempt = 0; attempt < 80; attempt += 1) {
      await wait(50);
      const form = document.querySelector("#task-form");
      const controls = inspectionControls(form);
      if (!form || !controls) continue;

      alignInspectionControls();
      controls.hidden = false;
      controls.setAttribute("aria-hidden", "false");
      controls.scrollIntoView({ behavior: "smooth", block: "center" });

      const account = form.elements.namedItem("account_id");
      const target = form.elements.namedItem("bot");
      const command = form.elements.namedItem("command");
      const firstTarget = !account?.value ? account : !String(target?.value || "").trim() ? target : !String(command?.value || "").trim() ? command : controls.querySelector("button");
      firstTarget?.focus();
      notify("已进入自动识别流程", "依次选择账号、填写机器人和命令，然后点击“开始识别机器人”。");
      return;
    }
    notify("任务表单未能打开", "请重新进入任务类型后再试。", "error");
  } finally {
    openingInspection = false;
    if (button.isConnected) {
      button.disabled = false;
      button.textContent = oldLabel;
    }
  }
}

function syncRoute() {
  if (String(location.hash).startsWith(SKILLS_ROUTE)) mergeSignerCard();
  if (String(location.hash).startsWith(TASKS_ROUTE)) alignInspectionControls();
}

function scheduleSync() {
  if (syncScheduled) return;
  syncScheduled = true;
  queueMicrotask(() => {
    syncScheduled = false;
    syncRoute();
  });
}

function attachViewObserver() {
  if (viewObserver) return;
  const view = document.querySelector("#view");
  if (!view) return;
  viewObserver = new MutationObserver(scheduleSync);
  viewObserver.observe(view, { childList: true, subtree: true });
}

document.addEventListener("click", (event) => {
  const button = event.target.closest('[data-signer-skill-action="inspect-and-create"]');
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  void openAutomaticSignerFlow(button);
});

document.addEventListener("change", (event) => {
  if (event.target.matches("#task-skill")) queueMicrotask(alignInspectionControls);
});

window.addEventListener("hashchange", scheduleSync);
attachViewObserver();
queueMicrotask(scheduleSync);
