import { json } from "./http.js";
import { handleRunnerApi as handleLegacyRunnerApi } from "./runner-api.js";
import { normalizeSkillParams } from "./skill-contracts.js";

function safeParams(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function claimRunId(url) {
  const match = url.pathname.match(/^\/api\/runner\/runs\/([^/]+)\/claim$/);
  return match ? decodeURIComponent(match[1]) : null;
}

async function enrichClaim(payload, runId, repository) {
  const execution = await repository.getExecution(runId);
  if (!execution) return payload;
  const skillKey = String(payload?.task?.skill || execution.skill_key || "");
  const stored = safeParams(execution.params_json_snapshot);
  const allowedSkill = ["send_text", "tg_signer", "send_media"].includes(skillKey);
  if (!allowedSkill) normalizeSkillParams(skillKey, stored);
  const nativeSkill = skillKey === "send_media";
  const baseParams = nativeSkill || Object.keys(stored).length
    ? normalizeSkillParams(skillKey, stored)
    : { ...(payload?.task?.params || {}) };
  if (skillKey === "tg_signer") {
    for (const key of ["import_blob", "import_encoding", "num_of_dialogs"]) {
      if (payload?.task?.params?.[key] !== undefined) baseParams[key] = payload.task.params[key];
    }
  }
  if (skillKey === "send_media") {
    try {
      const asset = await repository.db.prepare(`SELECT id, media_type, source_chat_id, source_message_id
        FROM media_assets WHERE id = ? AND user_id = ?`)
        .bind(baseParams.file_id, execution.user_id).first();
      if (!asset || asset.media_type !== baseParams.media_type) {
        baseParams._source_error = "media_asset_unavailable";
      } else {
        baseParams._source_chat_id = asset.source_chat_id;
        baseParams._source_message_id = asset.source_message_id;
      }
    } catch {
      baseParams._source_error = "media_asset_lookup_failed";
    }
  }
  return {
    ...payload,
    task: { ...payload.task, params: baseParams },
  };
}

export async function handleRunnerApi(request, env, repository, context, claims) {
  const url = new URL(request.url);
  const runId = request.method === "POST" ? claimRunId(url) : null;
  const response = await handleLegacyRunnerApi(request, env, repository, context, claims);
  if (!runId || !response?.ok) return response;
  const payload = await response.clone().json();
  return json(await enrichClaim(payload, runId, repository), response.status);
}

export const __test = { claimRunId, enrichClaim, safeParams };
