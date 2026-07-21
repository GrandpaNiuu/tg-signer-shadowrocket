import { HttpError, json, methodNotAllowed, readJson } from "./http.js";

const MAX_IMAGE_BYTES = 300_000;
const IMAGE_PATTERN = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/;

function timestamp(context) {
  return (context.now || (() => new Date()))().toISOString();
}

function text(value, field, { minimum = 1, maximum = 60 } = {}) {
  const output = String(value ?? "").trim();
  if (output.length < minimum || output.length > maximum) {
    throw new HttpError(422, "validation_failed", "请检查填写内容。", { fields: [field] });
  }
  return output;
}

function imageDataUrl(value, field) {
  if (value === null || value === undefined || value === "") return null;
  const output = String(value).trim();
  const match = IMAGE_PATTERN.exec(output);
  if (!match) {
    throw new HttpError(422, "validation_failed", "头像仅支持 PNG、JPEG 或 WebP 图片。", { fields: [field] });
  }
  let bytes;
  try {
    bytes = atob(match[2]).length;
  } catch {
    throw new HttpError(422, "validation_failed", "头像图片数据无效。", { fields: [field] });
  }
  if (bytes < 1 || bytes > MAX_IMAGE_BYTES) {
    throw new HttpError(422, "validation_failed", "头像处理后不能超过 300 KB。", { fields: [field] });
  }
  return output;
}

function objectBody(value, allowed) {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new HttpError(422, "validation_failed", "请求内容格式不正确。");
  }
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length) {
    throw new HttpError(422, "validation_failed", "请求包含不支持的字段。", { fields: extra });
  }
  return value;
}

function safeBranding(value) {
  let parsed = {};
  try { parsed = value ? JSON.parse(value) : {}; } catch { parsed = {}; }
  return {
    platform_name: String(parsed.platform_name || "Telegram 自动消息").slice(0, 60),
    platform_avatar_data_url: IMAGE_PATTERN.test(String(parsed.platform_avatar_data_url || ""))
      ? parsed.platform_avatar_data_url
      : null,
  };
}

async function readBranding(db) {
  const row = await db.prepare("SELECT value_json, updated_at FROM platform_settings WHERE setting_key = 'branding'").first();
  return { ...safeBranding(row?.value_json), updated_at: row?.updated_at || null };
}

async function profile(request, env, context) {
  const userId = context.identity?.user_id;
  if (!userId) throw new HttpError(401, "authentication_required", "请先登录。");
  if (request.method === "GET") {
    const row = await env.DB.prepare(`SELECT id, role, status, display_name, email, github_login,
      avatar_data_url, updated_at FROM users WHERE id = ?`).bind(userId).first();
    if (!row) throw new HttpError(404, "user_not_found", "没有找到当前用户。" );
    return json({ data: {
      id: row.id,
      role: row.role,
      status: row.status,
      display_name: row.display_name,
      email: row.email || null,
      login: row.github_login || null,
      avatar_data_url: IMAGE_PATTERN.test(String(row.avatar_data_url || "")) ? row.avatar_data_url : null,
      updated_at: row.updated_at,
    } });
  }
  if (request.method !== "PATCH") return methodNotAllowed(["GET", "PATCH"]);
  const body = objectBody(await readJson(request, 450_000), ["display_name", "avatar_data_url"]);
  if (body.display_name === undefined && body.avatar_data_url === undefined) {
    throw new HttpError(422, "validation_failed", "没有需要保存的个人资料。" );
  }
  const changes = [];
  const bindings = [];
  if (body.display_name !== undefined) {
    changes.push("display_name = ?");
    bindings.push(text(body.display_name, "display_name", { maximum: 40 }));
  }
  if (body.avatar_data_url !== undefined) {
    changes.push("avatar_data_url = ?");
    bindings.push(imageDataUrl(body.avatar_data_url, "avatar_data_url"));
  }
  const updatedAt = timestamp(context);
  changes.push("updated_at = ?");
  bindings.push(updatedAt, userId);
  await env.DB.prepare(`UPDATE users SET ${changes.join(", ")} WHERE id = ?`).bind(...bindings).run();
  const row = await env.DB.prepare(`SELECT id, role, status, display_name, email, github_login,
    avatar_data_url, updated_at FROM users WHERE id = ?`).bind(userId).first();
  return json({ data: {
    id: row.id,
    role: row.role,
    status: row.status,
    display_name: row.display_name,
    email: row.email || null,
    login: row.github_login || null,
    avatar_data_url: row.avatar_data_url || null,
    updated_at: row.updated_at,
  } });
}

async function branding(request, env, context) {
  if (request.method === "GET") return json({ data: await readBranding(env.DB) });
  if (request.method !== "PATCH") return methodNotAllowed(["GET", "PATCH"]);
  if (context.identity?.role !== "admin") {
    throw new HttpError(403, "administrator_required", "只有平台管理员可以修改平台品牌。" );
  }
  const body = objectBody(await readJson(request, 450_000), ["platform_name", "platform_avatar_data_url"]);
  const current = await readBranding(env.DB);
  const value = {
    platform_name: body.platform_name === undefined
      ? current.platform_name
      : text(body.platform_name, "platform_name", { maximum: 40 }),
    platform_avatar_data_url: body.platform_avatar_data_url === undefined
      ? current.platform_avatar_data_url
      : imageDataUrl(body.platform_avatar_data_url, "platform_avatar_data_url"),
  };
  const updatedAt = timestamp(context);
  await env.DB.prepare(`INSERT INTO platform_settings (setting_key, value_json, updated_at, updated_by)
    VALUES ('branding', ?, ?, ?)
    ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json,
      updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
    .bind(JSON.stringify(value), updatedAt, context.identity.user_id).run();
  return json({ data: { ...value, updated_at: updatedAt } });
}

export async function handleProfileBrandingApi(request, env, context) {
  if (!env.DB) throw new HttpError(503, "database_unavailable", "数据库不可用。" );
  const pathname = new URL(request.url).pathname;
  if (pathname === "/api/v1/profile") return profile(request, env, context);
  if (pathname === "/api/v1/platform-branding") return branding(request, env, context);
  return null;
}

export const __test = { imageDataUrl, safeBranding, text };
