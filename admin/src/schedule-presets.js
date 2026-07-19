function boundedInteger(value, name, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new RangeError(`${name} must be between ${min} and ${max}`);
  }
  return number;
}

export function schedulePresetFromCron(cron) {
  const originalParts = String(cron || "").trim().split(/\s+/);
  if (![5, 6].includes(originalParts.length)) return { mode: "custom", cron: String(cron || "") };
  const parts = originalParts.length === 5 ? ["0", ...originalParts] : originalParts;
  const second = /^\d+$/.test(parts[0]) ? Number(parts[0]) : null;
  const minute = /^\d+$/.test(parts[1]) ? Number(parts[1]) : null;
  const hour = /^\d+$/.test(parts[2]) ? Number(parts[2]) : null;
  const weekday = /^\d+$/.test(parts[5]) ? Number(parts[5]) : null;
  const validSecond = second !== null && second >= 0 && second <= 59;
  const validMinute = minute !== null && minute >= 0 && minute <= 59;
  const validHour = hour !== null && hour >= 0 && hour <= 23;
  const intervalMatch = /^\*\/([1-9]|[1-5]\d)$/.exec(parts[1]);
  if (validSecond && intervalMatch && parts.slice(2).every((part) => part === "*")) {
    return { mode: "interval", second, interval: Number(intervalMatch[1]) };
  }
  if (validSecond && validMinute && parts[2] === "*" && parts.slice(3).every((part) => part === "*")) {
    return { mode: "hourly", second, minute };
  }
  if (validSecond && validMinute && validHour && parts[3] === "*" && parts[4] === "*"
    && weekday !== null && weekday >= 0 && weekday <= 6) {
    return { mode: "weekly", second, minute, hour, weekday };
  }
  if (validSecond && validMinute && validHour && parts.slice(3).every((part) => part === "*")) {
    return {
      mode: "daily",
      second,
      minute,
      hour,
    };
  }
  return { mode: "custom", cron: String(cron || "") };
}

export function cronFromSchedulePreset(input) {
  const second = boundedInteger(input?.second ?? 0, "second", 0, 59);
  if (input?.mode === "daily") {
    const minute = boundedInteger(input.minute, "minute", 0, 59);
    const hour = boundedInteger(input.hour, "hour", 0, 23);
    return `${second} ${minute} ${hour} * * *`;
  }
  if (input?.mode === "weekly") {
    const minute = boundedInteger(input.minute, "minute", 0, 59);
    const hour = boundedInteger(input.hour, "hour", 0, 23);
    const weekday = boundedInteger(input.weekday, "weekday", 0, 6);
    return `${second} ${minute} ${hour} * * ${weekday}`;
  }
  if (input?.mode === "hourly") {
    return `${second} ${boundedInteger(input.minute, "minute", 0, 59)} * * * *`;
  }
  if (input?.mode === "interval") {
    return `${second} */${boundedInteger(input.interval, "interval", 1, 59)} * * * *`;
  }
  return String(input?.cron || "").trim();
}
