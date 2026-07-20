const modalRoot = document.querySelector("#modal-root");
const view = document.querySelector("#view");
const APPLICATION_CREDENTIAL_NOTICE = "Telegram 应用凭据由后台统一管理，无需为每个账号重复填写。";

let observer = null;
let updateScheduled = false;

function normalizedText(node) {
  return String(node?.textContent || "").replace(/\s+/g, " ").trim();
}

function removeApplicationCredentialNotice(modal) {
  for (const notice of modal.querySelectorAll(".notice")) {
    if (normalizedText(notice).includes(APPLICATION_CREDENTIAL_NOTICE)) notice.remove();
  }
}

function removeProxyFields(form) {
  for (const details of form.querySelectorAll("details")) {
    if (normalizedText(details.querySelector("summary")).includes("代理")) details.remove();
  }
}

function disableLegacyImport(modal, form) {
  if (form.dataset.mode !== "import") return;
  form.dataset.mode = "phone-login-unavailable";
  form.innerHTML = `<div class="notice warning"><span aria-hidden="true">!</span><span>手机号登录暂时不可用，请联系平台管理员检查 Telegram 登录服务。</span></div>`;
  const submit = modal.querySelector(`button[type="submit"][form="${form.id}"]`);
  if (submit) {
    submit.disabled = true;
    submit.textContent = "手机号登录暂时不可用";
  }
}

export function simplifyAccountModal(root = modalRoot) {
  const form = root?.querySelector("#account-form");
  if (!form) return false;
  const modal = form.closest(".modal") || root;

  modal.querySelector('[role="tablist"][aria-label="添加方式"]')?.remove();
  modal.querySelector(".session-guide")?.remove();
  removeApplicationCredentialNotice(modal);
  removeProxyFields(form);
  disableLegacyImport(modal, form);

  const description = modal.querySelector(".modal-head p");
  if (description) description.textContent = "使用手机号、验证码和二步验证完成连接";
  return true;
}

export function simplifyAccountsEmptyState(root = view) {
  for (const paragraph of root?.querySelectorAll(".empty-state p") || []) {
    if (normalizedText(paragraph).includes("导入已有 Session")) {
      paragraph.textContent = "使用手机号完成登录后添加账号。";
    }
  }
}

function observeRoots() {
  if (!observer) return;
  if (modalRoot) observer.observe(modalRoot, { childList: true, subtree: true });
  if (view) observer.observe(view, { childList: true, subtree: true });
}

function applyAccountEntryPolicy() {
  observer?.disconnect();
  try {
    simplifyAccountModal();
    simplifyAccountsEmptyState();
  } finally {
    observeRoots();
  }
}

function scheduleAccountEntryPolicy() {
  if (updateScheduled) return;
  updateScheduled = true;
  queueMicrotask(() => {
    updateScheduled = false;
    applyAccountEntryPolicy();
  });
}

if (modalRoot || view) {
  observer = new MutationObserver(scheduleAccountEntryPolicy);
  observeRoots();
  applyAccountEntryPolicy();
}
