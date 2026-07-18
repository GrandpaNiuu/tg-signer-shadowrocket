const CRON_PART = /^[\d*,/\-]+$/;
const API_HASH = /^[a-f\d]{32,64}$/i;
const BOT_USERNAME = /^@[A-Za-z][A-Za-z0-9_]{3,31}$/;
const CHAT_ID = /^-?\d+$/;
const PROXY_HOST = /^[A-Za-z0-9._:-]+$/;
const PROXY_PROTOCOLS = new Set(["http", "https", "socks4", "socks5", "socks5h"]);

function required(value) { return String(value ?? "").trim().length > 0; }
function integerInRange(value, min, max) {
  if (value === "" || value === null || value === undefined) return false;
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max;
}

export function validateAccount(input, { requireSession = false } = {}) {
  const errors = {};
  if ((requireSession && !required(input.name)) || String(input.name || "").trim().length > 80) {
    errors.name = "请输入 1–80 个字符的账号名称。";
  }
  const apiId = String(input.api_id || "").trim();
  const apiHash = String(input.api_hash || "").trim();
  if (apiId || apiHash) {
    if (!/^\d{4,12}$/.test(apiId)) errors.api_id = "API_ID 应为 4–12 位数字。";
    if (!/^[a-f\d]{32,64}$/i.test(apiHash)) errors.api_hash = "API_HASH 应为 32–64 位十六进制字符串。";
  }
  if (input.phone && !/^\+[1-9]\d{6,14}$/.test(input.phone.replace(/[\s-]/g, ""))) errors.phone = "请输入带国家区号的手机号，例如 +8613812345678。";
  if (!input.phone) errors.phone = "请输入手机号。";
  if (requireSession && (!required(input.session) || input.session.length < 20 || input.session.length > 16384)) errors.session = "请输入有效的 Session。";
  if (input.proxy?.host) {
    if (input.proxy.host.length > 255) errors.proxy_host = "代理地址过长。";
    if (!integerInRange(input.proxy.port, 1, 65535)) errors.proxy_port = "代理端口应在 1–65535 之间。";
  }
  return errors;
}

function hasProxyInput(proxy) {
  if (!proxy || typeof proxy !== "object" || Array.isArray(proxy)) return false;
  return [proxy.host, proxy.port, proxy.username, proxy.password]
    .some((value) => String(value ?? "").trim().length > 0);
}

export function validateAccountPatch(input, { clearSession = false, clearProxy = false } = {}) {
  const errors = {};
  const name = String(input.name ?? "").trim();
  const phone = String(input.phone ?? "").trim();
  const apiId = String(input.api_id ?? "").trim();
  const apiHash = String(input.api_hash ?? "").trim();
  const session = String(input.session ?? "").trim();

  if (!name || name.length > 80) errors.name = "请输入 1–80 个字符的账号名称。";
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") errors.enabled = "请选择有效的启用状态。";
  if (phone && !/^\+[1-9]\d{6,14}$/.test(phone.replace(/[\s-]/g, ""))) {
    errors.phone = "请输入带国家区号的手机号，例如 +8613812345678。";
  }
  if (apiId && !/^\d{4,12}$/.test(apiId)) errors.api_id = "API_ID 应为 4–12 位数字。";
  if (apiHash && !/^[a-f\d]{32,64}$/i.test(apiHash)) errors.api_hash = "API_HASH 应为 32–64 位十六进制字符串。";
  if (session && (session.length < 20 || session.length > 16_384)) errors.session = "请输入有效的 Session（20–16384 个字符）。";
  if (clearSession && session) errors.session = "替换 Session 与清除 Session 不能同时选择。";

  const proxyProvided = hasProxyInput(input.proxy);
  if (clearProxy && proxyProvided) {
    errors.proxy_host = "替换代理与清除代理不能同时选择。";
  } else if (proxyProvided) {
    const proxy = input.proxy;
    const protocol = String(proxy.protocol || "");
    const host = String(proxy.host || "").trim();
    if (!PROXY_PROTOCOLS.has(protocol)) errors.proxy_protocol = "请选择有效的代理协议。";
    if (!host || host.length > 253 || !PROXY_HOST.test(host)) errors.proxy_host = "请输入有效的代理地址。";
    if (!integerInRange(proxy.port, 1, 65_535)) errors.proxy_port = "代理端口应在 1–65535 之间。";
    if (String(proxy.username || "").trim().length > 255) errors.proxy_username = "代理用户名不能超过 255 个字符。";
    if (String(proxy.password || "").trim().length > 1_024) errors.proxy_password = "代理密码不能超过 1024 个字符。";
  }
  return errors;
}

export function buildAccountPatch(input, { clearSession = false, clearProxy = false } = {}) {
  const patch = {
    name: String(input.name ?? "").trim(),
    enabled: Boolean(input.enabled),
  };
  const optionalStrings = {
    phone: String(input.phone ?? "").replace(/[\s-]/g, ""),
    api_id: String(input.api_id ?? "").trim(),
    api_hash: String(input.api_hash ?? "").trim(),
  };
  for (const [field, value] of Object.entries(optionalStrings)) {
    if (value) patch[field] = value;
  }
  const session = String(input.session ?? "").trim();
  if (clearSession) patch.session = null;
  else if (session) patch.session = session;

  if (clearProxy) {
    patch.proxy = null;
  } else if (hasProxyInput(input.proxy)) {
    patch.proxy = {
      protocol: String(input.proxy.protocol || "socks5"),
      host: String(input.proxy.host || "").trim(),
      port: Number(input.proxy.port),
    };
    const username = String(input.proxy.username || "").trim();
    const password = String(input.proxy.password || "").trim();
    if (username) patch.proxy.username = username;
    if (password) patch.proxy.password = password;
  }
  return patch;
}

export function validateTask(input) {
  const errors = {};
  if (!required(input.name) || input.name.trim().length > 100) errors.name = "请输入 1–100 个字符的任务名称。";
  if (!required(input.account_id)) errors.account_id = "请选择账号。";
  if (!required(input.skill_key)) errors.skill_key = "请选择 Skill。";
  const bot = String(input.bot || "").trim();
  if (!BOT_USERNAME.test(bot) && !CHAT_ID.test(bot)) errors.bot = "请输入 @机器人用户名或数字 Chat ID。";
  if (!required(input.command) || input.command.length > 2000) errors.command = "请输入不超过 2000 个字符的命令。";
  if (input.skill_key === "tg_signer" && !required(input.tg_signer_import) && !input._has_tg_signer_import) {
    errors.tg_signer_import = "首次创建 tg_signer 任务时，请导入该任务的配置。";
  }
  if (!validateCron(input.cron)) errors.cron = "请输入标准 5 段 Cron 表达式。";
  if (!required(input.timezone) || input.timezone.length > 64) errors.timezone = "请选择时区。";
  if (!integerInRange(input.retry, 0, 5)) errors.retry = "重试次数应在 0–5 之间。";
  if (!integerInRange(input.timeout_seconds, 10, 900)) errors.timeout_seconds = "超时应在 10–900 秒之间。";
  if (!errors.retry && !errors.timeout_seconds) {
    const retryDelayBudget = Array.from(
      { length: Number(input.retry) },
      (_, index) => Math.min(60, 2 * (2 ** index)),
    ).reduce((total, value) => total + value, 0);
    const executionBudget = Number(input.timeout_seconds) * (Number(input.retry) + 1) + retryDelayBudget;
    if (executionBudget > 900) {
      errors.timeout_seconds = "Timeout 与 Retry 的最坏执行时间必须不超过 900 秒。";
    }
  }
  if (input.thread_id !== "" && input.thread_id !== null && input.thread_id !== undefined && !integerInRange(input.thread_id, 1, 2147483647)) errors.thread_id = "Thread ID 应为正整数。";
  if (input.delete_after_seconds !== "" && input.delete_after_seconds !== null && input.delete_after_seconds !== undefined && !integerInRange(input.delete_after_seconds, 0, 86400)) errors.delete_after_seconds = "删除等待时间应在 0–86400 秒之间。";
  if (
    !errors.timeout_seconds
    && !errors.delete_after_seconds
    && input.delete_after_seconds !== ""
    && input.delete_after_seconds !== null
    && input.delete_after_seconds !== undefined
    && Number(input.delete_after_seconds) > Number(input.timeout_seconds) - 10
  ) {
    errors.delete_after_seconds = "Delete After 必须至少比任务超时短 10 秒。";
  }
  return errors;
}

export function validateCron(value) {
  const parts = String(value || "").trim().split(/\s+/);
  return parts.length === 5 && parts.every((part) => part.length <= 32 && CRON_PART.test(part));
}

function parseCronPart(text, min, max, normalize = (value) => value) {
  const values = new Set();
  for (const segment of text.split(",")) {
    const [rangeText, stepText] = segment.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1 || step > max - min + 1) return null;
    let start = min;
    let end = max;
    if (rangeText !== "*") {
      if (rangeText.includes("-")) {
        const parts = rangeText.split("-").map(Number);
        if (parts.length !== 2 || parts.some((part) => !Number.isInteger(part))) return null;
        [start, end] = parts;
      } else {
        start = Number(rangeText);
        end = start;
      }
    }
    if (start < min || end > max || start > end) return null;
    for (let value = start; value <= end; value += step) values.add(normalize(value));
  }
  return values;
}

export function nextCronOccurrences(expression, timezone, count = 5, from = new Date()) {
  if (!validateCron(expression) || count < 1) return [];
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      minute: "numeric",
      hour: "numeric",
      day: "numeric",
      month: "numeric",
      weekday: "short",
      hourCycle: "h23",
    });
  } catch {
    return [];
  }
  const [minuteText, hourText, dayText, monthText, weekdayText] = expression.trim().split(/\s+/);
  const minutes = parseCronPart(minuteText, 0, 59);
  const hours = parseCronPart(hourText, 0, 23);
  const days = parseCronPart(dayText, 1, 31);
  const months = parseCronPart(monthText, 1, 12);
  const weekdays = parseCronPart(weekdayText, 0, 7, (value) => value === 7 ? 0 : value);
  if (![minutes, hours, days, months, weekdays].every(Boolean)) return [];
  const weekdayNumbers = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const wildcardDay = dayText === "*";
  const wildcardWeekday = weekdayText === "*";
  const results = [];
  const cursor = new Date(from);
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  // Sign-in tasks are normally daily. A 45-day preview keeps the UI responsive
  // while still catching common timezone and day-of-week mistakes.
  const limit = 45 * 24 * 60;
  for (let index = 0; index < limit && results.length < count; index += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(cursor).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    const dayMatch = days.has(Number(parts.day));
    const weekdayMatch = weekdays.has(weekdayNumbers[parts.weekday]);
    const calendarMatch = wildcardDay && wildcardWeekday
      ? true
      : wildcardDay ? weekdayMatch
        : wildcardWeekday ? dayMatch
          : dayMatch || weekdayMatch;
    if (minutes.has(Number(parts.minute)) && hours.has(Number(parts.hour)) && months.has(Number(parts.month)) && calendarMatch) {
      results.push(new Date(cursor));
    }
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return results;
}

export function validateSettings(input) {
  const errors = {};
  if (!required(input.default_timezone) || input.default_timezone.length > 64) errors.default_timezone = "请选择默认时区。";
  if (!["legacy", "d1"].includes(input.scheduler_mode)) errors.scheduler_mode = "请选择调度模式。";
  return errors;
}

export function validateTelegramApplicationSettings(input) {
  const errors = {};
  const apiId = String(input.api_id || "").trim();
  const apiHash = String(input.api_hash || "").trim();
  if (!apiId && !apiHash) return errors;
  if (!/^\d{4,12}$/.test(apiId)) errors.telegram_api_id = "API_ID 应为 4–12 位数字。";
  if (!API_HASH.test(apiHash)) errors.telegram_api_hash = "API_HASH 应为 32–64 位十六进制字符串。";
  return errors;
}

export function hasErrors(errors) { return Object.keys(errors).length > 0; }

export const __test = { hasProxyInput, integerInRange, parseCronPart, required };
