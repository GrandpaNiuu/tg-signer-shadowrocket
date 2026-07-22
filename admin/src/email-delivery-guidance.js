const documentRef = globalThis.document;
const authContent = documentRef?.querySelector("#auth-content") || null;

function buildDeliveryNotice() {
  const notice = documentRef.createElement("div");
  notice.className = "notice warning";
  notice.dataset.emailDeliveryGuidance = "true";
  notice.innerHTML = `<span aria-hidden="true">!</span><span><strong>没有收到验证码？</strong><br>请先检查“垃圾邮件 / Spam”和“推广邮件”，并搜索标题“Telegram 自动消息邮箱验证码”。找到后请点“不是垃圾邮件”，以后邮件更容易进入收件箱。只使用最新一封邮件中的验证码；重新发送后旧验证码立即失效。</span>`;
  return notice;
}

function applyDeliveryGuidance() {
  const form = authContent?.querySelector("#email-verification-code-form");
  if (!form || form.querySelector("[data-email-delivery-guidance]")) return;
  const sectionHead = form.querySelector(".auth-section-head");
  const notice = buildDeliveryNotice();
  if (sectionHead) sectionHead.insertAdjacentElement("afterend", notice);
  else form.prepend(notice);
}

if (authContent) {
  const observer = new MutationObserver(applyDeliveryGuidance);
  observer.observe(authContent, { childList: true, subtree: true });
  applyDeliveryGuidance();
}

export const __test = { buildDeliveryNotice };
