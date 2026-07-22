const FORMAT = "telegram-checkin-tasks";
const VERSION = 1;
const PARAMS_LIMIT_BYTES = 200_000;
const EXPANDED_SKILLS = new Set(["bot_flow", "send_media", "chat_snapshot", "account_audit"]);

export class TaskTransferError extends Error {
  constructor(message, { unresolvedAccounts = [] } = {}) {
    super(message);
    this.name = "TaskTransferError";
    this.unresolvedAccounts = unresolvedAccounts;
  }
}

function text(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function nullableInteger(value) {
  return Number.isInteger(value) ? value : null;
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function cloneParams(value, index = null) {
  if (value === undefined || value === null) return null;
  if (!plainObject(value)) {
    const prefix = index === null ? "任务" : `第 ${index + 1} 个任务`;
    throw new TaskTransferError(`${prefix}的 Skill 参数无效。`);
  }
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = "";
  }
  if (!serialized || new TextEncoder().encode(serialized).length > PARAMS_LIMIT_BYTES) {
    const prefix = index === null ? "任务" : `第 ${index + 1} 个任务`;
    throw new TaskTransferError(`${prefix}的 Skill 参数过大或无法序列化。`);
  }
  return JSON.parse(serialized);
}

function portableTask(task, accountNames, accountRefs) {
  const sourceAccountId = String(task.account_id || "");
  const accountName = text(task.account_name).trim()
    || text(accountNames.get(sourceAccountId)).trim();
  if (!accountName) throw new TaskTransferError(`任务“${text(task.name, "未命名任务")}”找不到账号名称，无法导出。`);
  if (!accountRefs.has(sourceAccountId)) accountRefs.set(sourceAccountId, `account-${accountRefs.size + 1}`);
  const params = cloneParams(task.params);
  return {
    name: text(task.name).trim(),
    account_ref: accountRefs.get(sourceAccountId),
    source_account_id: sourceAccountId,
    account_name: accountName,
    skill_key: text(task.skill_key || task.skill).trim(),
    bot: text(task.bot).trim(),
    command: text(task.command),
    ...(params ? { params } : {}),
    cron: text(task.cron || task.cron_expr).trim(),
    timezone: text(task.timezone, "Asia/Shanghai").trim(),
    retry: Number.isInteger(task.retry) ? task.retry : Number(task.retry_count || 0),
    timeout_seconds: Number.isInteger(task.timeout_seconds) ? task.timeout_seconds : 120,
    thread_id: nullableInteger(task.thread_id ?? task.message_thread_id),
    delete_after_seconds: nullableInteger(task.delete_after_seconds),
    enabled: Boolean(task.enabled),
  };
}

export function buildTaskExport(tasks, accounts, { now = () => new Date() } = {}) {
  if (!Array.isArray(tasks) || !Array.isArray(accounts)) {
    throw new TaskTransferError("任务或账号数据无效，无法导出。");
  }
  const accountNames = new Map(accounts.map((account) => [String(account.id), account.name]));
  const accountRefs = new Map(accounts.map((account, index) => [String(account.id), `account-${index + 1}`]));
  return {
    format: FORMAT,
    version: VERSION,
    exported_at: now().toISOString(),
    tasks: tasks.map((task) => portableTask(task, accountNames, accountRefs)),
  };
}

function parseDocument(raw) {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      throw new TaskTransferError("导入文件不是有效的 JSON。");
    }
  }
  return raw;
}

function requiredText(value, label, index, max) {
  const result = text(value).trim();
  if (!result || result.length > max) {
    throw new TaskTransferError(`第 ${index + 1} 个任务的${label}无效。`);
  }
  return result;
}

function optionalText(value, label, index, max) {
  const result = text(value);
  if (result.length > max) throw new TaskTransferError(`第 ${index + 1} 个任务的${label}无效。`);
  return result;
}

function boundedInteger(value, label, index, min, max, fallback) {
  const result = value === undefined ? fallback : value;
  if (!Number.isInteger(result) || result < min || result > max) {
    throw new TaskTransferError(`第 ${index + 1} 个任务的${label}无效。`);
  }
  return result;
}

function optionalInteger(value, label, index, min, max) {
  if (value === null || value === undefined || value === "") return null;
  return boundedInteger(value, label, index, min, max);
}

function uniqueAccountMap(accounts) {
  const result = new Map();
  for (const account of accounts) {
    const key = text(account.name).trim().toLocaleLowerCase();
    if (!key) continue;
    if (result.has(key)) result.set(key, null);
    else result.set(key, account);
  }
  return result;
}

export function parseTaskImport(raw, { accounts = [], skills = [], accountMapping = {} } = {}) {
  const document = parseDocument(raw);
  if (!document || typeof document !== "object" || Array.isArray(document)
    || document.format !== FORMAT || document.version !== VERSION) {
    throw new TaskTransferError("这不是受支持的 Telegram 自动消息任务文件。");
  }
  if (!Array.isArray(document.tasks) || document.tasks.length < 1) {
    throw new TaskTransferError("导入文件中没有任务。");
  }

  const accountByName = uniqueAccountMap(accounts);
  const accountById = new Map(accounts.map((account) => [String(account.id), account]));
  const skillByKey = new Map(skills
    .filter((skill) => skill.enabled !== false)
    .map((skill) => [text(skill.key || skill.skill_key), skill]));
  const accountSelections = [];
  const unresolvedByRef = new Map();
  document.tasks.forEach((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new TaskTransferError(`第 ${index + 1} 个任务不是有效对象。`);
    }
    const accountName = requiredText(item.account_name, "账号名称", index, 100);
    const accountRef = text(item.account_ref).trim() || `legacy-account-${index + 1}`;
    if (accountRef.length > 100 || !/^[A-Za-z0-9._:-]+$/.test(accountRef)) {
      throw new TaskTransferError(`第 ${index + 1} 个任务的账号引用无效。`);
    }
    const sourceAccountId = text(item.source_account_id).trim();
    const mappedAccountId = Object.prototype.hasOwnProperty.call(accountMapping, accountRef)
      ? String(accountMapping[accountRef])
      : "";
    const account = (mappedAccountId && accountById.get(mappedAccountId))
      || (sourceAccountId && accountById.get(sourceAccountId))
      || accountByName.get(accountName.toLocaleLowerCase());
    if (!account) {
      if (!unresolvedByRef.has(accountRef)) {
        unresolvedByRef.set(accountRef, { account_ref: accountRef, account_name: accountName });
      }
    }
    accountSelections.push(account || null);
  });
  if (unresolvedByRef.size) {
    throw new TaskTransferError("部分任务无法唯一匹配本地账号，请为它们选择账号。", {
      unresolvedAccounts: [...unresolvedByRef.values()],
    });
  }

  let hasSignerTask = false;
  const tasks = document.tasks.map((item, index) => {
    const account = accountSelections[index];
    const skillKey = requiredText(item.skill_key, "Skill", index, 64);
    if (!skillByKey.has(skillKey)) {
      throw new TaskTransferError(`第 ${index + 1} 个任务使用了不存在或已停用的 Skill“${skillKey}”。`);
    }
    if (skillKey === "tg_signer") hasSignerTask = true;
    const retry = boundedInteger(item.retry, "重试次数", index, 0, 5, 0);
    const timeout = boundedInteger(item.timeout_seconds, "超时", index, 10, 900, 120);
    let retryDelayBudget = 0;
    for (let attempt = 0; attempt < retry; attempt += 1) retryDelayBudget += Math.min(60, 2 * (2 ** attempt));
    if (timeout * (retry + 1) + retryDelayBudget > 900) {
      throw new TaskTransferError(`第 ${index + 1} 个任务的重试与超时总预算超过 900 秒。`);
    }
    const params = cloneParams(item.params, index);
    const expanded = EXPANDED_SKILLS.has(skillKey) && params !== null;
    return {
      name: requiredText(item.name, "名称", index, 100),
      account_id: String(account.id),
      skill_key: skillKey,
      bot: expanded ? optionalText(item.bot, "Bot / Chat", index, 128) : requiredText(item.bot, "Bot / Chat", index, 128),
      command: expanded ? optionalText(item.command, "Command", index, 2000) : requiredText(item.command, "Command", index, 2000),
      ...(params ? { params } : {}),
      cron: requiredText(item.cron, "Cron", index, 96),
      timezone: requiredText(item.timezone || "Asia/Shanghai", "时区", index, 64),
      retry,
      timeout_seconds: timeout,
      thread_id: optionalInteger(item.thread_id, "Thread ID", index, 1, 2_147_483_647),
      delete_after_seconds: optionalInteger(item.delete_after_seconds, "Delete After", index, 0, 86_400),
      enabled: false,
    };
  });

  const warnings = ["为避免导入后意外发送消息，所有任务均默认停用，请逐项检查后再启用。"];
  if (hasSignerTask) warnings.push("tg_signer 的加密配置不会导出；导入后需要重新编辑并提供配置。");
  return { tasks, warnings };
}

function copyLegacyFields(task, skillKey, params) {
  if (!params || !EXPANDED_SKILLS.has(skillKey)) {
    return {
      bot: text(task.bot),
      command: text(task.command),
      thread_id: task.thread_id ?? task.message_thread_id ?? null,
      delete_after_seconds: task.delete_after_seconds ?? null,
    };
  }
  if (skillKey === "bot_flow") {
    return {
      bot: text(params.target),
      command: JSON.stringify({ steps: params.steps || [] }),
      thread_id: params.message_thread_id ?? null,
      delete_after_seconds: null,
    };
  }
  if (skillKey === "send_media") {
    const source = params.source_chat_id !== undefined
      ? { source_chat_id: params.source_chat_id, source_message_id: params.source_message_id }
      : { file_id: params.file_id, media_type: params.media_type };
    return {
      bot: text(params.target),
      command: JSON.stringify({ ...source, caption: params.caption ?? null }),
      thread_id: params.message_thread_id ?? null,
      delete_after_seconds: params.delete_after ?? null,
    };
  }
  if (skillKey === "chat_snapshot") {
    return {
      bot: text(params.target),
      command: JSON.stringify({ limit: params.limit ?? 20, keyword: params.keyword ?? null }),
      thread_id: null,
      delete_after_seconds: null,
    };
  }
  return { bot: "", command: "", thread_id: null, delete_after_seconds: null };
}

export function copyTaskDraft(task) {
  const skillKey = task.skill_key || task.skill || "send_text";
  const params = cloneParams(task.params);
  const legacy = copyLegacyFields(task, skillKey, params);
  return {
    name: `${text(task.name, "任务")}（副本）`.slice(0, 100),
    account_id: task.account_id || "",
    skill_key: skillKey,
    ...legacy,
    ...(params ? { params } : {}),
    cron: text(task.cron || task.cron_expr, "0 0 * * *"),
    timezone: text(task.timezone, "Asia/Shanghai"),
    retry: Number.isInteger(task.retry) ? task.retry : Number(task.retry_count || 0),
    timeout_seconds: Number.isInteger(task.timeout_seconds) ? task.timeout_seconds : 120,
    has_tg_signer_import: false,
    enabled: false,
  };
}

export const __test = { cloneParams, copyLegacyFields, EXPANDED_SKILLS, PARAMS_LIMIT_BYTES };
