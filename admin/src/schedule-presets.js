function boundedInteger(value, name, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new RangeError(`${name} must be between ${min} and ${max}`);
  }
  return number;
}

export function schedulePresetFromCron(cron) {
  const parts = String(cron || "").trim().split(/\s+/);
  if (parts.length !== 5) return { mode: "custom", cron: String(cron || "") };
  const minute = /^\d+$/.test(parts[0]) ? Number(parts[0]) : null;
  const hour = /^\d+$/.test(parts[1]) ? Number(parts[1]) : null;
  const weekday = /^\d+$/.test(parts[4]) ? Number(parts[4]) : null;
  const validMinute = minute !== null && minute >= 0 && minute <= 59;
  const validHour = hour !== null && hour >= 0 && hour <= 23;
  const intervalMatch = /^\*\/([1-9]|[1-5]\d)$/.exec(parts[0]);
  if (intervalMatch && parts.slice(1).every((part) => part === "*")) {
    return { mode: "interval", interval: Number(intervalMatch[1]) };
  }
  if (validMinute && parts[1] === "*" && parts.slice(2).every((part) => part === "*")) {
    return { mode: "hourly", minute };
  }
  if (validMinute && validHour && parts[2] === "*" && parts[3] === "*"
    && weekday !== null && weekday >= 0 && weekday <= 6) {
    return { mode: "weekly", minute, hour, weekday };
  }
  if (validMinute && validHour && parts.slice(2).every((part) => part === "*")) {
    return {
      mode: "daily",
      minute,
      hour,
    };
  }
  return { mode: "custom", cron: String(cron || "") };
}

export function cronFromSchedulePreset(input) {
  if (input?.mode === "daily") {
    const minute = boundedInteger(input.minute, "minute", 0, 59);
    const hour = boundedInteger(input.hour, "hour", 0, 23);
    return `${minute} ${hour} * * *`;
  }
  if (input?.mode === "weekly") {
    const minute = boundedInteger(input.minute, "minute", 0, 59);
    const hour = boundedInteger(input.hour, "hour", 0, 23);
    const weekday = boundedInteger(input.weekday, "weekday", 0, 6);
    return `${minute} ${hour} * * ${weekday}`;
  }
  if (input?.mode === "hourly") {
    return `${boundedInteger(input.minute, "minute", 0, 59)} * * * *`;
  }
  if (input?.mode === "interval") {
    return `*/${boundedInteger(input.interval, "interval", 1, 59)} * * * *`;
  }
  return String(input?.cron || "").trim();
}
