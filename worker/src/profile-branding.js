import { HttpError, json, methodNotAllowed, readJson } from "./http.js";

const MAX_AVATAR_BYTES = 96 * 1024;
const MAX_AVATAR_TEXT_LENGTH = 140_000;
const AVATAR_PATTERN = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

function objectBody(value) {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new HttpError(422, "validation_failed", "请求内容格式不正确。", { fields: ["body"] });
  }
  return value;
}

function normalizeDisplayName(value) {
  const output = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!output || output.length > 60 || /[\u0000-\u001f\u007f]/.test(output)) {
    throw new HttpError(422, "validation_failed", "用户名需要填写 1 至 60 个有效字符。", { fields: ["display_name"] });
  }
  return output;
}

function decodedByteLength(base64) {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor(base64.length * 3 / 4) - padding;
}

function matchesImageSignature(type, base64) {
  let binary;
  try {
    binary = atob(base64.slice(0, 32));
  } catch {
    return false;
  }
  const bytes = Array.from(binary, (character) => character.charCodeAt(0));
  if (type === "png") {
    return [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
  }
  if (type === "jpeg") return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (type === "webp") {
    return String.fromCharCode(...bytes.slice(0, 4)) === "RIFF"
      && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  }
  return false;
}

function normalizeAvatar(value, field) {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || value.length > MAX_AVATAR_TEXT_LENGTH) {
    throw new HttpError(422, "avatar_invalid", "头像文件无效或过大。", { fields: [field] });
  }
  const match = value.match(AVATAR_PATTERN);
  if (!match) {
    throw new HttpError(422, "avatar_invalid", "头像只支持 PNG、JPEG 或 WebP 图片。", { fields: [field] });
  }
  const [, type, base64] = match;
  if (decodedByteLength(base64) > MAX_AVATAR_BYTES || !matchesImageSignature(type, base64)) {
    throw new HttpError(422, "avatar_invalid", "头像需要小于 96 KB，并且必须是真实的 PNG、JPEG 或 WebP 图片。", { fields: [field] });
  }
  return value;
}

function parseBranding(row) {
  if (!row?.value_json) return { avatar_data_url: null };
  try {
    const value = JSON.parse(row.value_json);
    return { avatar_data_url: typeof value?.avatar_data_url === "string" ? value.avatar_data_url : null };
  } catch {
    return { avatar_data_url: null };
  }
}

async function platformBranding(repository) {
  const row = await repository.db.prepare(
    "SELECT value_json FROM platform_settings WHERE setting_key = 'branding'",
  ).first();
  return parseBranding(row);
}

async function currentProfile(repository, userId) {
  const row = await repository.db.prepare(
    "SELECT id, role, status, display_name, email, github_login, avatar_data_url FROM users WHERE id = ? LIMIT 1",
  ).bind(userId).first();
  if (!row) throw new HttpError(404, "profile_not_found", "没有找到当前用户资料。");
  return {
    id: row.id,
    role: row.role,
    status: row.status,
    display_name: row.display_name,
    email: row.email || null,
    github_login: row.github_login || null,
    avatar_data_url: row.avatar_data_url || null,
  };
}

export async function handlePublicBrandingApi(request, repository) {
  const url = new URL(request.url);
  if (url.pathname !== "/api/branding") return null;
  if (request.method !== "GET") return methodNotAllowed(["GET"]);
  return json({ data: await platformBranding(repository) });
}

export async function handleProfileBrandingApi(request, repository, context) {
  const url = new URL(request.url);
  const userId = context.identity?.user_id;
  if (!userId) throw new HttpError(401, "authentication_required", "请先登录。");

  if (url.pathname === "/api/v1/profile") {
    if (request.method === "GET") {
      return json({ data: {
        profile: await currentProfile(repository, userId),
        platform: await platformBranding(repository),
      } });
    }
    if (request.method !== "PATCH") return methodNotAllowed(["GET", "PATCH"]);
    const body = objectBody(await readJson(request, 180_000));
    const current = await currentProfile(repository, userId);
    const displayName = body.display_name === undefined
      ? current.display_name
      : normalizeDisplayName(body.display_name);
    const avatar = body.avatar_data_url === undefined
      ? current.avatar_data_url
      : normalizeAvatar(body.avatar_data_url, "avatar_data_url");
    if (body.display_name === undefined && body.avatar_data_url === undefined) {
      throw new HttpError(422, "validation_failed", "没有需要保存的个人资料。", { fields: ["display_name", "avatar_data_url"] });
    }
    const timestamp = context.now().toISOString();
    await repository.db.prepare(
      "UPDATE users SET display_name = ?, avatar_data_url = ?, updated_at = ? WHERE id = ?",
    ).bind(displayName, avatar, timestamp, userId).run();
    return json({ data: await currentProfile(repository, userId) });
  }

  if (url.pathname === "/api/v1/admin/platform-branding") {
    if (context.identity?.role !== "admin") {
      throw new HttpError(403, "administrator_required", "只有平台管理员可以修改平台头像。");
    }
    if (request.method !== "PATCH") return methodNotAllowed(["PATCH"]);
    const body = objectBody(await readJson(request, 180_000));
    if (body.avatar_data_url === undefined) {
      throw new HttpError(422, "validation_failed", "请选择平台头像或执行移除操作。", { fields: ["avatar_data_url"] });
    }
    const avatar = normalizeAvatar(body.avatar_data_url, "avatar_data_url");
    const timestamp = context.now().toISOString();
    await repository.db.prepare(`INSERT INTO platform_settings
      (setting_key, value_json, updated_at, updated_by) VALUES ('branding', ?, ?, ?)
      ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json,
        updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .bind(JSON.stringify({ avatar_data_url: avatar }), timestamp, userId).run();
    return json({ data: { avatar_data_url: avatar } });
  }

  return null;
}

export const __test = {
  decodedByteLength,
  matchesImageSignature,
  normalizeAvatar,
  normalizeDisplayName,
  parseBranding,
};
