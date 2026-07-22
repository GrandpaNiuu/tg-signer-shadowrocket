const documentRef = globalThis.document;
const authContent = documentRef?.querySelector("#auth-content") || null;

function buildDeliveryNotice() {
  const notice = documentRef.createElement("div");
  notice.className = "notice warning";
  notice.dataset.emailDeliveryGuidance = "true";
  notice.innerHTML = `<span aria-hidden="true">!</span><span><strong>第二步：检查邮件分类</strong><br>没有收到时，请检查“垃圾邮件 / Spam”和“推广邮件”，并搜索“Telegram 自动消息邮箱验证码”。重新发送后只能使用最新验证码；找到邮件后可点击“不是垃圾邮件”。</span>`;
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
