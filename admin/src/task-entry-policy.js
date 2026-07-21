function ensureSkillCatalogLink(container, { compact = false } = {}) {
  if (!container || container.querySelector('[data-task-entry-policy="skill-catalog"]')) return;
  const link = document.createElement("a");
  link.href = "#/skills";
  link.className = compact ? "button" : "button primary";
  link.dataset.taskEntryPolicy = "skill-catalog";
  link.textContent = "选择任务类型";
  container.prepend(link);
}

function enforcePrimaryTaskEntry() {
  if (!String(location.hash).startsWith("#/tasks")) return;

  for (const button of document.querySelectorAll('[data-action="add-task"]')) {
    button.hidden = true;
    button.setAttribute("aria-hidden", "true");
    button.tabIndex = -1;
    ensureSkillCatalogLink(button.parentElement, {
      compact: Boolean(button.closest(".empty-state")),
    });
  }

  const realtimeSection = document.querySelector("[data-skill-hub-realtime-tasks]");
  const directActions = realtimeSection?.querySelector(".card-body > .actions.mb-md");
  if (directActions && directActions.dataset.taskEntryPolicy !== "managed") {
    directActions.dataset.taskEntryPolicy = "managed";
    directActions.innerHTML = '<a class="button primary" href="#/skills" data-task-entry-policy="skill-catalog">选择任务类型</a><span class="field-help">新增功能统一从“任务类型”开始；这里仅管理已有任务。</span>';
  }
}

let scheduled = false;
const observer = typeof MutationObserver === "undefined" ? null : new MutationObserver(() => {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    enforcePrimaryTaskEntry();
  });
});

if (observer) observer.observe(document.body, { childList: true, subtree: true });
window.addEventListener("hashchange", () => queueMicrotask(enforcePrimaryTaskEntry));
queueMicrotask(enforcePrimaryTaskEntry);
