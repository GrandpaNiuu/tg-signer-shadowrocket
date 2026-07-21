const EXPANDED_SKILLS = new Set(["bot_flow", "send_media", "chat_snapshot", "account_audit"]);
const LABELS = Object.freeze({
  bot_flow: "创建机器人流程任务",
  send_media: "创建媒体发送任务",
  chat_snapshot: "创建聊天快照任务",
  account_audit: "创建账号检查任务",
});

let pending = null;
let scheduled = false;

function skillKey(card) {
  return card.querySelector(".skill-meta strong.mono")?.textContent?.trim() || "";
}

function addEntryButtons() {
  for (const card of document.querySelectorAll(".skill-grid .skill-card:not([data-skill-hub-capability])")) {
    const key = skillKey(card);
    if (!EXPANDED_SKILLS.has(key) || card.querySelector("[data-expanded-skill-create]")) continue;
    const disabled = Boolean(card.querySelector(".badge.disabled"));
    const actions = document.createElement("div");
    actions.className = "actions mt-md";
    actions.dataset.expandedSkillEntry = "true";
    actions.innerHTML = `<button class="button primary" type="button" data-expanded-skill-create="${key}" ${disabled ? "disabled" : ""}>${LABELS[key]}</button>`;
    card.append(actions);
  }
}

function applyPending() {
  if (!pending || Date.now() - pending.startedAt > 15_000) {
    pending = null;
    return;
  }
  if (!String(location.hash).startsWith("#/tasks")) return;
  let form = document.querySelector("#task-form");
  if (!form) {
    const add = document.querySelector('[data-action="add-task"]');
    if (add && !add.disabled) add.click();
    form = document.querySelector("#task-form");
  }
  if (!form) return;
  const select = form.querySelector("#task-skill");
  const option = select && [...select.options].find((item) => item.value === pending.key && !item.disabled);
  if (!option) {
    pending = null;
    return;
  }
  select.value = pending.key;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  pending = null;
}

function scheduleApply() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    addEntryButtons();
    applyPending();
  });
}

if (typeof document !== "undefined") {
  const observer = new MutationObserver(scheduleApply);
  observer.observe(document.body, { childList: true, subtree: true });
  document.addEventListener("click", (event) => {
    const button = event.target?.closest?.("[data-expanded-skill-create]");
    if (!button) return;
    pending = { key: button.dataset.expandedSkillCreate, startedAt: Date.now() };
    if (!String(location.hash).startsWith("#/tasks")) location.hash = "#/tasks";
    scheduleApply();
  });
  window.addEventListener("hashchange", scheduleApply);
  scheduleApply();
}

export const __test = { EXPANDED_SKILLS, LABELS };
