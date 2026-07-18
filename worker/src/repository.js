import { isTerminalLoginStatus } from "./login-states.js";

function rows(result) {
  return result?.results || [];
}

function changes(result) {
  return Number(result?.meta?.changes || 0);
}

function mapAccount(row) {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    phone_masked: row.phone_masked,
    status: row.status,
    enabled: Boolean(row.enabled),
    last_error: row.last_error,
    last_connected_at: row.last_connected_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    account_id: row.account_id,
    account_name: row.account_name,
    skill_key: row.skill_key,
    skill_name: row.skill_name,
    has_tg_signer_import: Boolean(row.tg_signer_import_secret_id),
    bot: row.bot,
    command: row.command,
    cron: row.cron,
    timezone: row.timezone,
    retry: row.retry,
    timeout_seconds: row.timeout_seconds,
    thread_id: row.thread_id,
    delete_after_seconds: row.delete_after_seconds,
    enabled: Boolean(row.enabled),
    next_run_at: row.next_run_at,
    last_run_at: row.last_run_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function safeJson(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function mapRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    task_id: row.historical_task_id,
    task_name: row.task_name,
    account_id: row.historical_account_id,
    account_name: row.account_name,
    skill_key: row.skill_key,
    skill_name: row.skill_name,
    bot: row.bot,
    command: row.command,
    cron: row.cron,
    timezone: row.timezone,
    retry: row.retry,
    timeout_seconds: row.timeout_seconds,
    thread_id: row.thread_id,
    delete_after_seconds: row.delete_after_seconds,
    trigger_type: row.trigger_type,
    status: row.status,
    scheduled_for: row.scheduled_for,
    attempt_count: row.attempt_count,
    max_attempts: row.max_attempts,
    dispatch_status: row.dispatch_status,
    dispatch_attempt_count: row.dispatch_attempt_count,
    dispatched_at: row.dispatched_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
    duration_ms: row.duration_ms,
    error_code: row.error_code,
    error_message: row.error_message,
    github_run_id: row.github_run_id,
    result: safeJson(row.result_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const SECRET_INSERT = `INSERT INTO secret_values
  (id, owner_type, owner_id, purpose, algorithm, ciphertext, nonce, aad, key_version, expires_at, consumed_at,
   delivered_to_run_id, delivered_at, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function secretBindings(secret) {
  return [
    secret.id,
    secret.owner_type,
    secret.owner_id,
    secret.purpose,
    secret.algorithm,
    secret.ciphertext,
    secret.nonce,
    secret.aad,
    secret.key_version,
    secret.expires_at,
    secret.consumed_at,
    secret.delivered_to_run_id ?? null,
    secret.delivered_at ?? null,
    secret.created_at,
    secret.updated_at,
  ];
}

function bindSecret(db, secret) {
  return db.prepare(SECRET_INSERT).bind(...secretBindings(secret));
}

function bindSecretForActiveLoginFlow(db, secret, flowId, githubRunId) {
  return db.prepare(`INSERT INTO secret_values
    (id, owner_type, owner_id, purpose, algorithm, ciphertext, nonce, aad, key_version, expires_at, consumed_at,
     delivered_to_run_id, delivered_at, created_at, updated_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM login_flows
    WHERE id = ? AND github_run_id = ?
      AND status NOT IN ('connected', 'failed', 'cancelled', 'expired')`)
    .bind(...secretBindings(secret), flowId, githubRunId);
}

function deleteUnusedTaskSecrets(db) {
  return db.prepare(`DELETE FROM secret_values
    WHERE owner_type = 'task' AND purpose = 'tg_signer_import'
      AND NOT EXISTS (
        SELECT 1 FROM tasks
        WHERE tasks.tg_signer_import_secret_id = secret_values.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM task_runs
        WHERE task_runs.tg_signer_import_secret_id_snapshot = secret_values.id
          AND task_runs.status IN ('queued', 'claimed', 'running')
      )`);
}

const SECRET_COLUMNS = {
  phone: "phone_secret_id",
  api_id: "api_id_secret_id",
  api_hash: "api_hash_secret_id",
  telegram_session: "session_secret_id",
  proxy: "proxy_secret_id",
};

const TASK_SELECT = `SELECT t.*, a.name AS account_name, s.skill_key, s.display_name AS skill_name
  FROM tasks t
  JOIN accounts a ON a.id = t.account_id
  JOIN skills s ON s.id = t.skill_id`;

const RUN_SELECT = `SELECT r.*,
  CASE WHEN r.context_snapshot_version IS NOT NULL THEN r.task_id_snapshot ELSE r.task_id END AS historical_task_id,
  CASE WHEN r.context_snapshot_version IS NOT NULL THEN r.task_name_snapshot ELSE t.name END AS task_name,
  CASE WHEN r.context_snapshot_version IS NOT NULL THEN r.account_id_snapshot ELSE a.id END AS historical_account_id,
  CASE WHEN r.context_snapshot_version IS NOT NULL THEN r.account_name_snapshot ELSE a.name END AS account_name,
  CASE WHEN r.context_snapshot_version IS NOT NULL THEN r.skill_key_snapshot ELSE s.skill_key END AS skill_key,
  CASE WHEN r.context_snapshot_version IS NOT NULL THEN r.skill_name_snapshot ELSE s.display_name END AS skill_name,
  CASE WHEN r.context_snapshot_version IS NOT NULL THEN r.bot_snapshot ELSE t.bot END AS bot,
  CASE WHEN r.context_snapshot_version IS NOT NULL THEN r.command_snapshot ELSE t.command END AS command,
  CASE WHEN r.context_snapshot_version IS NOT NULL THEN r.cron_snapshot ELSE t.cron END AS cron,
  CASE WHEN r.context_snapshot_version IS NOT NULL THEN r.timezone_snapshot ELSE t.timezone END AS timezone,
  CASE WHEN r.context_snapshot_version IS NOT NULL THEN r.retry_snapshot ELSE t.retry END AS retry,
  CASE WHEN r.context_snapshot_version IS NOT NULL THEN r.timeout_seconds_snapshot ELSE t.timeout_seconds END AS timeout_seconds,
  CASE WHEN r.context_snapshot_version IS NOT NULL THEN r.thread_id_snapshot ELSE t.thread_id END AS thread_id,
  CASE WHEN r.context_snapshot_version IS NOT NULL THEN r.delete_after_seconds_snapshot ELSE t.delete_after_seconds END AS delete_after_seconds
  FROM task_runs r
  LEFT JOIN tasks t ON t.id = r.task_id
  LEFT JOIN accounts a ON a.id = t.account_id
  LEFT JOIN skills s ON s.id = t.skill_id`;

export class D1Repository {
  constructor(db, scope = {}) {
    this.db = db;
    this.userId = scope.userId || null;
    this.userRole = scope.role || null;
  }

  forUser(identity = {}) {
    return new D1Repository(this.db, {
      userId: identity.user_id || "legacy-admin",
      role: identity.role || "admin",
    });
  }

  async createAdminOAuthState(state) {
    await this.db.batch([
      this.db.prepare("DELETE FROM admin_oauth_states WHERE consumed_at IS NOT NULL OR expires_at <= ?")
        .bind(state.created_at),
      this.db.prepare(`INSERT INTO admin_oauth_states
        (state_hash, code_verifier, return_to, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`)
        .bind(state.state_hash, state.code_verifier, state.return_to, state.expires_at, state.created_at),
    ]);
  }

  async consumeAdminOAuthState(stateHash, timestamp) {
    return this.db.prepare(`UPDATE admin_oauth_states SET consumed_at = ?
      WHERE state_hash = ? AND consumed_at IS NULL AND expires_at > ?
      RETURNING return_to, code_verifier`).bind(timestamp, stateHash, timestamp).first();
  }

  async createAdminSession(session) {
    await this.db.batch([
      this.db.prepare("DELETE FROM admin_sessions WHERE revoked_at IS NOT NULL OR expires_at <= ?")
        .bind(session.created_at),
      this.db.prepare(`INSERT INTO admin_sessions
        (token_hash, github_user_id, github_login, github_name, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)`).bind(
        session.token_hash,
        session.github_user_id,
        session.github_login,
        session.github_name,
        session.created_at,
        session.expires_at,
      ),
    ]);
  }

  async getAdminSession(tokenHash, timestamp) {
    return this.db.prepare(`SELECT user_id, github_user_id, github_login, github_name, created_at, expires_at
      FROM admin_sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`)
      .bind(tokenHash, timestamp).first();
  }

  async revokeAdminSession(tokenHash, timestamp) {
    await this.db.prepare(`UPDATE admin_sessions SET revoked_at = ?
      WHERE token_hash = ? AND revoked_at IS NULL`).bind(timestamp, tokenHash).run();
  }

  async getUser(id) {
    return this.db.prepare(`SELECT id, role, status, display_name, email, email_normalized,
      email_verified_at, github_user_id, github_login, github_name, created_at, updated_at
      FROM users WHERE id = ?`).bind(id).first();
  }

  async getUserByGithubId(githubUserId) {
    return this.db.prepare(`SELECT id, role, status, display_name, email, email_normalized,
      email_verified_at, github_user_id, github_login, github_name, created_at, updated_at
      FROM users WHERE github_user_id = ?`).bind(githubUserId).first();
  }

  async getUserByEmail(emailNormalized) {
    return this.db.prepare(`SELECT id, role, status, display_name, email, email_normalized,
      email_verified_at, password_algorithm, password_hash, password_salt, password_iterations,
      github_user_id, github_login, github_name, created_at, updated_at
      FROM users WHERE email_normalized = ?`).bind(emailNormalized).first();
  }

  async createOrUpdatePendingEmailUser(user, password) {
    const existing = await this.getUserByEmail(user.email_normalized);
    if (existing?.status === "active" || existing?.status === "disabled") {
      return { user: existing, verification_required: false };
    }
    if (existing) {
      await this.db.prepare(`UPDATE users SET display_name = ?, email = ?,
        password_algorithm = ?, password_hash = ?, password_salt = ?, password_iterations = ?,
        updated_at = ? WHERE id = ? AND status = 'pending'`).bind(
        user.display_name,
        user.email,
        password.password_algorithm,
        password.password_hash,
        password.password_salt,
        password.password_iterations,
        user.updated_at,
        existing.id,
      ).run();
      return { user: await this.getUserByEmail(user.email_normalized), verification_required: true };
    }
    await this.db.prepare(`INSERT INTO users
      (id, role, status, display_name, email, email_normalized, password_algorithm,
       password_hash, password_salt, password_iterations, created_at, updated_at)
      VALUES (?, 'user', 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      user.id,
      user.display_name,
      user.email,
      user.email_normalized,
      password.password_algorithm,
      password.password_hash,
      password.password_salt,
      password.password_iterations,
      user.created_at,
      user.updated_at,
    ).run();
    return { user: await this.getUserByEmail(user.email_normalized), verification_required: true };
  }

  async createOrActivateLocalEmailUser(user, password) {
    const existing = await this.getUserByEmail(user.email_normalized);
    if (existing?.status === "active" || existing?.status === "disabled") {
      return { user: existing, created: false };
    }
    if (existing) {
      await this.db.prepare(`UPDATE users SET status = 'active', display_name = ?, email = ?,
        email_verified_at = NULL, password_algorithm = ?, password_hash = ?, password_salt = ?,
        password_iterations = ?, updated_at = ? WHERE id = ? AND status = 'pending'`).bind(
        user.display_name,
        user.email,
        password.password_algorithm,
        password.password_hash,
        password.password_salt,
        password.password_iterations,
        user.updated_at,
        existing.id,
      ).run();
      return { user: await this.getUserByEmail(user.email_normalized), created: true };
    }
    await this.db.prepare(`INSERT INTO users
      (id, role, status, display_name, email, email_normalized, email_verified_at,
       password_algorithm, password_hash, password_salt, password_iterations, created_at, updated_at)
      VALUES (?, 'user', 'active', ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`).bind(
      user.id,
      user.display_name,
      user.email,
      user.email_normalized,
      password.password_algorithm,
      password.password_hash,
      password.password_salt,
      password.password_iterations,
      user.created_at,
      user.updated_at,
    ).run();
    return { user: await this.getUserByEmail(user.email_normalized), created: true };
  }

  async createAuthToken(token) {
    await this.db.batch([
      this.db.prepare(`DELETE FROM auth_tokens
        WHERE user_id = ? AND token_type = ?`).bind(token.user_id, token.token_type),
      this.db.prepare(`INSERT INTO auth_tokens
        (id, token_hash, user_id, token_type, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).bind(
        token.id,
        token.token_hash,
        token.user_id,
        token.token_type,
        token.expires_at,
        token.created_at,
      ),
    ]);
  }

  async consumeEmailVerification(tokenHashValue, timestamp) {
    const token = await this.db.prepare(`SELECT id, user_id FROM auth_tokens
      WHERE token_hash = ? AND token_type = 'verify_email' AND consumed_at IS NULL AND expires_at > ?`)
      .bind(tokenHashValue, timestamp).first();
    if (!token) return null;
    const result = await this.db.batch([
      this.db.prepare(`UPDATE auth_tokens SET consumed_at = ?
        WHERE id = ? AND consumed_at IS NULL AND expires_at > ?`).bind(timestamp, token.id, timestamp),
      this.db.prepare(`UPDATE users SET status = 'active', email_verified_at = ?, updated_at = ?
        WHERE id = ? AND status = 'pending' AND EXISTS (
          SELECT 1 FROM auth_tokens WHERE id = ? AND consumed_at = ?
        )`).bind(timestamp, timestamp, token.user_id, token.id, timestamp),
    ]);
    return changes(result[0]) ? this.getUser(token.user_id) : null;
  }

  async consumePasswordReset(tokenHashValue, password, timestamp) {
    const token = await this.db.prepare(`SELECT id, user_id FROM auth_tokens
      WHERE token_hash = ? AND token_type = 'password_reset' AND consumed_at IS NULL AND expires_at > ?`)
      .bind(tokenHashValue, timestamp).first();
    if (!token) return null;
    const result = await this.db.batch([
      this.db.prepare(`UPDATE auth_tokens SET consumed_at = ?
        WHERE id = ? AND consumed_at IS NULL AND expires_at > ?`).bind(timestamp, token.id, timestamp),
      this.db.prepare(`UPDATE users SET password_algorithm = ?, password_hash = ?, password_salt = ?,
        password_iterations = ?, updated_at = ? WHERE id = ? AND status = 'active'
        AND EXISTS (SELECT 1 FROM auth_tokens WHERE id = ? AND consumed_at = ?)`)
        .bind(password.password_algorithm, password.password_hash, password.password_salt,
          password.password_iterations, timestamp, token.user_id, token.id, timestamp),
      this.db.prepare(`UPDATE user_sessions SET revoked_at = ?
        WHERE user_id = ? AND revoked_at IS NULL`).bind(timestamp, token.user_id),
    ]);
    return changes(result[0]) && changes(result[1]) ? this.getUser(token.user_id) : null;
  }

  async consumeAuthRateLimit({ action, bucket_hash, window_started_at, expires_at, limit }) {
    await this.db.prepare("DELETE FROM auth_rate_limits WHERE expires_at <= ?")
      .bind(window_started_at).run();
    const row = await this.db.prepare(`INSERT INTO auth_rate_limits
      (action, bucket_hash, window_started_at, attempt_count, expires_at)
      VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(action, bucket_hash, window_started_at)
      DO UPDATE SET attempt_count = attempt_count + 1
      RETURNING attempt_count`).bind(action, bucket_hash, window_started_at, expires_at).first();
    return Number(row?.attempt_count || 0) <= limit;
  }

  async upsertGithubUser({ id, github_user_id, github_login, github_name, is_admin, timestamp }) {
    const targetId = is_admin ? "legacy-admin" : id;
    const existing = is_admin ? await this.getUser(targetId) : await this.getUserByGithubId(github_user_id);
    if (existing) {
      await this.db.prepare(`UPDATE users SET role = ?, status = 'active', display_name = ?,
        github_user_id = ?, github_login = ?, github_name = ?, updated_at = ? WHERE id = ?`)
        .bind(is_admin ? "admin" : existing.role, github_name || github_login,
          github_user_id, github_login, github_name, timestamp, existing.id).run();
      return this.getUser(existing.id);
    }
    await this.db.prepare(`INSERT INTO users
      (id, role, status, display_name, github_user_id, github_login, github_name, created_at, updated_at)
      VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?)`).bind(
      targetId,
      is_admin ? "admin" : "user",
      github_name || github_login,
      github_user_id,
      github_login,
      github_name,
      timestamp,
      timestamp,
    ).run();
    return this.getUser(targetId);
  }

  async createUserSession(session) {
    await this.db.batch([
      this.db.prepare("DELETE FROM user_sessions WHERE revoked_at IS NOT NULL OR expires_at <= ?")
        .bind(session.created_at),
      this.db.prepare(`INSERT INTO user_sessions
        (id, token_hash, user_id, provider, created_at, last_seen_at, expires_at, user_agent_label)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        session.id,
        session.token_hash,
        session.user_id,
        session.provider,
        session.created_at,
        session.created_at,
        session.expires_at,
        session.user_agent_label || null,
      ),
    ]);
  }

  async getUserSession(tokenHash, timestamp) {
    return this.db.prepare(`SELECT s.id AS session_id, s.user_id, s.provider, s.created_at,
      s.last_seen_at, s.expires_at, u.role, u.status, u.display_name, u.email,
      u.email_verified_at, u.github_login, u.github_name
      FROM user_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND u.status = 'active'`)
      .bind(tokenHash, timestamp).first();
  }

  async revokeUserSession(tokenHash, timestamp) {
    await this.db.prepare(`UPDATE user_sessions SET revoked_at = ?
      WHERE token_hash = ? AND revoked_at IS NULL`).bind(timestamp, tokenHash).run();
  }

  async listUserSessions(userId, currentTokenHash, timestamp) {
    const result = await this.db.prepare(`SELECT id, provider, created_at, last_seen_at, expires_at,
      user_agent_label, CASE WHEN token_hash = ? THEN 1 ELSE 0 END AS current
      FROM user_sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
      ORDER BY created_at DESC`).bind(currentTokenHash || "", userId, timestamp).all();
    return rows(result).map((session) => ({
      id: session.id,
      provider: session.provider,
      created_at: session.created_at,
      last_seen_at: session.last_seen_at,
      expires_at: session.expires_at,
      user_agent_label: session.user_agent_label,
      current: Boolean(session.current),
    }));
  }

  async revokeUserSessionById(userId, sessionId, timestamp) {
    const result = await this.db.prepare(`UPDATE user_sessions SET revoked_at = ?
      WHERE id = ? AND user_id = ? AND revoked_at IS NULL`).bind(timestamp, sessionId, userId).run();
    return changes(result) > 0;
  }

  async listAccounts({ limit, offset }) {
    const result = await this.db.prepare(`SELECT id, name, phone_masked, status, enabled, last_error,
      user_id, last_connected_at, created_at, updated_at FROM accounts
      ${this.userId ? "WHERE user_id = ?" : ""} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .bind(...(this.userId ? [this.userId] : []), limit, offset).all();
    return rows(result).map(mapAccount);
  }

  async getAccount(id) {
    return mapAccount(await this.db.prepare(`SELECT id, name, phone_masked, status, enabled, last_error,
      user_id, last_connected_at, created_at, updated_at FROM accounts WHERE id = ?
      ${this.userId ? "AND user_id = ?" : ""}`).bind(id, ...(this.userId ? [this.userId] : [])).first());
  }

  async createAccount({ account, secrets }) {
    const byPurpose = Object.fromEntries(secrets.map((secret) => [secret.purpose, secret.id]));
    await this.db.batch([
      ...secrets.map((secret) => bindSecret(this.db, secret)),
      this.db.prepare(`INSERT INTO accounts
        (id, user_id, name, phone_masked, phone_secret_id, api_id_secret_id, api_hash_secret_id, session_secret_id,
         proxy_secret_id, status, enabled, last_connected_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        account.id,
        this.userId || account.user_id || "legacy-admin",
        account.name,
        account.phone_masked,
        byPurpose.phone || null,
        byPurpose.api_id || null,
        byPurpose.api_hash || null,
        byPurpose.telegram_session || null,
        byPurpose.proxy || null,
        account.status,
        account.enabled,
        account.last_connected_at,
        account.created_at,
        account.updated_at,
      ),
    ]);
    return this.getAccount(account.id);
  }

  async updateAccount(id, { changes: accountChanges, secrets, clearSecrets }) {
    const existing = await this.db.prepare(`SELECT * FROM accounts WHERE id = ?
      ${this.userId ? "AND user_id = ?" : ""}`).bind(id, ...(this.userId ? [this.userId] : [])).first();
    if (!existing) return null;
    const values = { ...accountChanges };
    const oldSecretIds = [];
    for (const secret of secrets) {
      const column = SECRET_COLUMNS[secret.purpose];
      if (column) {
        if (existing[column]) oldSecretIds.push(existing[column]);
        values[column] = secret.id;
      }
    }
    for (const purpose of clearSecrets) {
      const column = SECRET_COLUMNS[purpose];
      if (column) {
        if (existing[column]) oldSecretIds.push(existing[column]);
        values[column] = null;
      }
    }
    const allowed = new Set([
      "name", "phone_masked", "phone_secret_id", "api_id_secret_id", "api_hash_secret_id",
      "session_secret_id", "proxy_secret_id", "status", "enabled", "last_error",
      "last_connected_at", "updated_at",
    ]);
    const entries = Object.entries(values).filter(([key]) => allowed.has(key));
    if (!entries.length) return this.getAccount(id);
    const update = this.db.prepare(`UPDATE accounts SET ${entries.map(([key]) => `${key} = ?`).join(", ")} WHERE id = ?
      ${this.userId ? "AND user_id = ?" : ""}`)
      .bind(...entries.map(([, value]) => value), id, ...(this.userId ? [this.userId] : []));
    await this.db.batch([
      ...secrets.map((secret) => bindSecret(this.db, secret)),
      update,
      ...oldSecretIds.map((secretId) => this.db.prepare("DELETE FROM secret_values WHERE id = ?").bind(secretId)),
    ]);
    return this.getAccount(id);
  }

  async deleteAccount(id) {
    if (!await this.getAccount(id)) return { deleted: false, blocked: false };
    const dependent = await this.db.prepare(`SELECT COUNT(*) AS count FROM tasks WHERE account_id = ?
      ${this.userId ? "AND user_id = ?" : ""}`).bind(id, ...(this.userId ? [this.userId] : [])).first();
    if (Number(dependent?.count || 0) > 0) return { deleted: false, blocked: true };
    const result = await this.db.batch([
      this.db.prepare(`DELETE FROM secret_values WHERE owner_type = 'login_flow'
        AND owner_id IN (SELECT id FROM login_flows WHERE account_id = ?)`).bind(id),
      this.db.prepare(`DELETE FROM accounts WHERE id = ? ${this.userId ? "AND user_id = ?" : ""}`)
        .bind(id, ...(this.userId ? [this.userId] : [])),
      this.db.prepare("DELETE FROM secret_values WHERE owner_type = 'account' AND owner_id = ?").bind(id),
    ]);
    return { deleted: changes(result[1]) > 0, blocked: false };
  }

  async listSkills() {
    return rows(await this.db.prepare(`SELECT id, skill_key, display_name, version, description,
      config_schema_json, enabled, created_at, updated_at FROM skills ORDER BY display_name`).all()).map((row) => ({
      ...row,
      enabled: Boolean(row.enabled),
      config_schema: safeJson(row.config_schema_json, {}),
      config_schema_json: undefined,
    }));
  }

  async getSkillByKey(skillKey) {
    return this.db.prepare("SELECT * FROM skills WHERE skill_key = ? AND enabled = 1").bind(skillKey).first();
  }

  async listTasks({ limit, offset, accountId, enabled }) {
    const conditions = [];
    const bindings = [];
    if (this.userId) { conditions.push("t.user_id = ?"); bindings.push(this.userId); }
    if (accountId) { conditions.push("t.account_id = ?"); bindings.push(accountId); }
    if (enabled !== undefined) { conditions.push("t.enabled = ?"); bindings.push(enabled ? 1 : 0); }
    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    const result = await this.db.prepare(`${TASK_SELECT}${where} ORDER BY t.created_at DESC, t.id DESC LIMIT ? OFFSET ?`)
      .bind(...bindings, limit, offset).all();
    return rows(result).map(mapTask);
  }

  async getTask(id) {
    return mapTask(await this.db.prepare(`${TASK_SELECT} WHERE t.id = ?
      ${this.userId ? "AND t.user_id = ?" : ""}`).bind(id, ...(this.userId ? [this.userId] : [])).first());
  }

  async createTask(task, signerImportSecret = null) {
    await this.db.batch([
      ...(signerImportSecret ? [bindSecret(this.db, signerImportSecret)] : []),
      this.db.prepare(`INSERT INTO tasks
      (id, user_id, name, account_id, skill_id, tg_signer_import_secret_id, bot, command, cron, timezone, retry, timeout_seconds, thread_id,
       delete_after_seconds, enabled, next_run_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        task.id, this.userId || task.user_id || "legacy-admin", task.name, task.account_id, task.skill_id, signerImportSecret?.id || null,
        task.bot, task.command, task.cron, task.timezone,
        task.retry, task.timeout_seconds, task.thread_id, task.delete_after_seconds, task.enabled,
        task.next_run_at, task.created_at, task.updated_at,
      ),
    ]);
    return this.getTask(task.id);
  }

  async updateTask(id, values, { signerImportSecret = null, clearSignerImport = false } = {}) {
    const existing = await this.db.prepare(`SELECT tg_signer_import_secret_id FROM tasks WHERE id = ?
      ${this.userId ? "AND user_id = ?" : ""}`).bind(id, ...(this.userId ? [this.userId] : [])).first();
    if (!existing) return null;
    const updateValues = { ...values };
    const oldConfigId = existing.tg_signer_import_secret_id;
    if (signerImportSecret) updateValues.tg_signer_import_secret_id = signerImportSecret.id;
    if (clearSignerImport) updateValues.tg_signer_import_secret_id = null;
    const allowed = new Set([
      "name", "account_id", "skill_id", "bot", "command", "cron", "timezone", "retry",
      "timeout_seconds", "thread_id", "delete_after_seconds", "enabled", "next_run_at", "updated_at",
      "tg_signer_import_secret_id",
    ]);
    const entries = Object.entries(updateValues).filter(([key]) => allowed.has(key));
    if (!entries.length) return this.getTask(id);
    const results = await this.db.batch([
      ...(signerImportSecret ? [bindSecret(this.db, signerImportSecret)] : []),
      this.db.prepare(`UPDATE tasks SET ${entries.map(([key]) => `${key} = ?`).join(", ")} WHERE id = ?
        ${this.userId ? "AND user_id = ?" : ""}`)
        .bind(...entries.map(([, value]) => value), id, ...(this.userId ? [this.userId] : [])),
      ...((signerImportSecret || clearSignerImport) && oldConfigId
        ? [deleteUnusedTaskSecrets(this.db)]
        : []),
    ]);
    const updateIndex = signerImportSecret ? 1 : 0;
    return changes(results[updateIndex]) ? this.getTask(id) : null;
  }

  async deleteTask(id, timestamp) {
    if (!await this.getTask(id)) return { deleted: false, blocked: false };
    const result = await this.db.batch([
      this.db.prepare(`UPDATE task_runs SET status = 'cancelled', finished_at = ?,
        error_code = 'task_deleted', error_message = 'Task was deleted before execution.', updated_at = ?
        WHERE task_id = ? ${this.userId ? "AND user_id = ?" : ""} AND status = 'queued' AND NOT EXISTS (
          SELECT 1 FROM task_runs active
          WHERE active.task_id = task_runs.task_id AND active.status IN ('claimed', 'running')
        )`).bind(timestamp, timestamp, id, ...(this.userId ? [this.userId] : [])),
      this.db.prepare(`DELETE FROM account_leases WHERE task_run_id IN (
        SELECT id FROM task_runs WHERE task_id = ? AND status = 'cancelled' AND error_code = 'task_deleted'
      )`).bind(id),
      this.db.prepare(`DELETE FROM tasks WHERE id = ? ${this.userId ? "AND user_id = ?" : ""} AND NOT EXISTS (
        SELECT 1 FROM task_runs active
        WHERE active.task_id = tasks.id AND active.status IN ('claimed', 'running')
      )`).bind(id, ...(this.userId ? [this.userId] : [])),
      this.db.prepare(`DELETE FROM secret_values WHERE owner_type = 'task' AND owner_id = ?
        AND NOT EXISTS (SELECT 1 FROM tasks WHERE id = ?)`).bind(id, id),
      this.db.prepare(`SELECT COUNT(*) AS count FROM tasks WHERE id = ? ${this.userId ? "AND user_id = ?" : ""}`)
        .bind(id, ...(this.userId ? [this.userId] : [])),
    ]);
    const deleted = changes(result[2]) > 0;
    return {
      deleted,
      blocked: !deleted && Number(rows(result[4])[0]?.count || 0) > 0,
    };
  }

  async getSettings() {
    const result = await this.db.prepare("SELECT setting_key, value_json FROM settings ORDER BY setting_key").all();
    return Object.fromEntries(rows(result).map((row) => [row.setting_key, safeJson(row.value_json)]));
  }

  async updateSettings(values, timestamp) {
    await this.db.batch(Object.entries(values).map(([key, value]) => this.db.prepare(`INSERT INTO settings
      (setting_key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
      .bind(key, JSON.stringify(value), timestamp)));
    return this.getSettings();
  }

  async getNotificationSecretStatus() {
    const result = await this.db.prepare(`SELECT purpose FROM secret_values
      WHERE owner_type = 'setting' AND owner_id = 'telegram_notification'
      AND purpose IN ('bot_token', 'chat_id')`).all();
    const purposes = new Set(rows(result).map((row) => row.purpose));
    return {
      notification_bot_token_configured: purposes.has("bot_token"),
      notification_chat_id_configured: purposes.has("chat_id"),
    };
  }

  async updateNotificationSecrets({ secrets, clearPurposes }) {
    const touched = new Set([
      ...clearPurposes,
      ...secrets.map((secret) => secret.purpose),
    ]);
    const statements = [...touched].map((purpose) => this.db.prepare(`DELETE FROM secret_values
      WHERE owner_type = 'setting' AND owner_id = 'telegram_notification' AND purpose = ?`).bind(purpose));
    statements.push(...secrets.map((secret) => bindSecret(this.db, secret)));
    if (statements.length) await this.db.batch(statements);
    return this.getNotificationSecretStatus();
  }

  async getTelegramApplicationSecretStatus() {
    const result = await this.db.prepare(`SELECT purpose FROM secret_values
      WHERE owner_type = 'setting' AND owner_id = 'telegram_application'
      AND purpose IN ('api_id', 'api_hash')`).all();
    const purposes = new Set(rows(result).map((row) => row.purpose));
    return {
      telegram_api_id_configured: purposes.has("api_id"),
      telegram_api_hash_configured: purposes.has("api_hash"),
      telegram_application_configured: purposes.has("api_id") && purposes.has("api_hash"),
    };
  }

  async getLegacyTelegramApplicationSecretRefs() {
    return this.db.prepare(`SELECT id AS account_id, api_id_secret_id, api_hash_secret_id
      FROM accounts WHERE user_id = 'legacy-admin'
      AND api_id_secret_id IS NOT NULL AND api_hash_secret_id IS NOT NULL
      ORDER BY created_at, id LIMIT 1`).first();
  }

  async getTelegramApplicationStatus() {
    const stored = await this.getTelegramApplicationSecretStatus();
    if (stored.telegram_application_configured) {
      return { ...stored, telegram_application_source: "global" };
    }
    const legacy = await this.getLegacyTelegramApplicationSecretRefs();
    return {
      ...stored,
      telegram_application_configured: Boolean(legacy),
      telegram_application_source: legacy ? "legacy_account" : "missing",
    };
  }

  async updateTelegramApplicationSecrets(secrets) {
    await this.db.batch([
      this.db.prepare(`DELETE FROM secret_values
        WHERE owner_type = 'setting' AND owner_id = 'telegram_application'
        AND purpose IN ('api_id', 'api_hash')`),
      ...secrets.map((secret) => bindSecret(this.db, secret)),
    ]);
    return this.getTelegramApplicationSecretStatus();
  }

  async dashboard(dayStart, limit = 10) {
    const workspaceBindings = this.userId ? [this.userId, this.userId, this.userId, this.userId] : [];
    const [counts, recentRuns, recentLogs, workspaceCounts, upcomingTasks, accountHealth] = await this.db.batch([
      this.db.prepare(`SELECT COUNT(*) AS total,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
        SUM(CASE WHEN status IN ('failed', 'ambiguous') THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status IN ('queued', 'claimed', 'running') THEN 1 ELSE 0 END) AS running
        FROM task_runs WHERE created_at >= ? ${this.userId ? "AND user_id = ?" : ""}`)
        .bind(dayStart, ...(this.userId ? [this.userId] : [])),
      this.db.prepare(`${RUN_SELECT} ${this.userId ? "WHERE r.user_id = ?" : ""} ORDER BY r.created_at DESC LIMIT ?`)
        .bind(...(this.userId ? [this.userId] : []), limit),
      this.db.prepare(`SELECT l.id, l.task_run_id, l.level, l.message, l.created_at,
        CASE WHEN r.context_snapshot_version IS NOT NULL THEN r.task_name_snapshot ELSE t.name END AS task_name
        FROM task_logs l LEFT JOIN task_runs r ON r.id = l.task_run_id LEFT JOIN tasks t ON t.id = r.task_id
        ${this.userId ? "WHERE r.user_id = ?" : ""} ORDER BY l.id DESC LIMIT ?`)
        .bind(...(this.userId ? [this.userId] : []), limit),
      this.db.prepare(`SELECT
        (SELECT COUNT(*) FROM accounts ${this.userId ? "WHERE user_id = ?" : ""}) AS accounts,
        (SELECT COUNT(*) FROM tasks ${this.userId ? "WHERE user_id = ?" : ""}) AS tasks,
        (SELECT COUNT(*) FROM task_runs ${this.userId ? "WHERE user_id = ?" : ""}) AS all_runs,
        (SELECT COUNT(*) FROM task_runs ${this.userId ? "WHERE user_id = ? AND" : "WHERE"}
          status IN ('failed', 'ambiguous')) AS failed_runs`).bind(...workspaceBindings),
      this.db.prepare(`SELECT t.id, t.name, t.account_id, a.name AS account_name, t.skill_id,
        s.skill_key, t.bot, t.command, t.next_run_at, t.timezone
        FROM tasks t JOIN accounts a ON a.id = t.account_id JOIN skills s ON s.id = t.skill_id
        WHERE t.enabled = 1 AND t.next_run_at IS NOT NULL ${this.userId ? "AND t.user_id = ?" : ""}
        ORDER BY t.next_run_at, t.id LIMIT ?`).bind(...(this.userId ? [this.userId] : []), 6),
      this.db.prepare(`SELECT id, user_id, name, phone_masked, status, enabled, last_error,
        last_connected_at, created_at, updated_at FROM accounts
        ${this.userId ? "WHERE user_id = ?" : ""} ORDER BY created_at DESC, id DESC LIMIT ?`)
        .bind(...(this.userId ? [this.userId] : []), 10),
    ]);
    const count = rows(counts)[0] || {};
    const workspace = rows(workspaceCounts)[0] || {};
    return {
      today: {
        total: Number(count.total || 0),
        success: Number(count.success || 0),
        failed: Number(count.failed || 0),
        running: Number(count.running || 0),
      },
      recent_runs: rows(recentRuns).map(mapRun),
      recent_logs: rows(recentLogs),
      workspace: {
        accounts: Number(workspace.accounts || 0),
        tasks: Number(workspace.tasks || 0),
        all_runs: Number(workspace.all_runs || 0),
        failed_runs: Number(workspace.failed_runs || 0),
      },
      upcoming_tasks: rows(upcomingTasks),
      account_health: rows(accountHealth).map(mapAccount),
    };
  }

  async listRuns({ limit, offset, taskId, status }) {
    const conditions = [];
    const bindings = [];
    if (this.userId) { conditions.push("r.user_id = ?"); bindings.push(this.userId); }
    if (taskId) {
      conditions.push("(r.task_id_snapshot = ? OR (r.task_id_snapshot IS NULL AND r.task_id = ?))");
      bindings.push(taskId, taskId);
    }
    if (status) { conditions.push("r.status = ?"); bindings.push(status); }
    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    const result = await this.db.prepare(`${RUN_SELECT}${where} ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`)
      .bind(...bindings, limit, offset).all();
    return rows(result).map(mapRun);
  }

  async getRun(id) {
    const run = mapRun(await this.db.prepare(`${RUN_SELECT} WHERE r.id = ?
      ${this.userId ? "AND r.user_id = ?" : ""}`).bind(id, ...(this.userId ? [this.userId] : [])).first());
    if (!run) return null;
    const [attempts, logsResult] = await this.db.batch([
      this.db.prepare("SELECT * FROM task_attempts WHERE task_run_id = ? ORDER BY attempt_number").bind(id),
      this.db.prepare("SELECT id, attempt_id, level, message, created_at FROM task_logs WHERE task_run_id = ? ORDER BY id").bind(id),
    ]);
    return { ...run, attempts: rows(attempts), logs: rows(logsResult) };
  }

  async getRunByDedupeKey(dedupeKey) {
    return mapRun(await this.db.prepare(`${RUN_SELECT} WHERE r.dedupe_key = ?
      ${this.userId ? "AND r.user_id = ?" : ""}`).bind(dedupeKey, ...(this.userId ? [this.userId] : [])).first());
  }

  async getDueTasks(timestamp, limit = 20) {
    const result = await this.db.prepare(`${TASK_SELECT}
      WHERE t.enabled = 1 AND t.next_run_at IS NOT NULL AND t.next_run_at <= ?
      AND a.enabled = 1 AND a.status = 'connected' AND s.enabled = 1
      ORDER BY t.next_run_at LIMIT ?`).bind(timestamp, limit).all();
    return rows(result).map((row) => ({ ...mapTask(row), skill_id: row.skill_id }));
  }

  async enqueueRun({ run, nextRunAt }) {
    const taskUpdate = nextRunAt === undefined
      ? this.db.prepare(`UPDATE tasks SET last_run_at = ?, updated_at = ? WHERE id = ?
        AND EXISTS (SELECT 1 FROM task_runs WHERE id = ?)`)
        .bind(run.scheduled_for, run.updated_at, run.task_id, run.id)
      : this.db.prepare(`UPDATE tasks SET next_run_at = ?, last_run_at = ?, updated_at = ? WHERE id = ?
        AND EXISTS (SELECT 1 FROM task_runs WHERE id = ?)`)
        .bind(nextRunAt, run.scheduled_for, run.updated_at, run.task_id, run.id);
    const result = await this.db.batch([
      this.db.prepare(`INSERT OR IGNORE INTO task_runs
        (id, user_id, task_id, trigger_type, status, scheduled_for, dedupe_key, max_attempts, claim_expires_at,
         dispatch_status, next_dispatch_at, created_at, updated_at, context_snapshot_version,
         task_id_snapshot, task_name_snapshot, account_id_snapshot, account_name_snapshot,
         skill_key_snapshot, skill_name_snapshot, bot_snapshot, command_snapshot, cron_snapshot,
         timezone_snapshot, retry_snapshot, timeout_seconds_snapshot, thread_id_snapshot, delete_after_seconds_snapshot,
         tg_signer_import_secret_id_snapshot)
        SELECT ?, t.user_id, t.id, ?, 'queued', ?, ?, ?, ?, 'pending', ?, ?, ?, 1,
          t.id, t.name, a.id, a.name, s.skill_key, s.display_name, t.bot, t.command, t.cron,
          t.timezone, t.retry, t.timeout_seconds, t.thread_id, t.delete_after_seconds,
          t.tg_signer_import_secret_id
        FROM tasks t JOIN accounts a ON a.id = t.account_id JOIN skills s ON s.id = t.skill_id
        WHERE t.id = ? AND t.enabled = 1 AND a.enabled = 1 AND a.status = 'connected' AND s.enabled = 1`).bind(
        run.id, run.trigger_type, run.scheduled_for, run.dedupe_key, run.max_attempts,
        run.claim_expires_at, run.created_at, run.created_at, run.updated_at, run.task_id,
      ),
      taskUpdate,
    ]);
    return changes(result[0]) > 0;
  }

  async markRunDispatchFailed(runId, timestamp, message) {
    const nextDispatchAt = new Date(Date.parse(timestamp) + 60_000).toISOString();
    await this.db.prepare(`UPDATE task_runs SET dispatch_status = 'pending', dispatch_reserved_at = NULL,
      next_dispatch_at = ?, error_code = 'dispatch_retry', error_message = ?, updated_at = ?
      WHERE id = ? AND status = 'queued' AND dispatch_status = 'dispatching'`)
      .bind(nextDispatchAt, message, timestamp, runId).run();
  }

  async listDispatchableAccountIds(timestamp, limit = 20) {
    const result = await this.db.prepare(`SELECT COALESCE(r.account_id_snapshot, t.account_id) AS account_id
      FROM task_runs r JOIN tasks t ON t.id = r.task_id
      JOIN accounts a ON a.id = COALESCE(r.account_id_snapshot, t.account_id)
      JOIN skills current_skill ON current_skill.id = t.skill_id
      JOIN skills execution_skill ON execution_skill.skill_key = COALESCE(r.skill_key_snapshot, current_skill.skill_key)
      WHERE r.status = 'queued' AND r.dispatch_status = 'pending'
        AND t.enabled = 1 AND a.enabled = 1 AND a.status = 'connected' AND execution_skill.enabled = 1
        AND (r.next_dispatch_at IS NULL OR r.next_dispatch_at <= ?)
        AND NOT EXISTS (
          SELECT 1 FROM task_runs active JOIN tasks active_task ON active_task.id = active.task_id
          WHERE COALESCE(active.account_id_snapshot, active_task.account_id)
            = COALESCE(r.account_id_snapshot, t.account_id)
            AND (active.status IN ('claimed', 'running')
              OR (active.status = 'queued' AND active.dispatch_status IN ('dispatching', 'dispatched')))
        )
      GROUP BY COALESCE(r.account_id_snapshot, t.account_id)
      ORDER BY MIN(r.scheduled_for), account_id LIMIT ?`).bind(timestamp, limit).all();
    return rows(result).map((row) => row.account_id);
  }

  async reserveNextDispatch(accountId, timestamp) {
    return this.db.prepare(`UPDATE task_runs SET dispatch_status = 'dispatching', dispatch_reserved_at = ?,
      dispatch_attempt_count = dispatch_attempt_count + 1, updated_at = ?, error_code = NULL, error_message = NULL
      WHERE id = (
        SELECT candidate.id FROM task_runs candidate
        JOIN tasks candidate_task ON candidate_task.id = candidate.task_id
        JOIN accounts candidate_account ON candidate_account.id = COALESCE(candidate.account_id_snapshot, candidate_task.account_id)
        JOIN skills candidate_current_skill ON candidate_current_skill.id = candidate_task.skill_id
        JOIN skills candidate_skill ON candidate_skill.skill_key = COALESCE(candidate.skill_key_snapshot, candidate_current_skill.skill_key)
        WHERE COALESCE(candidate.account_id_snapshot, candidate_task.account_id) = ?
          AND candidate.status = 'queued' AND candidate.dispatch_status = 'pending'
          AND candidate_task.enabled = 1 AND candidate_account.enabled = 1
          AND candidate_account.status = 'connected' AND candidate_skill.enabled = 1
          AND (candidate.next_dispatch_at IS NULL OR candidate.next_dispatch_at <= ?)
          AND NOT EXISTS (
            SELECT 1 FROM task_runs active JOIN tasks active_task ON active_task.id = active.task_id
            WHERE COALESCE(active.account_id_snapshot, active_task.account_id) = ?
              AND (active.status IN ('claimed', 'running')
                OR (active.status = 'queued' AND active.dispatch_status IN ('dispatching', 'dispatched')))
          )
        ORDER BY candidate.scheduled_for, candidate.created_at, candidate.id LIMIT 1
      ) AND status = 'queued' AND dispatch_status = 'pending'
      RETURNING id, task_id, scheduled_for, dispatch_attempt_count`).bind(
      timestamp, timestamp, accountId, timestamp, accountId,
    ).first();
  }

  async markRunDispatched(runId, timestamp) {
    const result = await this.db.prepare(`UPDATE task_runs SET dispatch_status = 'dispatched', dispatched_at = ?,
      dispatch_reserved_at = NULL, next_dispatch_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'queued' AND dispatch_status = 'dispatching'`)
      .bind(timestamp, timestamp, runId).run();
    return changes(result) > 0;
  }

  async reconcileRuns(timestamp, staleDispatchBefore) {
    const result = await this.db.batch([
      this.db.prepare(`UPDATE task_runs SET status = 'cancelled', finished_at = ?,
        error_code = 'account_unavailable', error_message = 'Task account is disabled or disconnected.', updated_at = ?
        WHERE status = 'queued' AND EXISTS (
          SELECT 1 FROM tasks queued_task
          JOIN accounts queued_account ON queued_account.id = COALESCE(task_runs.account_id_snapshot, queued_task.account_id)
          JOIN skills queued_current_skill ON queued_current_skill.id = queued_task.skill_id
          JOIN skills queued_skill ON queued_skill.skill_key = COALESCE(task_runs.skill_key_snapshot, queued_current_skill.skill_key)
          WHERE queued_task.id = task_runs.task_id
            AND (queued_task.enabled = 0 OR queued_account.enabled = 0 OR queued_account.status <> 'connected'
              OR queued_skill.enabled = 0)
        )`).bind(timestamp, timestamp),
      this.db.prepare(`DELETE FROM account_leases WHERE task_run_id IN (
        SELECT id FROM task_runs WHERE status = 'cancelled' AND error_code = 'account_unavailable'
      )`),
      this.db.prepare(`UPDATE task_runs SET dispatch_status = 'pending', dispatch_reserved_at = NULL,
        next_dispatch_at = ?, updated_at = ? WHERE status = 'queued' AND dispatch_status = 'dispatching'
        AND dispatch_reserved_at <= ?`).bind(timestamp, timestamp, staleDispatchBefore),
      this.db.prepare(`UPDATE task_runs SET dispatch_status = 'pending', dispatched_at = NULL,
        next_dispatch_at = ?, updated_at = ? WHERE status = 'queued' AND dispatch_status = 'dispatched'
        AND dispatched_at <= ?`).bind(timestamp, timestamp, staleDispatchBefore),
      this.db.prepare(`UPDATE task_runs SET status = 'ambiguous', finished_at = ?,
        error_code = 'runner_lease_expired', error_message = 'Runner lease expired before a terminal callback.',
        updated_at = ? WHERE status IN ('claimed', 'running') AND claim_expires_at <= ?`)
        .bind(timestamp, timestamp, timestamp),
      this.db.prepare(`UPDATE task_runs SET status = 'failed', finished_at = ?,
        error_code = 'queue_expired', error_message = 'Queued run expired before it could be claimed.',
        updated_at = ? WHERE status = 'queued' AND claim_expires_at <= ?`)
        .bind(timestamp, timestamp, timestamp),
      this.db.prepare("DELETE FROM account_leases WHERE leased_until <= ?").bind(timestamp),
      deleteUnusedTaskSecrets(this.db),
    ]);
    return {
      cancelled_unavailable: changes(result[0]),
      reset_dispatches: changes(result[2]) + changes(result[3]),
      expired_runs: changes(result[4]),
      expired_queued: changes(result[5]),
    };
  }

  async getExecution(runId) {
    return this.db.prepare(`SELECT r.*,
      CASE WHEN r.context_snapshot_version IS NOT NULL THEN r.task_name_snapshot ELSE t.name END AS task_name,
      t.enabled AS task_enabled,
      CASE WHEN r.context_snapshot_version IS NOT NULL THEN r.bot_snapshot ELSE t.bot END AS bot,
      CASE WHEN r.context_snapshot_version IS NOT NULL THEN r.command_snapshot ELSE t.command END AS command,
      CASE WHEN r.context_snapshot_version IS NOT NULL THEN r.retry_snapshot ELSE t.retry END AS retry,
      CASE WHEN r.context_snapshot_version IS NOT NULL THEN r.timeout_seconds_snapshot ELSE t.timeout_seconds END AS timeout_seconds,
      CASE WHEN r.context_snapshot_version IS NOT NULL THEN r.thread_id_snapshot ELSE t.thread_id END AS thread_id,
      CASE WHEN r.context_snapshot_version IS NOT NULL THEN r.delete_after_seconds_snapshot ELSE t.delete_after_seconds END AS delete_after_seconds,
      CASE WHEN r.context_snapshot_version IS NOT NULL
        THEN r.tg_signer_import_secret_id_snapshot ELSE t.tg_signer_import_secret_id
      END AS tg_signer_import_secret_id,
      a.id AS account_id,
      CASE WHEN r.context_snapshot_version IS NOT NULL THEN r.account_name_snapshot ELSE a.name END AS account_name,
      a.enabled AS account_enabled, a.status AS account_status, a.phone_secret_id, a.api_id_secret_id,
      a.api_hash_secret_id, a.session_secret_id, a.proxy_secret_id, s.skill_key,
      s.display_name AS skill_name, s.enabled AS skill_enabled
      FROM task_runs r JOIN tasks t ON t.id = r.task_id
      JOIN accounts a ON a.id = COALESCE(r.account_id_snapshot, t.account_id)
      JOIN skills current_skill ON current_skill.id = t.skill_id
      JOIN skills s ON s.skill_key = COALESCE(r.skill_key_snapshot, current_skill.skill_key)
      WHERE r.id = ?`).bind(runId).first();
  }

  async claimRun(runId, githubRunId, timestamp, leaseUntil) {
    const execution = await this.getExecution(runId);
    const accountReady = execution && Boolean(execution.account_enabled) && execution.account_status === "connected";
    const executionReady = accountReady && Boolean(execution.task_enabled) && Boolean(execution.skill_enabled);
    if (execution?.status === "queued" && !executionReady) {
      await this.db.batch([
        this.db.prepare(`UPDATE task_runs SET status = 'cancelled', finished_at = ?,
          error_code = 'account_unavailable', error_message = 'Task account is disabled or disconnected.', updated_at = ?
          WHERE id = ? AND status = 'queued'`).bind(timestamp, timestamp, runId),
        this.db.prepare("DELETE FROM account_leases WHERE task_run_id = ?").bind(runId),
        deleteUnusedTaskSecrets(this.db),
      ]);
      return null;
    }
    if (execution && execution.github_run_id === githubRunId
      && ["claimed", "running"].includes(execution.status)
      && executionReady
      && (!execution.claim_expires_at || execution.claim_expires_at > timestamp)) {
      return execution;
    }
    if (!execution || execution.status !== "queued" || (execution.claim_expires_at && execution.claim_expires_at <= timestamp)) return null;
    const result = await this.db.batch([
      this.db.prepare("DELETE FROM account_leases WHERE leased_until <= ?").bind(timestamp),
      this.db.prepare(`INSERT INTO account_leases
        (account_id, task_run_id, github_run_id, leased_until, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET task_run_id = excluded.task_run_id, github_run_id = excluded.github_run_id,
        leased_until = excluded.leased_until, updated_at = excluded.updated_at
        WHERE account_leases.leased_until <= ?`).bind(
        execution.account_id, runId, githubRunId, leaseUntil, timestamp, timestamp, timestamp,
      ),
      this.db.prepare(`UPDATE task_runs SET status = 'claimed', dispatch_status = 'dispatched', github_run_id = ?, claimed_at = ?,
        claim_expires_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'
        AND EXISTS (SELECT 1 FROM account_leases WHERE account_id = ? AND task_run_id = ? AND github_run_id = ?)
        AND EXISTS (SELECT 1 FROM tasks claim_task
          JOIN accounts claim_account ON claim_account.id = COALESCE(task_runs.account_id_snapshot, claim_task.account_id)
          JOIN skills claim_current_skill ON claim_current_skill.id = claim_task.skill_id
          JOIN skills claim_skill ON claim_skill.skill_key = COALESCE(task_runs.skill_key_snapshot, claim_current_skill.skill_key)
          WHERE claim_task.id = task_runs.task_id
          AND claim_task.enabled = 1 AND claim_account.enabled = 1 AND claim_account.status = 'connected'
          AND claim_skill.enabled = 1)`)
        .bind(githubRunId, timestamp, leaseUntil, timestamp, runId, execution.account_id, runId, githubRunId),
    ]);
    if (changes(result[2]) === 0) {
      await this.db.batch([
        this.db.prepare("DELETE FROM account_leases WHERE task_run_id = ? AND github_run_id = ?").bind(runId, githubRunId),
        this.db.prepare(`UPDATE task_runs SET status = 'cancelled', finished_at = ?,
          error_code = 'account_unavailable', error_message = 'Task account is disabled or disconnected.', updated_at = ?
          WHERE id = ? AND status = 'queued' AND EXISTS (
            SELECT 1 FROM tasks failed_task
            JOIN accounts failed_account ON failed_account.id = COALESCE(task_runs.account_id_snapshot, failed_task.account_id)
            JOIN skills failed_current_skill ON failed_current_skill.id = failed_task.skill_id
            JOIN skills failed_skill ON failed_skill.skill_key = COALESCE(task_runs.skill_key_snapshot, failed_current_skill.skill_key)
            WHERE failed_task.id = task_runs.task_id
              AND (failed_task.enabled = 0 OR failed_account.enabled = 0 OR failed_account.status <> 'connected'
                OR failed_skill.enabled = 0)
          )`).bind(timestamp, timestamp, runId),
        this.db.prepare(`UPDATE task_runs SET dispatch_status = 'pending', dispatched_at = NULL,
          next_dispatch_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'
          AND EXISTS (SELECT 1 FROM tasks retry_task
            JOIN accounts retry_account ON retry_account.id = COALESCE(task_runs.account_id_snapshot, retry_task.account_id)
            JOIN skills retry_current_skill ON retry_current_skill.id = retry_task.skill_id
            JOIN skills retry_skill ON retry_skill.skill_key = COALESCE(task_runs.skill_key_snapshot, retry_current_skill.skill_key)
            WHERE retry_task.id = task_runs.task_id AND retry_task.enabled = 1
              AND retry_account.enabled = 1 AND retry_account.status = 'connected' AND retry_skill.enabled = 1)`)
          .bind(timestamp, timestamp, runId),
        deleteUnusedTaskSecrets(this.db),
      ]);
      return null;
    }
    return this.getExecution(runId);
  }

  async getSecret(id) {
    if (!id) return null;
    return this.db.prepare(`SELECT id, owner_type, owner_id, purpose, algorithm, ciphertext, nonce, aad,
      key_version, expires_at, consumed_at, delivered_to_run_id, delivered_at
      FROM secret_values WHERE id = ?`).bind(id).first();
  }

  async getSecretByOwnerPurpose(ownerType, ownerId, purpose) {
    return this.db.prepare(`SELECT id, owner_type, owner_id, purpose, algorithm, ciphertext, nonce, aad,
      key_version, expires_at, consumed_at, delivered_to_run_id, delivered_at FROM secret_values
      WHERE owner_type = ? AND owner_id = ? AND purpose = ? ORDER BY created_at DESC LIMIT 1`)
      .bind(ownerType, ownerId, purpose).first();
  }

  async replaceOwnerSecret(secret) {
    await this.db.batch([
      this.db.prepare("DELETE FROM secret_values WHERE owner_type = ? AND owner_id = ? AND purpose = ?")
        .bind(secret.owner_type, secret.owner_id, secret.purpose),
      bindSecret(this.db, secret),
    ]);
  }

  async recordAttempt(runId, githubRunId, attempt) {
    const result = await this.db.batch([
      this.db.prepare(`INSERT INTO task_attempts
        (id, task_run_id, attempt_number, status, started_at, finished_at, duration_ms, error_code, error_message, created_at, updated_at)
        SELECT ?, id, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM task_runs
        WHERE id = ? AND github_run_id = ? AND status IN ('claimed', 'running')
        ON CONFLICT(task_run_id, attempt_number) DO UPDATE SET status = excluded.status,
        finished_at = excluded.finished_at, duration_ms = excluded.duration_ms, error_code = excluded.error_code,
        error_message = excluded.error_message, updated_at = excluded.updated_at`).bind(
        attempt.id, attempt.attempt, attempt.status, attempt.started_at, attempt.finished_at, attempt.duration_ms,
        attempt.error_code, attempt.error_message, attempt.created_at, attempt.updated_at, runId, githubRunId,
      ),
      this.db.prepare(`UPDATE task_runs SET status = 'running', started_at = COALESCE(started_at, ?),
        attempt_count = MAX(attempt_count, ?), updated_at = ? WHERE id = ? AND github_run_id = ?
        AND status IN ('claimed', 'running')`).bind(attempt.started_at, attempt.attempt, attempt.updated_at, runId, githubRunId),
    ]);
    return changes(result[1]) > 0;
  }

  async appendLogs(runId, logs) {
    if (!logs.length) return;
    await this.db.batch(logs.map((log) => this.db.prepare(`INSERT OR IGNORE INTO task_logs
      (task_run_id, attempt_id, dedupe_key, level, message, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(runId, log.attempt_id, log.dedupe_key || null, log.level, log.message, log.created_at)));
  }

  async completeRun(runId, githubRunId, completion) {
    const result = await this.db.batch([
      this.db.prepare(`UPDATE task_runs SET status = ?, started_at = COALESCE(started_at, ?), finished_at = ?,
        duration_ms = ?, attempt_count = MAX(attempt_count, ?), error_code = ?,
        error_message = ?, result_json = ?, updated_at = ? WHERE id = ? AND github_run_id = ?
        AND status IN ('claimed', 'running')`).bind(
        completion.status, completion.started_at, completion.finished_at, completion.duration_ms,
        completion.attempts, completion.error_code, completion.error_message, completion.result_json,
        completion.updated_at, runId, githubRunId,
      ),
      this.db.prepare("DELETE FROM account_leases WHERE task_run_id = ? AND github_run_id = ?").bind(runId, githubRunId),
      deleteUnusedTaskSecrets(this.db),
    ]);
    return changes(result[0]) > 0;
  }

  async createLoginFlow({ account, secrets, flow }) {
    const userId = this.userId || account.user_id || "legacy-admin";
    const byPurpose = Object.fromEntries(secrets.map((secret) => [secret.purpose, secret.id]));
    await this.db.batch([
      ...secrets.map((secret) => bindSecret(this.db, secret)),
      this.db.prepare(`INSERT INTO accounts
        (id, user_id, name, phone_masked, phone_secret_id, api_id_secret_id, api_hash_secret_id, proxy_secret_id,
         status, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'login_pending', 1, ?, ?)`)
        .bind(account.id, userId, account.name, account.phone_masked, byPurpose.phone, byPurpose.api_id || null,
          byPurpose.api_hash || null, byPurpose.proxy || null, account.created_at, account.updated_at),
      this.db.prepare(`INSERT INTO login_flows
        (id, user_id, account_id, mode, status, expires_at, created_at, updated_at)
        VALUES (?, ?, ?, 'interactive_login', 'created', ?, ?, ?)`)
        .bind(flow.id, userId, account.id, flow.expires_at, flow.created_at, flow.updated_at),
    ]);
    return this.getLoginFlow(flow.id);
  }

  async getAccountSecretRefs(id) {
    return this.db.prepare(`SELECT id, phone_secret_id, api_id_secret_id, api_hash_secret_id,
      session_secret_id, proxy_secret_id, status, enabled FROM accounts WHERE id = ?
      ${this.userId ? "AND user_id = ?" : ""}`).bind(id, ...(this.userId ? [this.userId] : [])).first();
  }

  async getActiveLoginFlowForAccount(accountId) {
    return this.db.prepare(`SELECT f.id, f.account_id, f.mode, a.name AS account_name, a.phone_masked,
      f.status, f.expires_at, f.last_error, f.created_at, f.updated_at
      FROM login_flows f JOIN accounts a ON a.id = f.account_id
      WHERE f.account_id = ? ${this.userId ? "AND f.user_id = ?" : ""} AND f.status IN
        ('created', 'starting', 'code_required', 'code_submitted', 'password_required', 'password_submitted')
      ORDER BY f.created_at DESC LIMIT 1`).bind(accountId, ...(this.userId ? [this.userId] : [])).first();
  }

  async createSessionValidationFlow(accountId, flow) {
    const active = await this.getActiveLoginFlowForAccount(accountId);
    if (active) return active;
    const result = await this.db.batch([
      this.db.prepare(`INSERT INTO login_flows
        (id, user_id, account_id, mode, status, expires_at, created_at, updated_at)
        SELECT ?, user_id, id, 'session_validation', 'created', ?, ?, ? FROM accounts
        WHERE id = ? ${this.userId ? "AND user_id = ?" : ""} AND session_secret_id IS NOT NULL`)
        .bind(flow.id, flow.expires_at, flow.created_at, flow.updated_at, accountId,
          ...(this.userId ? [this.userId] : [])),
      this.db.prepare(`UPDATE accounts SET status = 'login_pending', last_error = NULL, updated_at = ?
        WHERE id = ? ${this.userId ? "AND user_id = ?" : ""} AND session_secret_id IS NOT NULL`)
        .bind(flow.updated_at, accountId, ...(this.userId ? [this.userId] : [])),
    ]);
    return changes(result[0]) ? this.getLoginFlow(flow.id) : null;
  }

  async getLoginFlow(id) {
    const row = await this.db.prepare(`SELECT f.id, f.account_id, a.name AS account_name, a.phone_masked,
      f.mode, f.status, f.expires_at, f.last_error, f.created_at, f.updated_at
      FROM login_flows f JOIN accounts a ON a.id = f.account_id WHERE f.id = ?
      ${this.userId ? "AND f.user_id = ?" : ""}`).bind(id, ...(this.userId ? [this.userId] : [])).first();
    return row || null;
  }

  async deleteProvisionalLoginFlow(id, expectedStatuses, timestamp = null) {
    const snapshot = await this.getLoginFlow(id);
    if (!snapshot || !expectedStatuses.includes(snapshot.status)) return null;
    if (snapshot.mode === "session_validation") {
      const changedAt = timestamp || snapshot.updated_at;
      const placeholders = expectedStatuses.map(() => "?").join(",");
      const result = await this.db.batch([
        this.db.prepare(`UPDATE login_flows SET status = 'cancelled', updated_at = ?
          WHERE id = ? AND status IN (${placeholders})`).bind(changedAt, id, ...expectedStatuses),
        this.db.prepare(`UPDATE accounts SET status = 'disconnected', last_error = NULL, updated_at = ?
          WHERE id = ? AND EXISTS (SELECT 1 FROM login_flows WHERE id = ? AND status = 'cancelled')`)
          .bind(changedAt, snapshot.account_id, id),
        this.db.prepare("DELETE FROM secret_values WHERE owner_type = 'login_flow' AND owner_id = ?").bind(id),
      ]);
      return changes(result[0]) ? { ...snapshot, status: "cancelled", deleted: false } : null;
    }
    const placeholders = expectedStatuses.map(() => "?").join(",");
    const result = await this.db.batch([
      this.db.prepare(`DELETE FROM secret_values WHERE owner_type = 'login_flow' AND owner_id = ?
        AND EXISTS (SELECT 1 FROM login_flows WHERE id = ? AND status IN (${placeholders}))`)
        .bind(id, id, ...expectedStatuses),
      this.db.prepare(`DELETE FROM secret_values WHERE owner_type = 'task' AND owner_id IN (
        SELECT t.id FROM tasks t JOIN login_flows f ON f.account_id = t.account_id
        WHERE f.id = ? AND f.status IN (${placeholders})
      )`).bind(id, ...expectedStatuses),
      this.db.prepare(`DELETE FROM tasks WHERE account_id IN (
        SELECT account_id FROM login_flows WHERE id = ? AND status IN (${placeholders})
      )`).bind(id, ...expectedStatuses),
      this.db.prepare(`DELETE FROM secret_values WHERE owner_type = 'account' AND owner_id IN (
        SELECT account_id FROM login_flows WHERE id = ? AND status IN (${placeholders})
      )`).bind(id, ...expectedStatuses),
      this.db.prepare(`DELETE FROM accounts WHERE id IN (
        SELECT account_id FROM login_flows WHERE id = ? AND status IN (${placeholders})
      )`).bind(id, ...expectedStatuses),
    ]);
    return changes(result[4]) > 0 ? { ...snapshot, status: "cancelled", deleted: true } : null;
  }

  async failSessionValidationDispatch(id, timestamp) {
    const flow = await this.getLoginFlow(id);
    if (!flow || flow.mode !== "session_validation" || flow.status !== "created") return null;
    const result = await this.db.batch([
      this.db.prepare(`UPDATE login_flows SET status = 'failed', last_error = ?, updated_at = ?
        WHERE id = ? AND mode = 'session_validation' AND status = 'created'`)
        .bind("Session validation runner could not be started.", timestamp, id),
      this.db.prepare(`UPDATE accounts SET status = 'error', last_error = ?, updated_at = ?
        WHERE id = ? AND EXISTS (SELECT 1 FROM login_flows WHERE id = ? AND status = 'failed')`)
        .bind("Session validation runner could not be started.", timestamp, flow.account_id, id),
    ]);
    return changes(result[0]) ? this.getLoginFlow(id) : null;
  }

  async expireLoginFlow(id, timestamp) {
    if (!await this.getLoginFlow(id)) return null;
    await this.db.batch([
      this.db.prepare(`UPDATE login_flows SET status = 'expired', code_secret_id = NULL,
        password_secret_id = NULL, updated_at = ? WHERE id = ?
        AND status NOT IN ('connected', 'failed', 'cancelled', 'expired') AND expires_at <= ?`).bind(timestamp, id, timestamp),
      this.db.prepare(`UPDATE accounts SET status = 'error', last_error = 'Login flow expired.', updated_at = ?
        WHERE id = (SELECT account_id FROM login_flows WHERE id = ? AND status = 'expired')`).bind(timestamp, id),
      this.db.prepare(`DELETE FROM secret_values WHERE owner_type = 'login_flow' AND owner_id = ?
        AND EXISTS (SELECT 1 FROM login_flows WHERE id = ? AND status = 'expired')`).bind(id, id),
    ]);
    return this.getLoginFlow(id);
  }

  async updateLoginStatus(id, expectedStatuses, status, timestamp, error = null) {
    const placeholders = expectedStatuses.map(() => "?").join(",");
    const terminal = isTerminalLoginStatus(status);
    const clearCode = terminal || status === "code_required" || status === "password_required";
    const clearPassword = terminal || status === "password_required";
    const result = await this.db.batch([
      this.db.prepare(`UPDATE login_flows SET status = ?, last_error = ?,
        code_secret_id = CASE WHEN ? THEN NULL ELSE code_secret_id END,
        password_secret_id = CASE WHEN ? THEN NULL ELSE password_secret_id END,
        updated_at = ? WHERE id = ? AND status IN (${placeholders}) AND expires_at > ?`)
        .bind(status, error, clearCode ? 1 : 0, clearPassword ? 1 : 0, timestamp, id, ...expectedStatuses, timestamp),
      this.db.prepare(`DELETE FROM secret_values WHERE owner_type = 'login_flow' AND owner_id = ?
        AND ((? = 1 AND purpose = 'login_code') OR (? = 1 AND purpose = 'two_factor_password'))
        AND EXISTS (SELECT 1 FROM login_flows WHERE id = ? AND status = ?)`)
        .bind(id, clearCode ? 1 : 0, clearPassword ? 1 : 0, id, status),
    ]);
    return changes(result[0]) ? this.getLoginFlow(id) : null;
  }

  async cleanupLoginFlowSecrets(id) {
    await this.db.batch([
      this.db.prepare(`UPDATE login_flows SET code_secret_id = NULL, password_secret_id = NULL
        WHERE id = ? AND status IN ('connected', 'failed', 'cancelled', 'expired')`).bind(id),
      this.db.prepare(`DELETE FROM secret_values WHERE owner_type = 'login_flow' AND owner_id = ?
        AND EXISTS (SELECT 1 FROM login_flows WHERE id = ?
          AND status IN ('connected', 'failed', 'cancelled', 'expired'))`).bind(id, id),
    ]);
  }

  async submitLoginSecret(id, secret, expectedStatus, nextStatus, column) {
    if (!await this.getLoginFlow(id)) return null;
    const result = await this.db.batch([
      bindSecret(this.db, secret),
      this.db.prepare(`UPDATE login_flows SET ${column} = ?, status = ?, updated_at = ?
        WHERE id = ? AND status = ? AND expires_at > ?`)
        .bind(secret.id, nextStatus, secret.updated_at, id, expectedStatus, secret.updated_at),
      this.db.prepare(`DELETE FROM secret_values WHERE owner_type = 'login_flow' AND owner_id = ?
        AND purpose = ? AND id <> ?
        AND EXISTS (SELECT 1 FROM login_flows WHERE id = ? AND ${column} = ?)`)
        .bind(id, secret.purpose, secret.id, id, secret.id),
    ]);
    if (!changes(result[1])) {
      await this.db.prepare("DELETE FROM secret_values WHERE id = ?").bind(secret.id).run();
      return null;
    }
    return this.getLoginFlow(id);
  }

  async claimLoginFlow(id, githubRunId, timestamp) {
    const result = await this.db.prepare(`UPDATE login_flows SET status = 'starting', github_run_id = ?,
      claimed_at = ?, updated_at = ? WHERE id = ? AND status = 'created' AND expires_at > ?`)
      .bind(githubRunId, timestamp, timestamp, id, timestamp).run();
    const execution = await this.db.prepare(`SELECT f.*, a.name AS account_name, a.phone_secret_id, a.api_id_secret_id,
      a.api_hash_secret_id, a.session_secret_id, a.proxy_secret_id FROM login_flows f JOIN accounts a ON a.id = f.account_id
      WHERE f.id = ?`).bind(id).first();
    if (changes(result)) return execution;
    if (execution && execution.github_run_id === githubRunId && execution.status === "starting"
      && execution.expires_at > timestamp) return execution;
    return null;
  }

  async getLoginExecution(id, githubRunId) {
    return this.db.prepare(`SELECT f.*, a.name AS account_name, a.phone_secret_id, a.api_id_secret_id,
      a.api_hash_secret_id, a.session_secret_id, a.proxy_secret_id FROM login_flows f JOIN accounts a ON a.id = f.account_id
      WHERE f.id = ? AND f.github_run_id = ?`).bind(id, githubRunId).first();
  }

  async consumeLoginInput(id, githubRunId, type, timestamp) {
    const column = type === "code" ? "code_secret_id" : "password_secret_id";
    const expected = type === "code" ? "code_submitted" : "password_submitted";
    const flow = await this.db.prepare(`SELECT ${column} AS secret_id FROM login_flows
      WHERE id = ? AND github_run_id = ? AND status = ? AND expires_at > ?`)
      .bind(id, githubRunId, expected, timestamp).first();
    if (!flow?.secret_id) return null;
    const secret = await this.getSecret(flow.secret_id);
    if (!secret || (secret.expires_at && secret.expires_at <= timestamp)) return null;
    if (secret.consumed_at) {
      return secret.delivered_to_run_id === githubRunId ? secret : null;
    }
    const result = await this.db.prepare(`UPDATE secret_values SET consumed_at = ?, delivered_to_run_id = ?,
      delivered_at = ?, updated_at = ? WHERE id = ? AND consumed_at IS NULL`)
      .bind(timestamp, githubRunId, timestamp, timestamp, secret.id).run();
    if (!changes(result)) {
      const delivered = await this.getSecret(secret.id);
      return delivered?.delivered_to_run_id === githubRunId ? delivered : null;
    }
    return { ...secret, consumed_at: timestamp, delivered_to_run_id: githubRunId, delivered_at: timestamp };
  }

  async requestLoginCodeResend(id, timestamp) {
    if (!await this.getLoginFlow(id)) return null;
    const result = await this.db.prepare(`UPDATE login_flows
      SET resend_requested_at = ?, updated_at = ?
      WHERE id = ? AND mode = 'interactive_login' AND status = 'code_required' AND expires_at > ?
        AND (resend_requested_at IS NULL OR resend_consumed_at IS NOT NULL)`)
      .bind(timestamp, timestamp, id, timestamp).run();
    if (changes(result)) return this.getLoginFlow(id);
    const current = await this.getLoginFlow(id);
    return current?.status === "code_required" && current.mode === "interactive_login" ? current : null;
  }

  async consumeLoginCodeResend(id, githubRunId, timestamp) {
    const result = await this.db.prepare(`UPDATE login_flows SET resend_consumed_at = ?, updated_at = ?
      WHERE id = ? AND github_run_id = ? AND mode = 'interactive_login' AND status = 'code_required'
        AND expires_at > ? AND resend_requested_at IS NOT NULL
        AND (resend_consumed_at IS NULL OR resend_consumed_at < resend_requested_at)`)
      .bind(timestamp, timestamp, id, githubRunId, timestamp).run();
    return changes(result) > 0;
  }

  async completeLoginFlow(id, githubRunId, completion) {
    const execution = await this.getLoginExecution(id, githubRunId);
    if (!execution || isTerminalLoginStatus(execution.status)) return null;
    const statements = [];
    if (completion.sessionSecret) {
      statements.push(bindSecretForActiveLoginFlow(this.db, completion.sessionSecret, id, githubRunId));
    }
    statements.push(this.db.prepare(`UPDATE login_flows SET status = ?, last_error = ?,
      code_secret_id = NULL, password_secret_id = NULL, updated_at = ?
      WHERE id = ? AND github_run_id = ? AND status NOT IN ('connected', 'failed', 'cancelled', 'expired')`)
      .bind(completion.status, completion.error, completion.updated_at, id, githubRunId));
    statements.push(this.db.prepare(`UPDATE accounts SET status = ?, session_secret_id = COALESCE(?, session_secret_id),
      last_connected_at = ?, last_error = ?, updated_at = ? WHERE id = ?
      AND EXISTS (
        SELECT 1 FROM login_flows completed_flow
        WHERE completed_flow.id = ? AND completed_flow.account_id = accounts.id
          AND completed_flow.github_run_id = ? AND completed_flow.status = ?
          AND completed_flow.updated_at = ?
      )`)
      .bind(completion.status === "connected" ? "connected" : "error", completion.sessionSecret?.id || null,
        completion.status === "connected" ? completion.updated_at : null, completion.error,
        completion.updated_at, execution.account_id, id, githubRunId, completion.status, completion.updated_at));
    statements.push(this.db.prepare("DELETE FROM secret_values WHERE owner_type = 'login_flow' AND owner_id = ?").bind(id));
    const result = await this.db.batch(statements);
    return changes(result[completion.sessionSecret ? 1 : 0]) ? this.getLoginFlow(id) : null;
  }
}

export function createD1Repository(db) {
  return new D1Repository(db);
}
