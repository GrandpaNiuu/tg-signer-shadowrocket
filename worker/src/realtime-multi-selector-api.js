import { HttpError, json, readJson } from "./http.js";
import { assertRealtimeTransitionAllowed } from "./realtime-repository.js";

const RULE_KINDS = new Set(["keyword_reply", "group_monitor"]);
const REPLY_TRIGGER_MODES = new Set(["keyword", "reply_to_own", "keyword_or_reply_to_own"]);
const TARGET_PATTERN = /^(?:\*|@[A-Za-z][A-Za-z0-9_]{3,31}|-?\d{1,20})$/;
const MAX_SELECTORS = 50;
const MAX_SELECTOR_LENGTH = 128;
const MAX_SERIALIZED_LENGTH = 4_096;

function objectBody(value) {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new HttpError(422, "validation_failed", "请求内容格式不正确。", { fields: ["body"] });
  }
  return value;
}

function text(value, field, { required = true, maximum = 500 } = {}) {
  const output = String(value ?? "").trim();
  if (required && !output) {
    throw new HttpError(422, "validation_failed", "请检查填写内容。", { fields: [field] });
  }
  if (output.length > maximum) {
    throw new HttpError(422, "validation_failed", "填写内容过长。", { fields: [field] });
  }
  return output;
}

function booleanValue(value, fallback = false) {
  return value === undefined ? fallback : value === true;
}

export function parseRealtimeSelectors(value) {
  if (Array.isArray(value)) return value;
  const source = String(value ?? "").trim();
  if (!source) return [];
  if (source.startsWith("[")) {
    try {
      const parsed = JSON.parse(source);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Fall back to comma/newline parsing for manually entered values.
    }
  }
  return source.split(/[\n,]+/);
}

export function normalizeRealtimeSelectors(value, field = "chat_selector") {
  const rawSelectors = parseRealtimeSelectors(value);
  const selectors = [];
  const seen = new Set();

  for (const rawSelector of rawSelectors) {
    const selector = String(rawSelector ?? "").trim();
    if (!selector) continue;
    if (selector.length > MAX_SELECTOR_LENGTH || !TARGET_PATTERN.test(selector)) {
      throw new HttpError(
        422,
        "validation_failed",
        "监听范围只能包含 @用户名、数字 Chat ID 或 *。多个会话请逐项选择。",
        { fields: [field] },
      );
    }
    const dedupeKey = selector.startsWith("@") ? selector.toLowerCase() : selector;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    selectors.push(selector);
  }

  if (!selectors.length) {
    throw new HttpError(422, "validation_failed", "请至少选择一个监听或自动回复会话。", { fields: [field] });
  }
  if (selectors.length > MAX_SELECTORS) {
    throw new HttpError(422, "validation_failed", `每条实时规则最多选择 ${MAX_SELECTORS} 个会话。`, { fields: [field] });
  }
  if (selectors.includes("*") && selectors.length > 1) {
    throw new HttpError(422, "validation_failed", "“全部会话”不能与具体会话同时选择。", { fields: [field] });
  }

  const serialized = selectors.length === 1 ? selectors[0] : selectors.join(",");
  if (serialized.length > MAX_SERIALIZED_LENGTH) {
    throw new HttpError(422, "validation_failed", "选择的会话数量或内容过长。", { fields: [field] });
  }
  return serialized;
}

function mapRule(row) {
  if (!row) return null;
  return {
    id: row.id,
    account_id: row.account_id,
    account_name: row.account_name,
    kind: row.kind,
    name: row.name,
    chat_selector: row.chat_selector,
    keyword: row.keyword,
    response_text: row.response_text,
    trigger_mode: row.trigger_mode || "keyword",
    case_sensitive: Boolean(row.case_sensitive),
    notify_on_match: row.notify_on_match === undefined ? true : Boolean(row.notify_on_match),
    enabled: Boolean(row.enabled),
    last_event_at: row.last_event_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function ruleInput(body, { patch = false } = {}) {
  const value = objectBody(body);
  const output = {};
  if (!patch || value.account_id !== undefined) output.account_id = text(value.account_id, "account_id", { maximum: 160 });
  if (!patch || value.kind !== undefined) {
    output.kind = text(value.kind, "kind", { maximum: 40 });
    if (!RULE_KINDS.has(output.kind)) {
      throw new HttpError(422, "validation_failed", "实时规则类型不受支持。", { fields: ["kind"] });
    }
  }
  if (!patch || value.name !== undefined) output.name = text(value.name, "name", { maximum: 100 });
  if (!patch || value.chat_selector !== undefined) {
    output.chat_selector = normalizeRealtimeSelectors(value.chat_selector ?? "*", "chat_selector");
  }
  if (!patch || value.keyword !== undefined) output.keyword = text(value.keyword ?? "", "keyword", { required: false, maximum: 200 });
  if (!patch || value.response_text !== undefined) {
    output.response_text = value.response_text === null
      ? null
      : text(value.response_text ?? "", "response_text", { required: false, maximum: 2_000 });
  }
  if (!patch || value.trigger_mode !== undefined) {
    output.trigger_mode = text(value.trigger_mode ?? "keyword", "trigger_mode", { maximum: 40 });
    if (!REPLY_TRIGGER_MODES.has(output.trigger_mode)) {
      throw new HttpError(422, "validation_failed", "自动回复触发方式不受支持。", { fields: ["trigger_mode"] });
    }
  }
  if (!patch || value.case_sensitive !== undefined) output.case_sensitive = booleanValue(value.case_sensitive, false);
  if (!patch || value.notify_on_match !== undefined) output.notify_on_match = booleanValue(value.notify_on_match, true);
  if (!patch || value.enabled !== undefined) output.enabled = booleanValue(value.enabled, true);
  return output;
}

async function ensureAccountAvailable(repository, context, accountId) {
  const userId = context.identity?.user_id;
  const account = await repository.db.prepare(`SELECT id FROM accounts
    WHERE id = ? AND user_id = ? AND enabled = 1 AND status = 'connected'`)
    .bind(accountId, userId).first();
  if (!account) {
    throw new HttpError(422, "account_unavailable", "请选择管理员工作区中已连接并启用的 Telegram 账号。", { fields: ["account_id"] });
  }
  await assertRealtimeTransitionAllowed(repository, accountId);
}

function validateFinalRule(rule) {
  if (rule.kind === "keyword_reply") {
    if (!rule.response_text) {
      throw new HttpError(422, "validation_failed", "自动回复必须填写回复内容。", { fields: ["response_text"] });
    }
    if (["keyword", "keyword_or_reply_to_own"].includes(rule.trigger_mode) && !rule.keyword) {
      throw new HttpError(422, "validation_failed", "这个触发方式必须填写关键词。", { fields: ["keyword"] });
    }
  } else if (rule.trigger_mode !== "keyword") {
    throw new HttpError(422, "validation_failed", "消息监控只能使用关键词匹配。", { fields: ["trigger_mode"] });
  }
}

async function selectRule(repository, userId, id) {
  return repository.db.prepare(`SELECT r.*, a.name AS account_name FROM realtime_rules r
    JOIN accounts a ON a.id = r.account_id WHERE r.id = ? AND r.user_id = ?`)
    .bind(id, userId).first();
}

export async function handleRealtimeMultiSelectorWriteApi(request, repository, context) {
  const url = new URL(request.url);
  const prefix = "/api/v1/admin/realtime-rules";
  if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return null;
  if (context.identity?.role !== "admin") {
    throw new HttpError(403, "administrator_required", "只有平台管理员可以使用实时监听功能。");
  }

  const userId = context.identity.user_id;
  const id = url.pathname === prefix ? "" : decodeURIComponent(url.pathname.slice(prefix.length + 1));
  if (!id && request.method !== "POST") return null;
  if (id && request.method !== "PATCH") return null;

  const input = ruleInput(await readJson(request, 32_000), { patch: Boolean(id) });
  const timestamp = context.now().toISOString();

  if (!id) {
    await ensureAccountAvailable(repository, context, input.account_id);
    const rule = {
      id: context.uuid(),
      ...input,
      response_text: input.kind === "keyword_reply" ? input.response_text : input.response_text || null,
      trigger_mode: input.kind === "keyword_reply" ? input.trigger_mode : "keyword",
    };
    validateFinalRule(rule);
    await repository.db.prepare(`INSERT INTO realtime_rules
      (id, user_id, account_id, kind, name, chat_selector, keyword, response_text, trigger_mode, case_sensitive, notify_on_match, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(rule.id, userId, rule.account_id, rule.kind, rule.name, rule.chat_selector, rule.keyword,
        rule.response_text, rule.trigger_mode, rule.case_sensitive ? 1 : 0, rule.notify_on_match ? 1 : 0,
        rule.enabled ? 1 : 0, timestamp, timestamp).run();
    return json({ data: mapRule(await selectRule(repository, userId, rule.id)) }, 201);
  }

  const current = await repository.db.prepare("SELECT * FROM realtime_rules WHERE id = ? AND user_id = ?")
    .bind(id, userId).first();
  if (!current) throw new HttpError(404, "realtime_rule_not_found", "没有找到这条实时规则。");

  const merged = {
    account_id: input.account_id ?? current.account_id,
    kind: input.kind ?? current.kind,
    name: input.name ?? current.name,
    chat_selector: input.chat_selector ?? current.chat_selector,
    keyword: input.keyword ?? current.keyword,
    response_text: input.response_text === undefined ? current.response_text : input.response_text,
    trigger_mode: input.trigger_mode ?? current.trigger_mode ?? "keyword",
    case_sensitive: input.case_sensitive ?? Boolean(current.case_sensitive),
    notify_on_match: input.notify_on_match ?? (current.notify_on_match === undefined ? true : Boolean(current.notify_on_match)),
    enabled: input.enabled ?? Boolean(current.enabled),
  };
  if (merged.kind !== "keyword_reply") merged.trigger_mode = "keyword";
  validateFinalRule(merged);
  await ensureAccountAvailable(repository, context, merged.account_id);

  await repository.db.prepare(`UPDATE realtime_rules SET account_id = ?, kind = ?, name = ?, chat_selector = ?,
    keyword = ?, response_text = ?, trigger_mode = ?, case_sensitive = ?, notify_on_match = ?, enabled = ?, updated_at = ?
    WHERE id = ? AND user_id = ?`)
    .bind(merged.account_id, merged.kind, merged.name, merged.chat_selector, merged.keyword, merged.response_text,
      merged.trigger_mode, merged.case_sensitive ? 1 : 0, merged.notify_on_match ? 1 : 0,
      merged.enabled ? 1 : 0, timestamp, id, userId).run();
  return json({ data: mapRule(await selectRule(repository, userId, id)) });
}

export const __test = {
  MAX_SELECTORS,
  MAX_SELECTOR_LENGTH,
  MAX_SERIALIZED_LENGTH,
};
