import { json } from "./http.js";

const INSTANCE_PATTERN = /^[A-Za-z0-9._:-]{1,80}$/;
const LEADER_STALE_SECONDS = 130;

function instanceId(request) {
  const value = String(request.headers.get("x-listener-instance-id") || "").trim();
  return INSTANCE_PATTERN.test(value) ? value : null;
}

function isoOffset(timestamp, seconds) {
  const value = Date.parse(timestamp);
  if (!Number.isFinite(value)) throw new Error("Invalid listener leader timestamp.");
  return new Date(value + seconds * 1_000).toISOString();
}

export async function electListenerLeader(db, id, timestamp) {
  if (!db?.prepare || !id) return true;
  const staleBefore = isoOffset(timestamp, -LEADER_STALE_SECONDS);
  await db.prepare(`INSERT INTO listener_instances
    (id, label, version, status, active_accounts, active_rules, started_at, last_heartbeat_at, updated_at)
    VALUES (?, ?, 'unknown', 'starting', 0, 0, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = 'starting', last_heartbeat_at = excluded.last_heartbeat_at, updated_at = excluded.updated_at
    WHERE listener_instances.status IN ('offline', 'stopping')
      OR listener_instances.last_heartbeat_at < ?`)
    .bind(id, id, timestamp, timestamp, timestamp, staleBefore).run();
  const leader = await db.prepare(`SELECT id FROM listener_instances
    WHERE status IN ('starting', 'online', 'degraded') AND last_heartbeat_at >= ?
    ORDER BY COALESCE(started_at, last_heartbeat_at), id LIMIT 1`)
    .bind(staleBefore).first();
  return !leader?.id || String(leader.id) === id;
}

export async function enforceListenerLeader(request, env, response, now = () => new Date()) {
  if (!response.ok) return response;
  const id = instanceId(request);
  if (!id) {
    return json({
      error: {
        code: "listener_instance_id_required",
        message: "Listener instance id is required.",
      },
    }, 400, { "x-request-id": response.headers.get("x-request-id") || "" });
  }
  const leader = await electListenerLeader(env.DB, id, now().toISOString());
  const payload = await response.json();
  if (!payload?.data || typeof payload.data !== "object") return response;
  payload.data.leader = leader;
  payload.data.instance_id = id;
  if (!leader) {
    payload.data.accounts = [];
    payload.data.rules = [];
  }
  return new Response(JSON.stringify(payload), {
    status: response.status,
    headers: response.headers,
  });
}

export const __test = { instanceId, isoOffset, LEADER_STALE_SECONDS };
