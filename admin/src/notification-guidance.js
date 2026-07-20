const view = document.querySelector("#view");
let applying = false;

const replacements = new Map([
  [
    "通知只影响任务结果提醒，不会改变任务内容，也不会影响自动执行。",
    "这是管理员统一通知通道：所有用户工作区的任务结果都会播报到同一个 Telegram 会话，不会改变任务内容或自动执行。",
  ],
  [
    "可先发送一条测试通知；启用后，每次任务结束都会推送摘要。",
    "可先发送测试通知；启用后，所有用户的任务结束都会推送简洁摘要。",
  ],
  [
    "成功与失败都会发送任务名、耗时、Actions 链接和脱敏日志尾部。",
    "管理员统一接收所有用户结果；成功消息保持简洁，失败消息显示原因，并提供“查看执行详情”按钮。",
  ],
]);

function applyNotificationGuidance() {
  if (applying || !view) return;
  applying = true;
  try {
    const section = view.querySelector("#notification-settings");
    if (!section) return;
    for (const element of section.querySelectorAll("p, small")) {
      const replacement = replacements.get(element.textContent.trim());
      if (replacement) element.textContent = replacement;
    }
    const title = section.querySelector(".settings-title-row h2");
    if (title && title.textContent.trim() === "任务结果通知") {
      title.textContent = "全平台任务结果通知";
    }
  } finally {
    applying = false;
  }
}

if (view) {
  new MutationObserver(applyNotificationGuidance).observe(view, { childList: true, subtree: true });
  applyNotificationGuidance();
}
