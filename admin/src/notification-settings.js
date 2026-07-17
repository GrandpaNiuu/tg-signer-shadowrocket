const BOT_TOKEN = /^\d{5,16}:[A-Za-z0-9_-]{20,128}$/;
const CHAT_ID = /^(?:-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{3,31})$/;

export function validateNotificationSettings(input, { clearBotToken = false, clearChatId = false } = {}) {
  const errors = {};
  const botToken = String(input.bot_token || "").trim();
  const chatId = String(input.chat_id || "").trim();
  if (botToken && !BOT_TOKEN.test(botToken)) errors.bot_token = "请输入有效的 Telegram Bot Token。";
  if (chatId && !CHAT_ID.test(chatId)) errors.chat_id = "请输入数字 Chat ID 或 @频道用户名。";
  if (clearBotToken && botToken) errors.bot_token = "替换 Bot Token 与清除 Bot Token 不能同时选择。";
  if (clearChatId && chatId) errors.chat_id = "替换 Chat ID 与清除 Chat ID 不能同时选择。";
  return errors;
}

export function buildNotificationSettingsPatch(input, { clearBotToken = false, clearChatId = false } = {}) {
  const patch = {};
  const botToken = String(input.bot_token || "").trim();
  const chatId = String(input.chat_id || "").trim();
  if (clearBotToken) patch.bot_token = null;
  else if (botToken) patch.bot_token = botToken;
  if (clearChatId) patch.chat_id = null;
  else if (chatId) patch.chat_id = chatId;
  return patch;
}
