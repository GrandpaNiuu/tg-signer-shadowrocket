const FIELDS = [
  ["second", 0, 59],
  ["minute", 0, 59],
  ["hour", 0, 23],
  ["day-of-month", 1, 31],
  ["month", 1, 12],
  ["day-of-week", 0, 7],
];

const WEEKDAYS = new Map([
  ["Sun", 0],
  ["Mon", 1],
  ["Tue", 2],
  ["Wed", 3],
  ["Thu", 4],
  ["Fri", 5],
  ["Sat", 6],
]);

function parseInteger(value, label, min, max) {
  if (!/^\d+$/.test(value)) throw new Error(`Invalid ${label} value.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid ${label} value: expected ${min}-${max}.`);
  }
  return parsed;
}

function parseField(source, label, min, max) {
  if (!source) throw new Error(`Missing ${label} field.`);
  const values = new Set();

  for (const item of source.split(",")) {
    if (!item) throw new Error(`Invalid ${label} list.`);
    const parts = item.split("/");
    if (parts.length > 2) throw new Error(`Invalid ${label} step.`);
    const [base, stepSource] = parts;
    const step = stepSource === undefined ? 1 : parseInteger(stepSource, `${label} step`, 1, max - min + 1);
    let start;
    let end;
    if (base === "*") {
      start = min;
      end = max;
    } else if (base.includes("-")) {
      const range = base.split("-");
      if (range.length !== 2) throw new Error(`Invalid ${label} range.`);
      start = parseInteger(range[0], label, min, max);
      end = parseInteger(range[1], label, min, max);
      if (start > end) throw new Error(`Invalid ${label} range.`);
    } else {
      start = parseInteger(base, label, min, max);
      end = stepSource === undefined ? start : max;
    }
    for (let value = start; value <= end; value += step) {
      values.add(label === "day-of-week" && value === 7 ? 0 : value);
    }
  }

  return { values, wildcard: source === "*" };
}

function validateTimezone(timezone) {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: timezone }).format(new Date(0));
  } catch {
    throw new Error("Invalid IANA timezone.");
  }
}

export function parseCron(expression, timezone = "UTC") {
  if (typeof expression !== "string") throw new Error("Cron expression must be a string.");
  const originalSources = expression.trim().split(/\s+/);
  if (![5, 6].includes(originalSources.length)) {
    throw new Error("Cron expression must contain five or six fields.");
  }
  if (originalSources.length === 6 && !/^\d+$/.test(originalSources[0])) {
    throw new Error("Cron expression must select a single second per minute.");
  }
  const sources = originalSources.length === 5 ? ["0", ...originalSources] : originalSources;
  validateTimezone(timezone);
  const parsed = sources.map((source, index) => parseField(source, ...FIELDS[index]));
  return {
    second: parsed[0],
    minute: parsed[1],
    hour: parsed[2],
    dayOfMonth: parsed[3],
    month: parsed[4],
    dayOfWeek: parsed[5],
    precision: originalSources.length === 6 ? "second" : "minute",
    timezone,
  };
}

export function assertCron(expression, timezone = "UTC") {
  parseCron(expression, timezone);
  return expression;
}

function localParts(date, timezone) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
    weekday: "short",
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    second: Number(parts.second),
    minute: Number(parts.minute),
    hour: Number(parts.hour),
    dayOfMonth: Number(parts.day),
    month: Number(parts.month),
    dayOfWeek: WEEKDAYS.get(parts.weekday),
  };
}

function matchesParsed(parsed, date) {
  const local = localParts(date, parsed.timezone);
  const simpleMatch = parsed.second.values.has(local.second)
    && parsed.minute.values.has(local.minute)
    && parsed.hour.values.has(local.hour)
    && parsed.month.values.has(local.month);
  if (!simpleMatch) return false;

  const dom = parsed.dayOfMonth.values.has(local.dayOfMonth);
  const dow = parsed.dayOfWeek.values.has(local.dayOfWeek);
  if (!parsed.dayOfMonth.wildcard && !parsed.dayOfWeek.wildcard) return dom || dow;
  return dom && dow;
}

export function cronMatches(expression, timezone, date) {
  return matchesParsed(parseCron(expression, timezone), date);
}

export function nextCronDate(expression, timezone, after, maxMinutes = 527_040) {
  const parsed = parseCron(expression, timezone);
  const start = after instanceof Date ? after : new Date(after);
  if (Number.isNaN(start.getTime())) throw new Error("Invalid cron starting time.");
  const seconds = [...parsed.second.values].sort((left, right) => left - right);
  const firstMinute = Math.floor(start.getTime() / 60_000) * 60_000;
  for (let offset = 0; offset <= maxMinutes; offset += 1) {
    const minute = firstMinute + offset * 60_000;
    for (const second of seconds) {
      const timestamp = minute + second * 1_000;
      if (timestamp <= start.getTime()) continue;
      const candidate = new Date(timestamp);
      if (matchesParsed(parsed, candidate)) return candidate;
    }
  }
  throw new Error("Cron expression has no occurrence within the search window.");
}
