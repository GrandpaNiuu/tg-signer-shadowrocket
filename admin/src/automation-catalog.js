export const AUTOMATION_CATALOG = Object.freeze({
  send_text: Object.freeze({
    key: "send_text",
    title: "定时发送文字或命令",
    shortName: "发送消息/命令",
    icon: "发",
    badge: "定时执行",
    audience: "all",
    mode: "scheduled",
    description: "到达设定时间后，向机器人、用户、群组或频道发送一段文字或命令，然后结束。",
    purpose: "每日提醒、普通消息，以及发送 /checkin 就能完成的签到。",
    required: "Telegram 账号、接收方、消息、执行时间",
    execution: "统一 Runner 按计划执行，并记录结果与发送通知",
    actionLabel: "新建文字消息",
    defaultName: "定时发送消息",
  }),
  tg_signer: Object.freeze({
    key: "tg_signer",
    title: "机器人按钮签到",
    shortName: "按钮签到",
    icon: "签",
    badge: "定时执行",
    audience: "all",
    mode: "scheduled",
    description: "先发送命令，再等待机器人回复、查找指定按钮并点击，可按回复关键词确认结果。",
    purpose: "发送命令后还要点击“签到”“领取”等按钮的机器人。",
    required: "Telegram 账号、机器人、命令、按钮文字、执行时间",
    execution: "统一 Runner 执行完整交互流程，并记录结果与发送通知",
    actionLabel: "新建按钮签到",
    defaultName: "机器人按钮签到",
  }),
  send_media: Object.freeze({
    key: "send_media",
    title: "定时发送任意内容",
    shortName: "任意内容",
    icon: "发",
    badge: "定时执行",
    audience: "all",
    mode: "scheduled",
    description: "在指定时间复制任意一条 Telegram 消息，不限制文字、图片、视频、文件、语音、贴纸或位置。",
    purpose: "定时发送固定内容；所有 Telegram 消息类型使用同一套流程。",
    required: "Telegram 账号、发送目标、来源消息、执行时间",
    execution: "统一 Runner 原样复制内容，并记录结果与发送完整回执",
    actionLabel: "新建任意内容",
    defaultName: "定时发送任意内容",
  }),
  keyword_reply: Object.freeze({
    key: "keyword_reply",
    title: "24 小时关键词自动回复",
    shortName: "关键词自动回复",
    icon: "回",
    badge: "实时运行",
    audience: "admin",
    mode: "realtime",
    description: "持续监听指定会话，消息命中关键词后立即发送预设回复。",
    purpose: "客服问答、价格咨询、常见问题和全天候固定回复。",
    required: "Telegram 账号、监听范围、关键词、回复内容",
    execution: "实时监听服务持续运行；每次命中默认由通知机器人汇报",
    actionLabel: "新建自动回复规则",
    defaultName: "关键词自动回复",
  }),
  group_monitor: Object.freeze({
    key: "group_monitor",
    title: "实时消息监控",
    shortName: "消息监控",
    icon: "监",
    badge: "实时运行",
    audience: "admin",
    mode: "realtime",
    description: "持续监控指定群组或会话，按关键词筛选并保存命中的消息。",
    purpose: "采购线索、售后关键词、群内重要消息和业务提醒。",
    required: "Telegram 账号、监控范围；关键词可选",
    execution: "实时监听服务持续运行；每次命中默认由通知机器人汇报",
    actionLabel: "新建消息监控规则",
    defaultName: "消息监控",
  }),
});

export const SCHEDULED_AUTOMATIONS = Object.freeze(["send_text", "tg_signer", "send_media"]);
export const REALTIME_AUTOMATIONS = Object.freeze(["keyword_reply", "group_monitor"]);
export const RETIRED_AUTOMATIONS = Object.freeze(["account_audit", "bot_flow", "chat_snapshot"]);

export function automationDefinition(key) {
  return AUTOMATION_CATALOG[String(key || "").trim()] || null;
}

export function scheduledAutomationDefinition(key) {
  const definition = automationDefinition(key);
  return definition?.mode === "scheduled" ? definition : null;
}
