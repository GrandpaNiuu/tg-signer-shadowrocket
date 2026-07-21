const SETTINGS_HASH = "#/settings";
const PANEL_ID = "profile-branding-settings";
const FALLBACK_ID = "profile-branding-fallback";
const ALBUM_PICKER_LABEL = "选择并裁剪头像";
const ALBUM_HELP_TEXT = "从手机相册选择任意图片，可拖动、缩放并手动裁剪。";

function removeFallback() {
  document.querySelector(`#${FALLBACK_ID}`)?.remove();
}

function showFallback() {
  if (!location.hash.startsWith(SETTINGS_HASH)) {
    removeFallback();
    return;
  }
  const view = document.querySelector("#view");
  if (!view || view.querySelector(`#${PANEL_ID}`)) {
    removeFallback();
    return;
  }
  if (view.querySelector(`#${FALLBACK_ID}`)) return;

  const section = document.createElement("section");
  section.id = FALLBACK_ID;
  section.className = "card mb-md";
  section.innerHTML = `<div class="card-head"><div><h2>个人资料与平台头像</h2><p>资料模块正在连接后台服务。</p></div><span class="badge pending">等待部署</span></div>
    <div class="card-body"><div class="notice warning"><span aria-hidden="true">!</span><span>当前页面尚未取得资料接口。通常是 Worker 或 D1 migration 仍未完成部署。</span></div>
    <div class="actions mt-md"><button class="button primary" type="button" data-profile-reload>重新加载</button></div></div>`;
  const head = view.querySelector(".page-head");
  if (head) head.insertAdjacentElement("afterend", section);
  else view.prepend(section);
  section.querySelector("[data-profile-reload]")?.addEventListener("click", () => location.reload());
}

function configureAvatarInputs(root = document) {
  root.querySelectorAll?.("input[data-avatar-input]").forEach((input) => {
    if (input.getAttribute("accept") !== "image/*,.heic,.heif") input.setAttribute("accept", "image/*,.heic,.heif");
    if (input.hasAttribute("capture")) input.removeAttribute("capture");
  });
  root.querySelectorAll?.("button[data-pick-avatar]").forEach((button) => {
    if (button.textContent !== ALBUM_PICKER_LABEL) button.textContent = ALBUM_PICKER_LABEL;
  });
  root.querySelectorAll?.(".profile-avatar-editor p").forEach((paragraph) => {
    if (paragraph.textContent !== ALBUM_HELP_TEXT) paragraph.textContent = ALBUM_HELP_TEXT;
  });
}

function scheduleCheck() {
  setTimeout(() => {
    configureAvatarInputs();
    showFallback();
  }, 1200);
}

window.addEventListener("hashchange", scheduleCheck);
window.addEventListener("pageshow", scheduleCheck);
const view = document.querySelector("#view");
if (view) new MutationObserver(() => {
  configureAvatarInputs(view);
  if (view.querySelector(`#${PANEL_ID}`)) removeFallback();
  else scheduleCheck();
}).observe(view, { childList: true });
configureAvatarInputs();
scheduleCheck();
