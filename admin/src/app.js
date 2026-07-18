import { ApiClient, ApiError } from "./api.js";
import { buildNotificationSettingsPatch, validateNotificationSettings } from "./notification-settings.js";
import {
  createStore,
  filterRows,
  identityDisplayName,
  listFrom,
  needsTelegramApplicationSetup,
  routeFromHash,
} from "./state.js";
import {
  buildAccountPatch,
  hasErrors,
  nextCronOccurrences,
  validateAccount,
  validateAccountPatch,
  validateSettings,
  validateTelegramApplicationSettings,
  validateTask,
} from "./validation.js";
import {
  escapeHtml,
  formatDate,
  formatDuration,
  initials,
  safeUrl,
  shortId,
  statusBadge,
  statusText,
  textOrDash,
} from "./format.js";

const api = new ApiClient();
const store = createStore();
const view = document.querySelector("#view");
const modalRoot = document.querySelector("#modal-root");
const drawerRoot = document.querySelector("#drawer-root");
const toastRegion = document.querySelector("#toast-region");
const apiStatus = document.querySelector("#api-status");
const appShell = document.querySelector("#app");
const authGate = document.querySelector("#auth-gate");
const authMessage = document.querySelector("#auth-message");
const authContent = document.querySelector("#auth-content");

const routeMeta = {
  dashboard: ["概览", "今天的自动签到运行情况"],
  accounts: ["Telegram 账号", "管理登录凭据和连接状态"],
  tasks: ["签到任务", "配置机器人、命令和执行时间"],
  skills: ["Skills", "已部署的安全执行能力"],
  runs: ["执行记录", "检查结果、重试和脱敏日志"],
  sessions: ["登录会话", "查看并撤销已登录的浏览器与设备"],
  settings: ["设置", "个人实例的基础运行配置"],
};

let renderToken = 0;
let loginPollTimer = null;
let turnstileScriptPromise = null;

function pageHead(title, description, actions = "") {
  return `<div class="page-head">
    <div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p></div>
    <div class="page-actions">${actions}</div>
  </div>`;
}

function loadingPage(title, description) {
  return `${pageHead(title, description)}
    <div class="card loading-card" aria-busy="true" aria-label="正在加载">
      <span class="skeleton w32"></span>
      <span class="skeleton w85"></span>
      <span class="skeleton w72"></span>
      <span class="skeleton w91"></span>
    </div>`;
}

function emptyState(icon, title, description, action = "") {
  return `<div class="empty-state">
    <div class="empty-icon" aria-hidden="true">${icon}</div>
    <h3>${escapeHtml(title)}</h3><p>${escapeHtml(description)}</p>${action}
  </div>`;
}

function setApiState(status, label) {
  apiStatus.dataset.status = status;
  apiStatus.querySelector("span").textContent = label;
}

function toast(title, message = "", kind = "success") {
  const element = document.createElement("div");
  element.className = `toast ${kind === "error" ? "error" : ""}`;
  element.innerHTML = `<span aria-hidden="true">${kind === "error" ? "!" : "✓"}</span><div><strong>${escapeHtml(title)}</strong>${message ? escapeHtml(message) : ""}</div>`;
  toastRegion.append(element);
  setTimeout(() => element.remove(), 4800);
}

function errorMessage(error) {
  if (error instanceof ApiError) {
    return error.requestId ? `${error.message}（请求 ${shortId(error.requestId)}）` : error.message;
  }
  return "操作未完成，请稍后重试。";
}

function showPageError(error, retryAction = "refresh") {
  if (error instanceof ApiError && error.status === 401) {
    showLogin("管理会话已过期，请重新登录。");
    return;
  }
  setApiState("error", "连接异常");
  view.innerHTML = `${pageHead(...routeMeta[store.get().route])}
    <div class="card">${emptyState("!", "暂时无法加载", errorMessage(error), `<button class="button primary" type="button" data-action="${retryAction}">重新加载</button>`)}</div>`;
}

function fieldError(errors, name) {
  return errors[name] ? `<p class="field-error" id="${name}-error">${escapeHtml(errors[name])}</p>` : "";
}

function invalidAttr(errors, name) {
  return errors[name] ? `aria-invalid="true" aria-describedby="${name}-error"` : "";
}

function openModal({ title, description = "", body, footer = "", wide = false, onClose } = {}) {
  closeModal(false);
  modalRoot.innerHTML = `<div class="modal-backdrop" data-modal-backdrop>
    <section class="modal ${wide ? "wide" : ""}" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <header class="modal-head"><div><h2 id="modal-title">${escapeHtml(title)}</h2>${description ? `<p>${escapeHtml(description)}</p>` : ""}</div><button type="button" class="modal-close" data-action="close-modal" aria-label="关闭">×</button></header>
      <div class="modal-body">${body}</div>
      ${footer ? `<footer class="modal-foot">${footer}</footer>` : ""}
    </section>
  </div>`;
  modalRoot._onClose = onClose;
  document.body.style.overflow = "hidden";
  queueMicrotask(() => modalRoot.querySelector("input:not([type=hidden]), select, button")?.focus());
}

function closeModal(callHook = true) {
  if (!modalRoot.firstElementChild) return;
  const hook = modalRoot._onClose;
  modalRoot.innerHTML = "";
  modalRoot._onClose = null;
  document.body.style.overflow = drawerRoot.firstElementChild ? "hidden" : "";
  if (loginPollTimer) clearTimeout(loginPollTimer);
  loginPollTimer = null;
  if (callHook && hook) hook();
}

function openDrawer({ title, description = "", body }) {
  closeDrawer();
  drawerRoot.innerHTML = `<div class="drawer-backdrop" data-drawer-backdrop>
    <aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
      <header class="drawer-head"><div><h2 id="drawer-title">${escapeHtml(title)}</h2>${description ? `<p>${escapeHtml(description)}</p>` : ""}</div><button type="button" class="modal-close" data-action="close-drawer" aria-label="关闭">×</button></header>
      <div class="drawer-body">${body}</div>
    </aside>
  </div>`;
  document.body.style.overflow = "hidden";
  drawerRoot.querySelector("button")?.focus();
}

function closeDrawer() {
  drawerRoot.innerHTML = "";
  document.body.style.overflow = modalRoot.firstElementChild ? "hidden" : "";
}

function authLocation() {
  const [path, query = ""] = String(location.hash || "#/login").replace(/^#\/?/, "").split("?", 2);
  return { mode: ["login", "register", "forgot-password", "reset-password", "verify-email"].includes(path) ? path : "login", query: new URLSearchParams(query) };
}

function loadTurnstileScript() {
  if (globalThis.turnstile?.render) return Promise.resolve(globalThis.turnstile);
  if (turnstileScriptPromise) return turnstileScriptPromise;
  turnstileScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    script.onload = () => resolve(globalThis.turnstile);
    script.onerror = () => reject(new Error("Turnstile failed to load"));
    document.head.append(script);
  });
  return turnstileScriptPromise;
}

async function mountTurnstile() {
  const container = authContent.querySelector("[data-turnstile]");
  const field = authContent.querySelector('input[name="turnstile_token"]');
  const sitekey = store.get().authConfig?.turnstile_site_key;
  if (!container || !field || !sitekey) return;
  try {
    const turnstile = await loadTurnstileScript();
    if (!container.isConnected) return;
    turnstile.render(container, {
      sitekey,
      theme: "light",
      callback: (token) => { field.value = token; },
      "expired-callback": () => { field.value = ""; },
      "error-callback": () => { field.value = ""; },
    });
  } catch {
    container.textContent = "人机验证暂时无法加载，请刷新后重试。";
  }
}

function authTabs(mode) {
  return `<div class="auth-tabs" role="tablist" aria-label="登录或注册">
    <button type="button" role="tab" data-auth-mode="login" class="${mode === "login" ? "active" : ""}" aria-selected="${mode === "login"}">登录</button>
    <button type="button" role="tab" data-auth-mode="register" class="${mode === "register" ? "active" : ""}" aria-selected="${mode === "register"}">注册</button>
  </div>`;
}

function turnstileField(config) {
  if (!config?.turnstile_site_key) return "";
  return `<div class="turnstile-slot" data-turnstile aria-label="人机验证"></div><input type="hidden" name="turnstile_token" data-sensitive value="">`;
}

function emailUnavailable() {
  return `<div class="notice warning"><span aria-hidden="true">!</span><span>邮箱登录尚未由平台管理员启用；目前仍可使用 GitHub 登录。</span></div>`;
}

function renderAuthGate(mode = "login", message = "") {
  const config = store.get().authConfig || {};
  authMessage.textContent = message || (mode === "register"
    ? "创建独立工作区，随后绑定自己的 Telegram 账号。"
    : "登录后管理自己的 Telegram 账号与签到任务。");
  const github = config.github_enabled
    ? `<a class="button auth-button github-button" href="/api/auth/github/start">使用 GitHub 继续</a><div class="auth-divider"><span>或者使用邮箱</span></div>`
    : "";
  let content = "";
  if (mode === "login") {
    content = `${authTabs(mode)}${github}${config.email_enabled ? `<form id="email-login-form" class="auth-form" novalidate>
      <div class="field"><label class="required" for="auth-login-email">邮箱</label><input id="auth-login-email" name="email" type="email" maxlength="254" autocomplete="email" required></div>
      <div class="field"><label class="required" for="auth-login-password">密码</label><input id="auth-login-password" name="password" type="password" maxlength="1024" autocomplete="current-password" data-sensitive required></div>
      ${turnstileField(config)}<button class="button primary auth-button" type="submit">邮箱登录</button>
      ${config.password_reset_enabled ? `<button class="auth-link" type="button" data-auth-mode="forgot-password">忘记密码？</button>` : ""}
    </form>` : emailUnavailable()}`;
  } else if (mode === "register") {
    content = `${authTabs(mode)}${github}${config.email_enabled ? `<form id="email-register-form" class="auth-form" novalidate>
      <div class="field"><label class="required" for="auth-register-name">显示名称</label><input id="auth-register-name" name="display_name" maxlength="80" autocomplete="name" required></div>
      <div class="field"><label class="required" for="auth-register-email">邮箱</label><input id="auth-register-email" name="email" type="email" maxlength="254" autocomplete="email" required>${config.email_verification_required ? "" : `<p class="field-help">当前邮箱仅作为登录名，不发送验证邮件；请妥善保管密码。</p>`}</div>
      <div class="field"><label class="required" for="auth-register-password">密码</label><input id="auth-register-password" name="password" type="password" minlength="12" maxlength="1024" autocomplete="new-password" data-sensitive required><p class="field-help">至少 12 个字符。</p></div>
      ${turnstileField(config)}<button class="button primary auth-button" type="submit">创建账号</button>
    </form>` : emailUnavailable()}`;
  } else if (mode === "forgot-password") {
    content = `${config.email_enabled && config.password_reset_enabled ? `<form id="forgot-password-form" class="auth-form" novalidate>
      <div class="auth-section-head"><h2>找回密码</h2><p>输入注册邮箱；无论账号是否存在，响应都相同。</p></div>
      <div class="field"><label class="required" for="auth-forgot-email">邮箱</label><input id="auth-forgot-email" name="email" type="email" maxlength="254" autocomplete="email" required></div>
      ${turnstileField(config)}<button class="button primary auth-button" type="submit">发送重置邮件</button>
      <button class="auth-link" type="button" data-auth-mode="login">返回登录</button>
    </form>` : `<div class="notice warning"><span aria-hidden="true">!</span><span>当前暂未接入邮件找回服务，请联系管理员处理密码重置。</span></div><button class="auth-link" type="button" data-auth-mode="login">返回登录</button>`}`;
  } else if (mode === "reset-password") {
    content = `${config.email_enabled && config.password_reset_enabled ? `<form id="reset-password-form" class="auth-form" novalidate>
      <div class="auth-section-head"><h2>设置新密码</h2><p>提交后，其他已登录会话会全部退出。</p></div>
      <div class="field"><label class="required" for="auth-reset-password">新密码</label><input id="auth-reset-password" name="password" type="password" minlength="12" maxlength="1024" autocomplete="new-password" data-sensitive required></div>
      <div class="field"><label class="required" for="auth-reset-confirm">确认新密码</label><input id="auth-reset-confirm" name="password_confirm" type="password" minlength="12" maxlength="1024" autocomplete="new-password" data-sensitive required></div>
      ${turnstileField(config)}<button class="button primary auth-button" type="submit">重置密码</button>
    </form>` : `<div class="notice warning"><span aria-hidden="true">!</span><span>当前重置链接不可用，请返回登录。</span></div><button class="auth-link" type="button" data-auth-mode="login">返回登录</button>`}`;
  } else {
    content = `<div class="auth-progress" aria-busy="true">正在验证邮箱…</div>`;
  }
  authContent.innerHTML = content;
  queueMicrotask(mountTurnstile);
}

async function completeEmailVerification(token) {
  renderAuthGate("verify-email", "正在验证邮箱，请稍候。");
  try {
    await api.verifyEmail(token);
    history.replaceState(null, "", "/#/login");
    renderAuthGate("login", "邮箱验证成功，现在可以登录。 ");
  } catch (error) {
    history.replaceState(null, "", "/#/login");
    renderAuthGate("login", errorMessage(error));
  }
}

function showLogin(message = "登录或注册后管理自己的签到任务。") {
  closeModal(false);
  closeDrawer();
  appShell.hidden = true;
  authGate.hidden = false;
  const { mode, query } = authLocation();
  if (mode === "verify-email") {
    const token = query.get("token") || "";
    if (token) completeEmailVerification(token);
    else renderAuthGate("login", "验证链接无效或已过期。");
    return;
  }
  renderAuthGate(mode, message);
}

async function loadIdentity() {
  try {
    const [identity, authConfig] = await Promise.all([api.identity(), api.authConfig()]);
    store.set({ identity, authConfig });
    if (!identity?.authenticated) {
      showLogin();
      return false;
    }
    const login = identity.login || identity.email || identity.provider || "用户";
    const roleLabel = identity.role === "admin" ? "管理员" : "用户";
    const accountLabel = identity.provider === "github" ? `@${login}` : login;
    document.querySelector("#identity-name").textContent = identityDisplayName(identity);
    document.querySelector("#identity-email").textContent = `${roleLabel} · ${accountLabel}`;
    document.querySelector(".avatar").textContent = initials(login);
    authGate.hidden = true;
    appShell.hidden = false;
    return true;
  } catch {
    showLogin("暂时无法连接管理服务，请稍后重试。");
    return false;
  }
}

function runName(run) {
  return run.task_name || run.task?.name || run.task_snapshot?.name || "已删除任务";
}

function accountName(item) {
  return item.account_name || item.account?.name || "—";
}

function normalizeSkill(skill) {
  return {
    ...skill,
    key: skill.key || skill.skill_key,
    name: skill.name || skill.display_name || skill.skill_key,
    params_schema: skill.params_schema || skill.config_schema,
  };
}

function renderRunsTable(runs, { compact = false } = {}) {
  if (!runs.length) return emptyState("↻", "还没有执行记录", "手动执行或到达 Cron 时间后，结果会显示在这里。");
  return `<div class="table-wrap"><table>
    <thead><tr><th>任务</th>${compact ? "" : "<th>账号</th>"}<th>状态</th><th>时间</th><th>耗时</th><th>重试</th><th><span class="sr-only">操作</span></th></tr></thead>
    <tbody>${runs.map((run) => `<tr>
      <td><span class="cell-title">${escapeHtml(runName(run))}</span><span class="cell-sub mono">${escapeHtml(shortId(run.id))}</span></td>
      ${compact ? "" : `<td>${escapeHtml(accountName(run))}</td>`}
      <td>${statusBadge(run.status)}</td>
      <td class="nowrap">${formatDate(run.started_at || run.created_at || run.scheduled_for)}</td>
      <td>${formatDuration(run.duration_ms)}</td>
      <td>${escapeHtml(run.attempt_count ?? run.retry_count ?? 0)}</td>
      <td><div class="actions"><button class="button small ghost" type="button" data-action="run-detail" data-id="${escapeHtml(run.id)}">详情</button></div></td>
    </tr>`).join("")}</tbody>
  </table></div>`;
}

async function renderDashboard(token) {
  const [dashboard, settings] = await Promise.all([
    api.dashboard(new Date().toISOString().slice(0, 10)),
    api.settings(),
  ]);
  if (token !== renderToken) return;
  store.set({ dashboard });
  const today = dashboard?.today || {};
  const runs = listFrom(dashboard?.recent_runs, ["runs"]);
  const logs = listFrom(dashboard?.recent_logs, ["logs"]);
  const upcoming = listFrom(dashboard?.upcoming_tasks, ["tasks"]);
  const accountHealth = listFrom(dashboard?.account_health, ["accounts"]);
  const workspace = dashboard?.workspace || {};
  const health = dashboard?.health || {};
  const identity = store.get().identity || {};
  setApiState("ok", "服务正常");
  view.innerHTML = `${pageHead(`${identityDisplayName(identity)} 的工作区`, `${workspace.accounts ?? 0} 个 Telegram 账号 · ${workspace.tasks ?? 0} 个任务 · ${workspace.all_runs ?? 0} 条执行记录`, `<button class="button" type="button" data-action="refresh">↻ 刷新</button>`)}
    <section class="stats-grid" aria-label="今日统计">
      <article class="stat-card"><div class="stat-label">今日执行</div><div class="stat-value">${escapeHtml(today.total ?? 0)}</div><div class="stat-meta">按默认时区统计</div></article>
      <article class="stat-card success"><div class="stat-label">成功</div><div class="stat-value">${escapeHtml(today.success ?? today.succeeded ?? 0)}</div><div class="stat-meta">Telegram 返回成功</div></article>
      <article class="stat-card failed"><div class="stat-label">失败</div><div class="stat-value">${escapeHtml(today.failed ?? 0)}</div><div class="stat-meta">查看记录了解原因</div></article>
      <article class="stat-card running"><div class="stat-label">进行中</div><div class="stat-value">${escapeHtml(today.running ?? 0)}</div><div class="stat-meta">排队和执行中的任务</div></article>
    </section>
    <div class="dashboard-grid">
      <section class="card"><div class="card-head"><div><h2>最近执行</h2><p>最新的自动与手动任务</p></div><a class="button small ghost" href="#/runs">查看全部 →</a></div>${renderRunsTable(runs, { compact: true })}</section>
      <div class="stack">
        <section class="card"><div class="card-head"><div><h2>系统状态</h2><p>Serverless 执行链路</p></div></div><div class="card-body service-list">
          ${serviceRow("D1 数据库", health.database ?? "ok", "配置与运行记录")}
          ${serviceRow("GitHub Actions", health.github ?? "unknown", "Telegram Runner")}
          ${serviceRow("任务调度器", health.scheduler ?? settings?.scheduler_mode ?? "legacy", (settings?.scheduler_mode ?? "legacy") === "d1" ? "D1 动态调度" : "Legacy 兼容模式")}
        </div></section>
        <section class="card"><div class="card-head"><div><h2>最近日志</h2><p>仅显示已脱敏内容</p></div></div><div class="card-body">${renderDashboardLogs(logs)}</div></section>
      </div>
    </div>
    <div class="dashboard-grid mt-md">
      <section class="card"><div class="card-head"><div><h2>即将执行</h2><p>按下一次计划时间排序</p></div><a class="button small ghost" href="#/tasks">管理任务 →</a></div><div class="card-body">${renderUpcomingTasks(upcoming)}</div></section>
      <section class="card"><div class="card-head"><div><h2>Telegram 账号健康</h2><p>连接状态与最近检查</p></div><a class="button small ghost" href="#/accounts">管理账号 →</a></div><div class="card-body">${renderAccountHealth(accountHealth)}</div></section>
    </div>`;
}

function renderUpcomingTasks(tasks) {
  if (!tasks.length) return `<p class="field-help">暂无即将执行的任务。</p>`;
  return `<div class="service-list">${tasks.map((task) => `<div class="service-row"><div><strong>${escapeHtml(task.name)}</strong><small>${escapeHtml(task.account_name || "—")} · ${escapeHtml(task.skill_key || "Skill")}</small></div><span class="nowrap">${formatDate(task.next_run_at)}</span></div>`).join("")}</div>`;
}

function renderAccountHealth(accounts) {
  if (!accounts.length) return `<p class="field-help">尚未绑定 Telegram 账号。</p>`;
  return `<div class="service-list">${accounts.map((account) => `<div class="service-row"><div><strong>${escapeHtml(account.name)}</strong><small>${escapeHtml(account.phone_masked || "—")} · 最近检查 ${formatDate(account.last_connected_at)}</small></div>${statusBadge(account.status)}</div>`).join("")}</div>`;
}

function serviceRow(name, status, description) {
  const healthy = ["ok", "healthy", "d1"].includes(status);
  const label = healthy ? "正常" : status === "legacy" ? "兼容" : status === "unknown" ? "未检测" : "异常";
  const badge = healthy ? "success" : status === "legacy" || status === "unknown" ? "pending" : "error";
  return `<div class="service-row"><div><strong>${escapeHtml(name)}</strong><small>${escapeHtml(description)}</small></div><span class="badge ${badge}">${label}</span></div>`;
}

function renderDashboardLogs(logs) {
  if (!logs.length) return `<p class="field-help">暂无日志。</p>`;
  return `<div class="log-list">${logs.slice(0, 6).map((log) => {
    const entry = typeof log === "string" ? { message: log } : log;
    const level = String(entry.level || "info").toLowerCase();
    return `<div class="log-line"><span class="log-level ${level === "error" ? "error" : ""}">${escapeHtml(level.toUpperCase())}</span><span>${escapeHtml(entry.message || "")}</span><span class="log-time">${formatDate(entry.created_at || entry.timestamp)}</span></div>`;
  }).join("")}</div>`;
}

async function renderAccounts(token) {
  const [payload, settingsPayload] = await Promise.all([api.accounts(), api.settings()]);
  if (token !== renderToken) return;
  const accounts = listFrom(payload, ["accounts"]);
  const settings = settingsPayload?.values || settingsPayload || {};
  store.set({ accounts, settings });
  setApiState("ok", "服务正常");
  const rows = filterRows(accounts, store.get().filters.accounts || {});
  view.innerHTML = `${pageHead("Telegram 账号", "账号凭据加密保存，后台永远不会回显 Session 或 API_HASH", `<button class="button primary" type="button" data-action="add-account">＋ 新增账号</button>`)}
    <section class="card">
      <div class="toolbar"><div class="field search"><label for="account-search">搜索</label><input id="account-search" data-filter="account-query" type="search" placeholder="账号名称、用户名或手机号" value="${escapeHtml(store.get().filters.accounts?.query || "")}"></div><div class="field"><label for="account-status">连接状态</label><select id="account-status" data-filter="account-status"><option value="">全部状态</option>${["connected","disconnected","login_pending","needs_reauth","error"].map((status) => `<option value="${status}" ${store.get().filters.accounts?.status === status ? "selected" : ""}>${statusText(status)}</option>`).join("")}</select></div></div>
      <div id="accounts-table">${renderAccountsTable(rows)}</div>
    </section>`;
}

function renderAccountsTable(accounts) {
  if (!accounts.length) return emptyState("◎", "还没有 Telegram 账号", "可通过网页登录或导入已有 Session 添加账号。", `<button class="button primary" type="button" data-action="add-account">新增账号</button>`);
  return `<div class="table-wrap"><table><thead><tr><th>账号</th><th>手机号</th><th>连接状态</th><th>最近检查</th><th>启用</th><th><span class="sr-only">操作</span></th></tr></thead><tbody>
    ${accounts.map((account) => `<tr><td><span class="cell-title">${escapeHtml(account.name)}</span><span class="cell-sub">${account.username ? `@${escapeHtml(String(account.username).replace(/^@/, ""))}` : "尚无 Telegram 用户信息"}</span></td><td class="mono">${textOrDash(account.phone_masked || account.phone_hint)}</td><td>${statusBadge(account.status)}</td><td>${formatDate(account.last_checked_at || account.last_connected_at)}</td><td><label class="switch"><input type="checkbox" data-action="toggle-account" data-id="${escapeHtml(account.id)}" ${account.enabled ? "checked" : ""} aria-label="${account.enabled ? "停用" : "启用"}${escapeHtml(account.name)}"><span></span></label></td><td><div class="actions"><button class="button small" type="button" data-action="validate-account" data-id="${escapeHtml(account.id)}">检查</button><button class="button small ghost" type="button" data-action="edit-account" data-id="${escapeHtml(account.id)}">编辑</button><button class="button small ghost danger" type="button" data-action="delete-account" data-id="${escapeHtml(account.id)}">删除</button></div></td></tr>`).join("")}
  </tbody></table></div>`;
}

function proxyFields(values = {}) {
  const proxy = values.proxy || {};
  return `<details class="span-2"><summary class="field-label">代理（可选）</summary><div class="form-grid">
    <div class="field"><label for="proxy-scheme">协议</label><select id="proxy-scheme" name="proxy_scheme"><option value="socks5" ${(proxy.protocol || proxy.scheme) === "socks5" ? "selected" : ""}>SOCKS5</option><option value="http" ${(proxy.protocol || proxy.scheme) === "http" ? "selected" : ""}>HTTP</option></select></div>
    <div class="field"><label for="proxy-host">地址</label><input id="proxy-host" name="proxy_host" maxlength="255" autocomplete="off" value="${escapeHtml(proxy.host || "")}" placeholder="127.0.0.1"></div>
    <div class="field"><label for="proxy-port">端口</label><input id="proxy-port" name="proxy_port" type="number" min="1" max="65535" inputmode="numeric" value="${escapeHtml(proxy.port || "")}" placeholder="1080"><div data-error-for="proxy_port"></div></div>
    <div class="field"><label for="proxy-username">用户名</label><input id="proxy-username" name="proxy_username" maxlength="128" autocomplete="off" value="${escapeHtml(proxy.username || "")}"></div>
    <div class="field span-2"><label for="proxy-password">密码</label><input id="proxy-password" name="proxy_password" type="password" maxlength="512" autocomplete="new-password" data-sensitive><p class="field-help">密码仅提交一次，不会在页面中回显。</p></div>
  </div></details>`;
}

function accountFields(mode, values = {}, errors = {}) {
  return `<div class="form-grid">
    ${mode === "import" ? `<div class="field span-2"><label class="required" for="account-name">名称</label><input id="account-name" name="name" maxlength="80" autocomplete="off" value="${escapeHtml(values.name || "")}" placeholder="例如：旧账号" ${invalidAttr(errors,"name")}>${fieldError(errors,"name")}</div>` : ""}
    <div class="field span-2"><label class="required" for="account-phone">手机号</label><input id="account-phone" name="phone" type="tel" maxlength="20" autocomplete="tel" data-sensitive value="" placeholder="+8613812345678" ${invalidAttr(errors,"phone")}>${fieldError(errors,"phone")}<p class="field-help">包含国家/地区代码，不使用空格。后台列表只显示掩码。</p></div>
    ${mode === "import" ? `<div class="field span-2"><label class="required" for="account-session">Telegram Session</label><textarea id="account-session" name="session" maxlength="16384" autocomplete="off" data-sensitive placeholder="粘贴已有 Session；保存后立即清空" ${invalidAttr(errors,"session")}></textarea>${fieldError(errors,"session")}</div>` : ""}
    ${proxyFields(values)}
  </div>`;
}

function openTelegramApplicationSetup(errors = {}) {
  openModal({
    title: "初始化 Telegram 应用",
    description: "平台管理员只需配置一次，之后所有账号都只需手机号、验证码和二步验证。",
    wide: true,
    body: `<div class="notice warning mb-md"><span aria-hidden="true">!</span><span><strong>当前缺少平台凭据</strong><br>Telegram 要求每个客户端使用一组 API_ID 和 API_HASH。它们不包含在 Session 中，也无法从手机号自动推导。</span></div>
      <ol class="setup-steps">
        <li>打开 <a href="https://my.telegram.org/apps" target="_blank" rel="noopener noreferrer">Telegram API 开发工具</a>，使用管理员的 Telegram 账号登录。</li>
        <li>创建一个应用并复制 API_ID 与 API_HASH。</li>
        <li>在下面保存；凭据会加密写入 D1，页面和日志永不回显。</li>
      </ol>
      <form id="telegram-application-setup-form" novalidate>
        <div class="form-grid">
          <div class="field"><label class="required" for="setup-telegram-api-id">API_ID</label><input id="setup-telegram-api-id" name="telegram_api_id" type="password" inputmode="numeric" maxlength="12" autocomplete="new-password" data-sensitive value="" placeholder="例如：12345678" ${invalidAttr(errors, "telegram_api_id")}>${fieldError(errors, "telegram_api_id")}</div>
          <div class="field"><label class="required" for="setup-telegram-api-hash">API_HASH</label><input id="setup-telegram-api-hash" name="telegram_api_hash" type="password" maxlength="64" autocomplete="new-password" data-sensitive value="" placeholder="32 位十六进制字符串" ${invalidAttr(errors, "telegram_api_hash")}>${fieldError(errors, "telegram_api_hash")}</div>
        </div>
      </form>`,
    footer: `<span class="field-help">只由平台管理员设置一次，普通用户不会看到这一步</span><div><button class="button" type="button" data-action="close-modal">取消</button><button class="button primary" type="submit" form="telegram-application-setup-form">保存并继续</button></div>`,
  });
}

async function submitTelegramApplicationSetup(form) {
  const data = new FormData(form);
  const credentials = {
    api_id: String(data.get("telegram_api_id") || "").trim(),
    api_hash: String(data.get("telegram_api_hash") || "").trim(),
  };
  const errors = validateTelegramApplicationSettings(credentials);
  clearSensitive(form);
  if (hasErrors(errors)) {
    credentials.api_id = "";
    credentials.api_hash = "";
    openTelegramApplicationSetup(errors);
    return;
  }
  const submit = modalRoot.querySelector("button[type=submit]");
  submit.disabled = true;
  submit.textContent = "正在加密保存…";
  try {
    await api.updateTelegramApplicationSettings(credentials);
    credentials.api_id = "";
    credentials.api_hash = "";
    const settingsPayload = await api.settings();
    store.set({ settings: settingsPayload?.values || settingsPayload || {} });
    toast("Telegram 应用已初始化", "以后新增账号只需输入手机号。");
    openAccountWizard();
  } catch (error) {
    credentials.api_id = "";
    credentials.api_hash = "";
    toast("初始化失败", errorMessage(error), "error");
    submit.disabled = false;
    submit.textContent = "保存并继续";
  }
}

function openAccountWizard(mode = "login", values = {}, errors = {}) {
  const credentialsMissing = needsTelegramApplicationSetup(store.get().settings);
  if (mode === "login" && credentialsMissing) mode = "import";
  const isLogin = mode === "login";
  const importNotice = credentialsMissing
    ? `<div class="notice warning mb-md"><span aria-hidden="true">!</span><span>平台手机号授权暂时不可用，但不会阻止添加账号。你可以直接导入已有 Session；平台凭据配置成功后，手机号登录会自动启用。</span></div>`
    : `<div class="notice mb-md"><span aria-hidden="true">i</span><span>适合迁移当前 GitHub Secrets 中的 Session。导入后会由短时 GitHub Runner 调用 Telegram 验证，通过前不会标记为已连接。</span></div>`;
  openModal({
    title: "新增 Telegram 账号",
    description: isLogin ? "像 Telegram App 一样，用手机号、验证码和二步验证完成连接" : "高级方式：导入已有 Telegram Session",
    wide: true,
    body: `<div class="tabs" role="tablist" aria-label="添加方式"><button type="button" role="tab" data-action="account-tab" data-mode="login" ${credentialsMissing ? "disabled aria-disabled=\"true\" title=\"平台凭据配置后自动启用\"" : ""} class="${isLogin ? "active" : ""}" aria-selected="${isLogin}">手机号登录${credentialsMissing ? "（待启用）" : ""}</button><button type="button" role="tab" data-action="account-tab" data-mode="import" class="${!isLogin ? "active" : ""}" aria-selected="${!isLogin}">导入已有 Session</button></div>
      ${isLogin ? `<div class="stepper" aria-label="登录进度"><div class="step active"><b>1</b>输入手机号</div><div class="step"><b>2</b>验证码</div><div class="step"><b>3</b>二步验证</div><div class="step"><b>4</b>完成</div></div><div class="notice mb-md"><span aria-hidden="true">i</span><span>Telegram 应用凭据由后台统一管理，无需为每个账号重复填写。</span></div>` : importNotice}
      <form id="account-form" data-mode="${mode}" novalidate>${accountFields(mode, values, errors)}</form>`,
    footer: `<span class="field-help">不会保存到浏览器存储</span><div><button class="button" type="button" data-action="close-modal">取消</button><button class="button primary" type="submit" form="account-form">${isLogin ? "发送验证码" : "加密导入"}</button></div>`,
  });
}

function accountPayload(form, mode) {
  const values = new FormData(form);
  const proxyHost = String(values.get("proxy_host") || "").trim();
  const payload = {
    phone: String(values.get("phone") || "").replace(/[\s-]/g, ""),
  };
  if (mode === "import") {
    payload.name = String(values.get("name") || "").trim();
    payload.session = String(values.get("session") || "").trim();
  }
  if (proxyHost) {
    payload.proxy = {
      protocol: String(values.get("proxy_scheme") || "socks5"),
      host: proxyHost,
      port: Number(values.get("proxy_port")),
    };
    const username = String(values.get("proxy_username") || "");
    const password = String(values.get("proxy_password") || "");
    if (username) payload.proxy.username = username;
    if (password) payload.proxy.password = password;
  }
  return payload;
}

function clearSensitive(form) {
  form?.querySelectorAll("[data-sensitive]").forEach((field) => { field.value = ""; });
}

async function submitAccountForm(form) {
  const mode = form.dataset.mode;
  let payload = accountPayload(form, mode);
  const errors = validateAccount(payload, { requireSession: mode === "import" });
  if (hasErrors(errors)) {
    const safeValues = { name: payload.name };
    clearSensitive(form);
    payload.session = "";
    if (payload.proxy) payload.proxy.password = "";
    openAccountWizard(mode, safeValues, errors);
    return;
  }

  const submit = modalRoot.querySelector("button[type=submit]");
  submit.disabled = true;
  submit.textContent = mode === "login" ? "正在发送…" : "正在导入…";
  try {
    const request = mode === "login" ? api.createLoginFlow(payload) : api.createAccount({ ...payload, enabled: true });
    clearSensitive(form);
    const result = await request;
    payload.session = "";
    payload.phone = "";
    if (payload.proxy) payload.proxy.password = "";
    if (mode === "login") {
      const flow = result?.login_flow || result;
      renderLoginFlow(flow);
    } else {
      try {
        const flow = await api.validateAccount(result.id);
        toast("Session 已加密保存", "正在验证 Telegram 连接。");
        renderLoginFlow(flow?.login_flow || flow);
      } catch (validationError) {
        closeModal(false);
        toast("账号已导入，但验证未启动", errorMessage(validationError), "error");
        await refreshRoute();
      }
    }
  } catch (error) {
    clearSensitive(form);
    payload.session = "";
    if (error instanceof ApiError && error.code === "telegram_application_not_configured") {
      payload.phone = "";
      openAccountWizard("import");
      return;
    }
    toast("添加账号失败", errorMessage(error), "error");
    submit.disabled = false;
    submit.textContent = mode === "login" ? "发送验证码" : "加密导入";
  }
}

function loginStep(status) {
  if (["connected"].includes(status)) return 4;
  if (["password_required", "password_submitted"].includes(status)) return 3;
  if (["code_required", "code_submitted"].includes(status)) return 2;
  return 1;
}

function loginStepper(status) {
  const current = loginStep(status);
  return `<div class="stepper" aria-label="登录进度">${["输入手机号","验证码","二步验证","完成"].map((label,index) => `<div class="step ${index + 1 < current ? "done" : index + 1 === current ? "active" : ""}"><b>${index + 1 < current ? "✓" : index + 1}</b>${label}</div>`).join("")}</div>`;
}

function renderLoginFlow(flow) {
  const id = flow?.id || flow?.login_flow_id;
  const status = flow?.status || "starting";
  const sessionValidation = flow?.mode === "session_validation";
  if (!id) {
    toast("登录流程异常", "服务未返回流程 ID。", "error");
    return;
  }
  if (loginPollTimer) clearTimeout(loginPollTimer);
  let body = sessionValidation ? "" : loginStepper(status);
  let shouldPoll = false;
  let footer = `<span class="field-help">流程 ID：${escapeHtml(shortId(id))}</span><div><button class="button" type="button" data-action="cancel-login" data-id="${escapeHtml(id)}">取消</button></div>`;

  if (["created", "starting", "code_submitted", "password_submitted"].includes(status)) {
    if (status === "starting" && flow.last_error) {
      body += `<div class="notice warning mb-md"><span aria-hidden="true">!</span><span>${escapeHtml(flow.last_error)} 当前账号仍在连接中，Runner 会自动重试，无需重新添加账号。</span></div>`;
    }
    body += `<div class="empty-state"><span class="skeleton w42"></span><h3>${escapeHtml(sessionValidation ? "正在检查 Session" : statusText(status))}</h3><p>${sessionValidation ? "GitHub Runner 正在向 Telegram 验证已导入的 Session。" : "GitHub Login Runner 正在处理，请保持此页面打开。"}</p></div>`;
    shouldPoll = true;
  } else if (status === "code_required") {
    body += `${flow.last_error ? `<div class="notice warning mb-md"><span aria-hidden="true">!</span><span>${escapeHtml(flow.last_error)}</span></div>` : ""}<div class="notice mb-md"><span aria-hidden="true">i</span><span>请先查看已登录的 Telegram 手机或桌面 App；Telegram 也可能按账号情况通过短信或电话发送。验证码只用于本次登录，提交后会立即清除。</span></div><form id="login-code-form" data-id="${escapeHtml(id)}"><div class="field"><label class="required" for="login-code">Telegram 验证码</label><input id="login-code" name="code" type="text" inputmode="numeric" maxlength="12" autocomplete="one-time-code" data-sensitive required placeholder="请输入验证码"></div></form>`;
    footer = `<span class="field-help">未收到时可请求 Telegram 重新发送</span><div><button class="button" type="button" data-action="resend-login" data-id="${escapeHtml(id)}">重新发送</button><button class="button" type="button" data-action="cancel-login" data-id="${escapeHtml(id)}">取消</button><button class="button primary" type="submit" form="login-code-form">验证</button></div>`;
  } else if (status === "password_required") {
    body += `${flow.last_error ? `<div class="notice danger mb-md"><span aria-hidden="true">!</span><span>${escapeHtml(flow.last_error)}</span></div>` : ""}<div class="notice warning mb-md"><span aria-hidden="true">!</span><span>此账号启用了 Telegram 二步验证。密码只用于本次登录，不会保存在浏览器中。</span></div><form id="login-password-form" data-id="${escapeHtml(id)}"><div class="field"><label class="required" for="login-password">二步验证密码</label><input id="login-password" name="password" type="password" maxlength="512" autocomplete="current-password" data-sensitive required></div></form>`;
    footer = `<span></span><div><button class="button" type="button" data-action="cancel-login" data-id="${escapeHtml(id)}">取消</button><button class="button primary" type="submit" form="login-password-form">继续</button></div>`;
  } else if (status === "connected") {
    body += `<div class="success-panel"><div class="success-check" aria-hidden="true">✓</div><h3>账号已连接</h3><p>${escapeHtml(flow.account_name || flow.name || "Telegram 账号")} 已完成验证，可以直接用于创建任务。</p></div>`;
    footer = `<span></span><div><button class="button primary" type="button" data-action="finish-login">完成</button></div>`;
  } else {
    body += `<div class="empty-state"><div class="empty-icon" aria-hidden="true">!</div><h3>${escapeHtml(statusText(status))}</h3><p>${escapeHtml(flow.error_message || flow.last_error || "登录流程未完成，请重新尝试。")}</p></div>`;
    footer = `<span class="field-help">错误码：${escapeHtml(flow.error_code || "LOGIN_FAILED")}</span><div><button class="button" type="button" data-action="close-modal">关闭</button>${sessionValidation ? `<button class="button primary" type="button" data-action="retry-account-validation" data-id="${escapeHtml(flow.account_id)}">重新检查</button>` : `<button class="button primary" type="button" data-action="restart-login">重新添加</button>`}</div>`;
  }

  openModal({
    title: "连接 Telegram",
    description: sessionValidation ? "由短时 GitHub Runner 验证已导入 Session" : "由短时 GitHub Runner 完成登录，不需要常驻服务器",
    wide: false,
    body,
    footer,
    onClose: status === "connected" || ["failed","cancelled","expired"].includes(status) ? null : () => api.cancelLoginFlow(id).catch(() => {}),
  });
  if (shouldPoll) loginPollTimer = setTimeout(() => pollLoginFlow(id), 1800);
}

async function pollLoginFlow(id) {
  try {
    const flow = await api.loginFlow(id);
    renderLoginFlow(flow?.login_flow || flow);
  } catch (error) {
    toast("无法查询登录状态", errorMessage(error), "error");
    loginPollTimer = setTimeout(() => pollLoginFlow(id), 3500);
  }
}

async function submitLoginSecret(form, kind) {
  const id = form.dataset.id;
  const input = form.querySelector("[data-sensitive]");
  const value = input.value;
  if (!value.trim()) return;
  const button = modalRoot.querySelector("button[type=submit]");
  button.disabled = true;
  const request = kind === "code" ? api.submitLoginCode(id, value.trim()) : api.submitLoginPassword(id, value);
  input.value = "";
  try {
    const flow = await request;
    renderLoginFlow(flow?.login_flow || { ...flow, id });
  } catch (error) {
    toast("验证失败", errorMessage(error), "error");
    button.disabled = false;
  }
}

function editAccountFields(account, errors = {}, options = {}) {
  return `<div class="form-grid">
    <div class="field span-2"><label class="required" for="edit-account-name">名称</label><input id="edit-account-name" name="name" maxlength="80" autocomplete="off" value="${escapeHtml(account.name)}" ${invalidAttr(errors, "name")}>${fieldError(errors, "name")}</div>
    <label class="check-row span-2"><input type="checkbox" name="enabled" ${account.enabled ? "checked" : ""}>启用此账号</label>
    <div class="notice span-2"><span aria-hidden="true">i</span><span>下面的账号凭据始终为空白。API_ID 与 API_HASH 已改为在“设置”中统一管理。</span></div>
    <div class="field span-2"><label for="edit-account-phone">新手机号（可选）</label><input id="edit-account-phone" name="phone" type="tel" maxlength="20" autocomplete="off" data-sensitive value="" placeholder="留空保留，例如 +8613812345678" ${invalidAttr(errors, "phone")}>${fieldError(errors, "phone")}</div>
    <div class="field span-2"><label for="edit-account-session">新 Telegram Session（可选）</label><textarea id="edit-account-session" name="session" maxlength="16384" autocomplete="off" data-sensitive placeholder="留空保留；提交后立即清空" ${invalidAttr(errors, "session")}></textarea>${fieldError(errors, "session")}</div>
    <label class="check-row span-2"><input type="checkbox" name="clear_session" ${options.clearSession ? "checked" : ""}>明确清除现有 Session（账号会变为未连接）</label>
    <details class="span-2" ${errors.proxy_protocol || errors.proxy_host || errors.proxy_port || errors.proxy_username || errors.proxy_password || options.clearProxy ? "open" : ""}><summary class="field-label">替换或清除代理（可选）</summary><div class="form-grid">
      <div class="notice span-2"><span aria-hidden="true">i</span><span>代理详情不会回显。填写任意代理字段即表示替换，地址和端口必须完整。</span></div>
      <div class="field"><label for="edit-proxy-protocol">协议</label><select id="edit-proxy-protocol" name="proxy_protocol" ${invalidAttr(errors, "proxy_protocol")}><option value="socks5">SOCKS5</option><option value="socks5h">SOCKS5H</option><option value="socks4">SOCKS4</option><option value="http">HTTP</option><option value="https">HTTPS</option></select>${fieldError(errors, "proxy_protocol")}</div>
      <div class="field"><label for="edit-proxy-host">地址</label><input id="edit-proxy-host" name="proxy_host" maxlength="253" autocomplete="off" data-sensitive value="" placeholder="留空保留" ${invalidAttr(errors, "proxy_host")}>${fieldError(errors, "proxy_host")}</div>
      <div class="field"><label for="edit-proxy-port">端口</label><input id="edit-proxy-port" name="proxy_port" type="password" inputmode="numeric" maxlength="5" autocomplete="new-password" data-sensitive value="" placeholder="例如 1080" ${invalidAttr(errors, "proxy_port")}>${fieldError(errors, "proxy_port")}</div>
      <div class="field"><label for="edit-proxy-username">用户名</label><input id="edit-proxy-username" name="proxy_username" maxlength="255" autocomplete="off" data-sensitive value="" placeholder="可选" ${invalidAttr(errors, "proxy_username")}>${fieldError(errors, "proxy_username")}</div>
      <div class="field span-2"><label for="edit-proxy-password">密码</label><input id="edit-proxy-password" name="proxy_password" type="password" maxlength="1024" autocomplete="new-password" data-sensitive value="" placeholder="可选" ${invalidAttr(errors, "proxy_password")}>${fieldError(errors, "proxy_password")}</div>
      <label class="check-row span-2"><input type="checkbox" name="clear_proxy" ${options.clearProxy ? "checked" : ""}>明确清除现有代理</label>
    </div></details>
  </div>`;
}

function openEditAccount(account, errors = {}, options = {}) {
  openModal({
    title: "编辑账号",
    description: "可更换账号凭据；后台永远不会回显现有秘密",
    wide: true,
    body: `<form id="edit-account-form" data-id="${escapeHtml(account.id)}" novalidate>${editAccountFields(account, errors, options)}</form>`,
    footer: `<span class="field-help">空白凭据不会包含在 PATCH 请求中</span><div><button class="button" type="button" data-action="close-modal">取消</button><button class="button primary" type="submit" form="edit-account-form">保存</button></div>`,
  });
}

function editAccountDraft(form) {
  const data = new FormData(form);
  const proxy = {
    protocol: String(data.get("proxy_protocol") || "socks5"),
    host: String(data.get("proxy_host") || ""),
    port: String(data.get("proxy_port") || ""),
    username: String(data.get("proxy_username") || ""),
    password: String(data.get("proxy_password") || ""),
  };
  return {
    input: {
      name: String(data.get("name") || "").trim(),
      enabled: data.get("enabled") === "on",
      phone: String(data.get("phone") || "").replace(/[\s-]/g, ""),
      session: String(data.get("session") || "").trim(),
      proxy,
    },
    options: {
      clearSession: data.get("clear_session") === "on",
      clearProxy: data.get("clear_proxy") === "on",
    },
  };
}

function scrubAccountDraft(input) {
  for (const field of ["phone", "session"]) input[field] = "";
  if (input.proxy) {
    for (const field of ["host", "port", "username", "password"]) input.proxy[field] = "";
  }
}

async function submitEditAccountForm(form) {
  const { input, options } = editAccountDraft(form);
  clearSensitive(form);
  const errors = validateAccountPatch(input, options);
  if (hasErrors(errors)) {
    const safeAccount = { id: form.dataset.id, name: input.name, enabled: input.enabled };
    scrubAccountDraft(input);
    openEditAccount(safeAccount, errors, options);
    return;
  }

  const patch = buildAccountPatch(input, options);
  const shouldValidate = patch.session !== null
    && ["session", "proxy"].some((field) => Object.hasOwn(patch, field));
  scrubAccountDraft(input);
  const button = modalRoot.querySelector("button[type=submit]");
  button.disabled = true;
  button.textContent = "正在保存…";
  try {
    const request = api.updateAccount(form.dataset.id, patch);
    if (typeof patch.phone === "string") patch.phone = "";
    if (typeof patch.session === "string") patch.session = "";
    if (patch.proxy && typeof patch.proxy === "object") {
      for (const field of ["host", "username", "password"]) if (typeof patch.proxy[field] === "string") patch.proxy[field] = "";
    }
    await request;
    if (shouldValidate) {
      try {
        const flow = await api.validateAccount(form.dataset.id);
        toast("账号已更新", "正在重新验证 Telegram 连接。");
        renderLoginFlow(flow?.login_flow || flow);
      } catch (validationError) {
        closeModal(false);
        toast("账号已更新，但验证未启动", errorMessage(validationError), "error");
        await refreshRoute();
      }
    } else {
      closeModal(false);
      toast("账号已更新");
      await refreshRoute();
    }
  } catch (error) {
    toast("保存失败", errorMessage(error), "error");
    button.disabled = false;
    button.textContent = "保存";
  }
}

async function renderTasks(token) {
  const [tasksPayload, accountsPayload, skillsPayload] = await Promise.all([api.tasks(), api.accounts(), api.skills()]);
  if (token !== renderToken) return;
  const tasks = listFrom(tasksPayload, ["tasks"]);
  const accounts = listFrom(accountsPayload, ["accounts"]);
  const skills = listFrom(skillsPayload, ["skills"]).map(normalizeSkill);
  store.set({ tasks, accounts, skills });
  setApiState("ok", "服务正常");
  const rows = filterRows(tasks, store.get().filters.tasks || {});
  view.innerHTML = `${pageHead("签到任务", "统一 Runner 负责 Skill、重试、超时和日志", `<button class="button primary" type="button" data-action="add-task" ${accounts.length && skills.length ? "" : "disabled"}>＋ 新增任务</button>`)}
    ${!accounts.length ? `<div class="notice warning mb-sm"><span aria-hidden="true">!</span><span>请先添加 Telegram 账号，再创建签到任务。</span></div>` : ""}
    <section class="card"><div class="toolbar"><div class="field search"><label for="task-search">搜索</label><input id="task-search" type="search" data-filter="task-query" placeholder="任务、机器人或命令" value="${escapeHtml(store.get().filters.tasks?.query || "")}"></div><div class="field"><label for="task-account-filter">账号</label><select id="task-account-filter" data-filter="task-account"><option value="">全部账号</option>${accounts.map((account) => `<option value="${escapeHtml(account.id)}" ${store.get().filters.tasks?.accountId === String(account.id) ? "selected" : ""}>${escapeHtml(account.name)}</option>`).join("")}</select></div></div><div id="tasks-table">${renderTasksTable(rows, accounts)}</div></section>`;
}

function renderTasksTable(tasks, accounts) {
  if (!tasks.length) return emptyState("✓", "还没有签到任务", "选择账号和 Skill，填写机器人、命令与 Cron 即可开始。", `<button class="button primary" type="button" data-action="add-task" ${accounts.length ? "" : "disabled"}>新增任务</button>`);
  const names = new Map(accounts.map((account) => [String(account.id), account.name]));
  return `<div class="table-wrap"><table><thead><tr><th>任务</th><th>账号 / Skill</th><th>机器人 / 命令</th><th>Cron</th><th>下次执行</th><th>启用</th><th><span class="sr-only">操作</span></th></tr></thead><tbody>
    ${tasks.map((task) => `<tr><td><span class="cell-title">${escapeHtml(task.name)}</span><span class="cell-sub">重试 ${escapeHtml(task.retry ?? task.retry_count ?? 0)} 次 · 超时 ${escapeHtml(task.timeout_seconds ?? 120)} 秒</span></td><td><span class="cell-title">${escapeHtml(task.account_name || names.get(String(task.account_id)) || "未知账号")}</span><span class="cell-sub mono">${escapeHtml(task.skill_key || task.skill || "—")}</span></td><td><span class="cell-title mono">${escapeHtml(task.bot)}</span><span class="cell-sub">${escapeHtml(String(task.command || "").slice(0, 48))}${String(task.command || "").length > 48 ? "…" : ""}</span></td><td><span class="mono">${escapeHtml(task.cron || task.cron_expr)}</span><span class="cell-sub">${escapeHtml(task.timezone || "Asia/Shanghai")}</span></td><td>${formatDate(task.next_run_at)}</td><td><label class="switch"><input type="checkbox" data-action="toggle-task" data-id="${escapeHtml(task.id)}" ${task.enabled ? "checked" : ""} aria-label="${task.enabled ? "停用" : "启用"}${escapeHtml(task.name)}"><span></span></label></td><td><div class="actions"><button class="button small" type="button" data-action="run-task" data-id="${escapeHtml(task.id)}">执行</button><button class="button small ghost" type="button" data-action="edit-task" data-id="${escapeHtml(task.id)}">编辑</button><button class="button small ghost danger" type="button" data-action="delete-task" data-id="${escapeHtml(task.id)}">删除</button></div></td></tr>`).join("")}
  </tbody></table></div>`;
}

function taskFormValues(task = {}) {
  return {
    name: task.name || "",
    account_id: task.account_id || "",
    skill_key: task.skill_key || task.skill || "send_text",
    bot: task.bot || "",
    command: task.command || "/checkin",
    cron: task.cron || task.cron_expr || "0 0 * * *",
    timezone: task.timezone || store.get().settings.default_timezone || "Asia/Shanghai",
    retry: task.retry ?? task.retry_count ?? 1,
    timeout_seconds: task.timeout_seconds ?? 120,
    thread_id: task.thread_id ?? task.message_thread_id ?? "",
    delete_after_seconds: task.delete_after_seconds ?? "",
    has_tg_signer_import: Boolean(task.has_tg_signer_import),
    enabled: task.enabled ?? true,
  };
}

function taskFormHtml(values, errors = {}) {
  const { accounts, skills } = store.get();
  return `<form id="task-form" data-id="${escapeHtml(values.id || "")}" data-has-tg-signer-import="${values.has_tg_signer_import ? "true" : "false"}" novalidate><div class="form-grid">
    <div class="field span-2"><label class="required" for="task-name">任务名称</label><input id="task-name" name="name" maxlength="100" value="${escapeHtml(values.name)}" placeholder="例如：每日签到" ${invalidAttr(errors,"name")}>${fieldError(errors,"name")}</div>
    <div class="field"><label class="required" for="task-account">账号</label><select id="task-account" name="account_id" ${invalidAttr(errors,"account_id")}><option value="">请选择</option>${accounts.map((account) => `<option value="${escapeHtml(account.id)}" ${String(values.account_id) === String(account.id) ? "selected" : ""}>${escapeHtml(account.name)}${account.status !== "connected" ? `（${statusText(account.status)}）` : ""}</option>`).join("")}</select>${fieldError(errors,"account_id")}</div>
    <div class="field"><label class="required" for="task-skill">Skill</label><select id="task-skill" name="skill_key" ${invalidAttr(errors,"skill_key")}>${skills.map((skill) => `<option value="${escapeHtml(skill.key)}" ${String(values.skill_key) === String(skill.key) ? "selected" : ""} ${skill.enabled === false ? "disabled" : ""}>${escapeHtml(skill.name || skill.key)}${skill.enabled === false ? "（已停用）" : ""}</option>`).join("")}</select>${fieldError(errors,"skill_key")}</div>
    <div class="field span-2"><label class="required" for="task-bot">Bot / Chat</label><input id="task-bot" name="bot" maxlength="128" value="${escapeHtml(values.bot)}" placeholder="@example_bot 或 Chat ID" ${invalidAttr(errors,"bot")}>${fieldError(errors,"bot")}</div>
    <div class="field span-2"><label class="required" for="task-command">Command</label><textarea id="task-command" name="command" maxlength="2000" ${invalidAttr(errors,"command")}>${escapeHtml(values.command)}</textarea>${fieldError(errors,"command")}</div>
    <div class="field span-2"><label for="task-signer-import">tg_signer 配置 <small>${values.has_tg_signer_import ? "已加密保存；留空保持不变" : "仅 tg_signer Skill 需要"}</small></label><textarea id="task-signer-import" name="tg_signer_import" maxlength="131072" autocomplete="off" data-sensitive placeholder="粘贴 tg-signer 导出 JSON 或 Base64；提交后立即清空" ${invalidAttr(errors,"tg_signer_import")}></textarea>${fieldError(errors,"tg_signer_import")}</div>
    <div class="field"><label class="required" for="task-cron">Cron</label><input id="task-cron" class="mono" name="cron" maxlength="96" value="${escapeHtml(values.cron)}" placeholder="0 0 * * *" ${invalidAttr(errors,"cron")}>${fieldError(errors,"cron")}<p class="field-help">标准 5 段：分 时 日 月 星期</p></div>
    <div class="field"><label class="required" for="task-timezone">时区</label><select id="task-timezone" name="timezone" ${invalidAttr(errors,"timezone")}>${["Asia/Shanghai","Asia/Hong_Kong","Asia/Tokyo","UTC","America/Los_Angeles"].map((zone) => `<option value="${zone}" ${values.timezone === zone ? "selected" : ""}>${zone}</option>`).join("")}</select>${fieldError(errors,"timezone")}</div>
    <div class="field"><label for="task-retry">Retry <small>额外重试</small></label><input id="task-retry" name="retry" type="number" min="0" max="5" value="${escapeHtml(values.retry)}" ${invalidAttr(errors,"retry")}>${fieldError(errors,"retry")}</div>
    <div class="field"><label for="task-timeout">Timeout <small>秒</small></label><input id="task-timeout" name="timeout_seconds" type="number" min="10" max="900" value="${escapeHtml(values.timeout_seconds)}" ${invalidAttr(errors,"timeout_seconds")}>${fieldError(errors,"timeout_seconds")}</div>
    <div class="field"><label for="task-thread">Thread ID <small>可选</small></label><input id="task-thread" name="thread_id" type="number" min="1" value="${escapeHtml(values.thread_id)}" ${invalidAttr(errors,"thread_id")}>${fieldError(errors,"thread_id")}</div>
    <div class="field"><label for="task-delete-after">Delete After <small>秒，可选</small></label><input id="task-delete-after" name="delete_after_seconds" type="number" min="0" max="86400" value="${escapeHtml(values.delete_after_seconds)}" ${invalidAttr(errors,"delete_after_seconds")}>${fieldError(errors,"delete_after_seconds")}</div>
    <div class="field span-2"><label class="check-row"><input type="checkbox" name="enabled" ${values.enabled ? "checked" : ""}>保存后启用任务</label></div>
  </div></form>
  <section><h3 class="section-title">未来 5 次执行预览</h3><div id="cron-preview" class="notice">正在计算…</div></section>`;
}

function openTaskModal(task = null, errors = {}, attempted = null) {
  const values = { ...taskFormValues(task || {}), ...(attempted || {}), id: task?.id || "" };
  openModal({
    title: task ? "编辑签到任务" : "新增签到任务",
    description: "所有任务由统一 Runner 执行",
    wide: true,
    body: taskFormHtml(values, errors),
    footer: `<span class="field-help">保存前请核对时区与执行预览</span><div><button class="button" type="button" data-action="close-modal">取消</button><button class="button primary" type="submit" form="task-form">保存任务</button></div>`,
  });
  updateCronPreview();
}

function readTaskForm(form) {
  const data = new FormData(form);
  const optionalNumber = (name) => data.get(name) === "" ? null : Number(data.get(name));
  const signerImport = String(data.get("tg_signer_import") || "").trim();
  const result = {
    name: String(data.get("name") || "").trim(),
    account_id: String(data.get("account_id") || ""),
    skill_key: String(data.get("skill_key") || ""),
    bot: String(data.get("bot") || "").trim(),
    command: String(data.get("command") || ""),
    cron: String(data.get("cron") || "").trim(),
    timezone: String(data.get("timezone") || ""),
    retry: Number(data.get("retry")),
    timeout_seconds: Number(data.get("timeout_seconds")),
    thread_id: optionalNumber("thread_id"),
    delete_after_seconds: optionalNumber("delete_after_seconds"),
    _has_tg_signer_import: form.dataset.hasTgSignerImport === "true",
    enabled: data.get("enabled") === "on",
  };
  if (signerImport) result.tg_signer_import = signerImport;
  return result;
}

function updateCronPreview() {
  const form = modalRoot.querySelector("#task-form");
  const target = modalRoot.querySelector("#cron-preview");
  if (!form || !target) return;
  const values = new FormData(form);
  const occurrences = nextCronOccurrences(String(values.get("cron") || ""), String(values.get("timezone") || ""));
  if (!occurrences.length) {
    target.className = "notice warning";
    target.textContent = "Cron 无效，或未来 45 天内没有执行时间。";
    return;
  }
  target.className = "notice";
  target.innerHTML = `<span aria-hidden="true">✓</span><span>${occurrences.map((date) => escapeHtml(new Intl.DateTimeFormat("zh-CN", { timeZone: String(values.get("timezone")), month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date))).join("　·　")}</span>`;
}

async function submitTaskForm(form) {
  const id = form.dataset.id;
  const values = readTaskForm(form);
  const signerField = form.elements.namedItem("tg_signer_import");
  if (signerField) signerField.value = "";
  const errors = validateTask(values);
  if (hasErrors(errors)) {
    const safeValues = { ...values };
    delete safeValues.tg_signer_import;
    openTaskModal(id ? store.get().tasks.find((task) => String(task.id) === id) : null, errors, safeValues);
    return;
  }
  delete values._has_tg_signer_import;
  const button = modalRoot.querySelector("button[type=submit]");
  button.disabled = true;
  button.textContent = "正在保存…";
  try {
    if (id) await api.updateTask(id, values);
    else await api.createTask(values);
    closeModal(false);
    toast(id ? "任务已更新" : "任务已创建");
    await refreshRoute();
  } catch (error) {
    toast("保存失败", errorMessage(error), "error");
    button.disabled = false;
    button.textContent = "保存任务";
  }
}

async function renderSkills(token) {
  const payload = await api.skills();
  if (token !== renderToken) return;
  const skills = listFrom(payload, ["skills"]).map(normalizeSkill);
  store.set({ skills });
  setApiState("ok", "服务正常");
  view.innerHTML = `${pageHead("Skills", "Skill Registry 只允许执行仓库中已部署和测试的能力")}
    <div class="notice mb-md"><span aria-hidden="true">i</span><span>这里不能上传 Python 或执行任意 Shell。新增 Skill 需要通过代码、测试与部署流程完成。</span></div>
    <section class="skill-grid">${skills.length ? skills.map(renderSkillCard).join("") : `<div class="card grid-all">${emptyState("◇", "Skill Registry 为空", "请先运行 D1 migration 以注册内置 Skills。")}</div>`}</section>`;
}

function renderSkillCard(skill) {
  const params = skill.params_schema || skill.params_schema_json;
  const fieldCount = params?.properties ? Object.keys(params.properties).length : Array.isArray(params) ? params.length : 0;
  return `<article class="skill-card"><div class="skill-card-head"><div><div class="skill-icon" aria-hidden="true">${skill.key === "send_text" ? "T" : "S"}</div><h2>${escapeHtml(skill.name || skill.key)}</h2></div><span class="badge ${skill.enabled ? "enabled" : "disabled"}">${skill.enabled ? "已部署" : "已停用"}</span></div><p>${escapeHtml(skill.description || (skill.key === "send_text" ? "向机器人发送命令，可选 Thread 与自动删除。" : "运行 tg-signer 中经过校验的已注册任务。"))}</p><div class="skill-meta"><span>Registry Key<strong class="mono">${escapeHtml(skill.key)}</strong></span><span>实现版本<strong>${escapeHtml(skill.implementation_version || skill.version || "1")}</strong></span><span>Schema<strong>v${escapeHtml(skill.schema_version || 1)}</strong></span><span>参数<strong>${escapeHtml(fieldCount)} 个字段</strong></span></div></article>`;
}

async function renderRuns(token) {
  const filters = store.get().filters.runs || {};
  const [runsPayload, tasksPayload, accountsPayload] = await Promise.all([
    api.taskRuns({ status: filters.status, task_id: filters.taskId, limit: 100 }),
    api.tasks(),
    api.accounts(),
  ]);
  if (token !== renderToken) return;
  const runs = listFrom(runsPayload, ["runs", "task_runs"]);
  const tasks = listFrom(tasksPayload, ["tasks"]);
  const accounts = listFrom(accountsPayload, ["accounts"]);
  store.set({ runs, tasks, accounts });
  setApiState("ok", "服务正常");
  view.innerHTML = `${pageHead("执行记录", "查看成功、失败、耗时、重试与脱敏日志", `<button class="button" type="button" data-action="refresh">↻ 刷新</button>`)}
    <section class="card"><div class="toolbar"><div class="field"><label for="run-status">状态</label><select id="run-status" data-filter="run-status"><option value="">全部状态</option>${["queued","claimed","running","success","failed","ambiguous","cancelled"].map((status) => `<option value="${status}" ${filters.status === status ? "selected" : ""}>${statusText(status)}</option>`).join("")}</select></div><div class="field"><label for="run-task">任务</label><select id="run-task" data-filter="run-task"><option value="">全部任务</option>${tasks.map((task) => `<option value="${escapeHtml(task.id)}" ${String(filters.taskId || "") === String(task.id) ? "selected" : ""}>${escapeHtml(task.name)}</option>`).join("")}</select></div></div>${renderRunsTable(runs)}</section>`;
}

async function showRunDetail(id) {
  openDrawer({ title: "执行详情", description: `Run ${shortId(id)}`, body: `<div class="loading-card" aria-busy="true"><span class="skeleton w55"></span><span class="skeleton w90"></span><span class="skeleton w75"></span></div>` });
  try {
    const detailPayload = await api.taskRun(id);
    if (!drawerRoot.firstElementChild) return;
    const run = detailPayload?.run || detailPayload;
    const attempts = listFrom(run?.attempts || detailPayload?.attempts, ["attempts"]);
    const logs = listFrom(run?.logs || detailPayload?.logs, ["logs"]);
    const githubUrl = safeUrl(run.github_run_url || run.github_url);
    drawerRoot.querySelector(".drawer-body").innerHTML = `<div class="run-summary">
      <div class="summary-item"><span>状态</span><strong>${statusBadge(run.status)}</strong></div>
      <div class="summary-item"><span>触发方式</span><strong>${escapeHtml(run.trigger || run.trigger_type || "—")}</strong></div>
      <div class="summary-item"><span>总耗时</span><strong>${formatDuration(run.duration_ms)}</strong></div>
      <div class="summary-item"><span>任务</span><strong>${escapeHtml(runName(run))}</strong></div>
      <div class="summary-item"><span>账号</span><strong>${escapeHtml(accountName(run))}</strong></div>
      <div class="summary-item"><span>开始时间</span><strong>${formatDate(run.started_at || run.created_at)}</strong></div>
    </div>
    ${run.error_code || run.error_message ? `<div class="notice danger"><span aria-hidden="true">!</span><span><strong>${escapeHtml(run.error_code || "TASK_FAILED")}</strong><br>${escapeHtml(run.error_message || "任务执行失败。")}</span></div>` : ""}
    ${githubUrl ? `<p><a class="button small" href="${escapeHtml(githubUrl)}" target="_blank" rel="noopener noreferrer">查看 GitHub Actions ↗</a></p>` : ""}
    <h3 class="section-title">尝试记录</h3>${attempts.length ? attempts.map((attempt,index) => `<div class="attempt"><div class="attempt-no">${escapeHtml(attempt.attempt_no || index + 1)}</div><div><strong>${escapeHtml(statusText(attempt.status))}</strong><p>${escapeHtml(attempt.error_message || attempt.message || "本次尝试已完成")}</p></div><span class="cell-sub">${formatDuration(attempt.duration_ms)}</span></div>`).join("") : `<p class="field-help">暂无独立尝试记录。</p>`}
    <h3 class="section-title">脱敏日志</h3>${renderRunLogs(logs)}
    <p class="field-help mt-md">日志经过 Worker 脱敏，后台不提供原始秘密日志。</p>`;
  } catch (error) {
    drawerRoot.querySelector(".drawer-body").innerHTML = emptyState("!", "无法加载执行详情", errorMessage(error), `<button class="button" type="button" data-action="close-drawer">关闭</button>`);
  }
}

function renderRunLogs(logs) {
  if (!logs.length) return `<div class="notice"><span aria-hidden="true">i</span><span>此运行暂时没有日志。</span></div>`;
  return `<div class="log-list">${logs.map((log) => {
    const item = typeof log === "string" ? { message: log } : log;
    return `<div class="log-line"><span class="log-level ${item.level === "error" ? "error" : ""}">${escapeHtml(String(item.level || "info").toUpperCase())}</span><span>${escapeHtml(item.message || item.text || "")}</span><span class="log-time">${formatDate(item.created_at || item.timestamp)}</span></div>`;
  }).join("")}</div>`;
}

async function renderSessions(token) {
  const sessions = await api.sessions();
  if (token !== renderToken) return;
  setApiState("ok", "服务正常");
  const rowsHtml = sessions.length ? `<div class="table-wrap"><table><thead><tr><th>设备</th><th>登录方式</th><th>创建时间</th><th>到期时间</th><th><span class="sr-only">操作</span></th></tr></thead><tbody>
    ${sessions.map((session) => `<tr><td><span class="cell-title">${escapeHtml(session.user_agent_label || "未知浏览器")}</span>${session.current ? '<span class="badge success">当前会话</span>' : ""}</td><td>${escapeHtml(session.provider === "email" ? "邮箱" : "GitHub")}</td><td>${formatDate(session.created_at)}</td><td>${formatDate(session.expires_at)}</td><td>${session.current ? "—" : `<button class="button small ghost danger" type="button" data-action="revoke-session" data-id="${escapeHtml(session.id)}">撤销</button>`}</td></tr>`).join("")}
  </tbody></table></div>` : emptyState("▣", "没有活动会话", "重新登录后会在这里显示当前浏览器。");
  view.innerHTML = `${pageHead("登录会话", "查看并撤销其他已登录的浏览器与设备", `<button class="button" type="button" data-action="refresh">↻ 刷新</button>`)}
    <section class="card">${rowsHtml}</section>`;
}

async function renderSettings(token) {
  const identity = store.get().identity || {};
  if (identity.role !== "admin") {
    if (token !== renderToken) return;
    setApiState("ok", "服务正常");
    view.innerHTML = `${pageHead("设置", "个人账号与安全设置")}
      <div class="settings-layout"><section class="card"><div class="settings-section"><h2>个人资料</h2><p>显示名称：${escapeHtml(identityDisplayName(identity))}</p><p>登录方式：${escapeHtml(identity.provider === "email" ? "邮箱" : "GitHub")}</p><p>账号：${escapeHtml(identity.email || identity.login || "—")}</p></div></section>
      <aside class="stack"><section class="card"><div class="card-head"><h2>账号安全</h2></div><div class="card-body"><a class="button" href="#/sessions">管理登录会话</a></div></section></aside></div>`;
    return;
  }
  const payload = await api.settings();
  if (token !== renderToken) return;
  const settings = payload?.values || payload || {};
  store.set({ settings });
  setApiState("ok", "服务正常");
  const telegramApplicationStatus = settings.telegram_application_source === "global"
    ? '<span class="badge success">已统一配置</span>'
    : settings.telegram_application_source === "legacy_account"
      ? '<span class="badge success">已自动复用旧账号</span>'
      : '<span class="badge pending">尚未配置</span>';
  view.innerHTML = `${pageHead("设置", "只管理个人实例的基础运行配置")}
    <div class="settings-layout"><section class="card"><form id="settings-form" novalidate>
      <div class="settings-section"><h2>时间与调度</h2><p>控制动态任务如何计算执行时间。</p><div class="form-grid">
        <div class="field"><label for="default-timezone">默认时区</label><select id="default-timezone" name="default_timezone">${["Asia/Shanghai","Asia/Hong_Kong","Asia/Tokyo","UTC","America/Los_Angeles"].map((zone) => `<option value="${zone}" ${(settings.default_timezone || "Asia/Shanghai") === zone ? "selected" : ""}>${zone}</option>`).join("")}</select></div>
        <div class="field"><label for="scheduler-mode">Scheduler Mode</label><select id="scheduler-mode" name="scheduler_mode"><option value="legacy" ${settings.scheduler_mode !== "d1" ? "selected" : ""}>legacy — 保留旧 Cron</option><option value="d1" ${settings.scheduler_mode === "d1" ? "selected" : ""}>d1 — 动态任务调度</option></select><p class="field-help">切换到 d1 前应完成迁移和 canary 验证。可随时切回 legacy。</p></div>
      </div></div>
      <div class="settings-section"><h2>Telegram 应用</h2><p>所有账号共用一组 Telegram 应用凭据，不需要在新增账号时重复填写。当前：${telegramApplicationStatus}</p>
        <div class="form-grid">
          <div class="field"><label for="telegram-api-id">新 API_ID（可选）</label><input id="telegram-api-id" name="telegram_api_id" type="password" inputmode="numeric" maxlength="12" autocomplete="new-password" data-sensitive value="" placeholder="留空保留现有配置"></div>
          <div class="field"><label for="telegram-api-hash">新 API_HASH（可选）</label><input id="telegram-api-hash" name="telegram_api_hash" type="password" maxlength="64" autocomplete="new-password" data-sensitive value="" placeholder="留空保留现有配置"></div>
        </div>
        <div class="notice mt-md"><span aria-hidden="true">i</span><span>${settings.telegram_application_source === "legacy_account" ? "当前已从一个旧账号安全复用完整凭据；无需重新配置。" : "只有同时填写两项时才会替换；凭据加密写入 D1 且永不回显。"}</span></div>
      </div>
      <div class="settings-section"><h2>通知</h2><p>任务结束后通过 Telegram Bot 发送结果、GitHub Actions 链接和脱敏日志尾部。现有秘密永远不会回显，空白表示保留。</p>
        <label class="check-row"><input type="checkbox" name="notifications_enabled" ${settings.notifications_enabled ? "checked" : ""}>任务结束后发送通知</label>
        <div class="form-grid">
          <div class="field"><label for="notification-bot-token">新 Bot Token（可选）</label><input id="notification-bot-token" name="notification_bot_token" type="password" maxlength="256" autocomplete="new-password" data-sensitive value="" placeholder="留空保留"><p class="field-help">当前：${settings.notification_bot_token_configured ? '<span class="badge success">已配置</span>' : '<span class="badge pending">未配置</span>'}</p></div>
          <div class="field"><label for="notification-chat-id">新 Chat ID（可选）</label><input id="notification-chat-id" name="notification_chat_id" type="password" maxlength="33" autocomplete="new-password" data-sensitive value="" placeholder="留空保留；支持数字或 @频道"><p class="field-help">当前：${settings.notification_chat_id_configured ? '<span class="badge success">已配置</span>' : '<span class="badge pending">未配置</span>'}</p></div>
          <label class="check-row"><input type="checkbox" name="clear_notification_bot_token">明确清除现有 Bot Token</label>
          <label class="check-row"><input type="checkbox" name="clear_notification_chat_id">明确清除现有 Chat ID</label>
        </div>
        <div class="notice mt-md"><span aria-hidden="true">i</span><span>Token 与 Chat ID 通过独立 API 加密写入 D1；保存或校验失败后输入框也会保持空白。</span></div>
      </div>
      <div class="settings-section"><button class="button primary" type="submit">保存设置</button></div>
    </form></section>
    <aside class="stack"><section class="card"><div class="card-head"><h2>安全边界</h2></div><div class="card-body service-list">${serviceRow("管理员登录", "ok", "GitHub OAuth")}${serviceRow("凭据存储", "ok", "AES-256-GCM")}${serviceRow("Runner 鉴权", "ok", "GitHub OIDC")}</div></section><div class="notice warning"><span aria-hidden="true">!</span><span><strong>切换调度模式</strong><br>只有 legacy 或 d1 会运行，避免同一任务重复签到。</span></div></aside></div>`;
}

function readSettingsForm(form) {
  const data = new FormData(form);
  return {
    values: {
      default_timezone: String(data.get("default_timezone") || ""),
      scheduler_mode: String(data.get("scheduler_mode") || ""),
      notifications_enabled: data.get("notifications_enabled") === "on",
    },
    notificationInput: {
      bot_token: String(data.get("notification_bot_token") || "").trim(),
      chat_id: String(data.get("notification_chat_id") || "").trim(),
    },
    telegramInput: {
      api_id: String(data.get("telegram_api_id") || "").trim(),
      api_hash: String(data.get("telegram_api_hash") || "").trim(),
    },
    notificationOptions: {
      clearBotToken: data.get("clear_notification_bot_token") === "on",
      clearChatId: data.get("clear_notification_chat_id") === "on",
    },
  };
}

async function submitSettings(form) {
  const submission = readSettingsForm(form);
  clearSensitive(form);
  const errors = {
    ...validateSettings(submission.values),
    ...validateTelegramApplicationSettings(submission.telegramInput),
    ...validateNotificationSettings(submission.notificationInput, submission.notificationOptions),
  };
  if (hasErrors(errors)) {
    submission.telegramInput.api_id = "";
    submission.telegramInput.api_hash = "";
    submission.notificationInput.bot_token = "";
    submission.notificationInput.chat_id = "";
    toast("请检查设置", Object.values(errors)[0], "error");
    return;
  }
  const notificationPatch = buildNotificationSettingsPatch(submission.notificationInput, submission.notificationOptions);
  submission.notificationInput.bot_token = "";
  submission.notificationInput.chat_id = "";
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  button.textContent = "正在保存…";
  try {
    const telegramRequest = submission.telegramInput.api_id && submission.telegramInput.api_hash
      ? api.updateTelegramApplicationSettings(submission.telegramInput)
      : Promise.resolve(null);
    const notificationRequest = Object.keys(notificationPatch).length
      ? api.updateNotificationSettings(notificationPatch)
      : Promise.resolve(null);
    submission.telegramInput.api_id = "";
    submission.telegramInput.api_hash = "";
    for (const field of ["bot_token", "chat_id"]) {
      if (typeof notificationPatch[field] === "string") notificationPatch[field] = "";
    }
    await Promise.all([api.updateSettings(submission.values), telegramRequest, notificationRequest]);
    toast("设置已保存");
    await refreshRoute();
  } catch (error) {
    toast("保存失败", errorMessage(error), "error");
    button.disabled = false;
    button.textContent = "保存设置";
  }
}

async function refreshRoute() {
  const route = routeFromHash(location.hash);
  store.set({ route });
  const token = ++renderToken;
  const [title, description] = routeMeta[route];
  document.title = `${title} · Telegram 自动签到`;
  document.querySelector("#breadcrumb").textContent = title;
  document.querySelectorAll("[data-route]").forEach((link) => link.classList.toggle("active", link.dataset.route === route));
  view.innerHTML = loadingPage(title, description);
  setApiState("loading", "连接中");
  try {
    if (route === "dashboard") await renderDashboard(token);
    if (route === "accounts") await renderAccounts(token);
    if (route === "tasks") await renderTasks(token);
    if (route === "skills") await renderSkills(token);
    if (route === "runs") await renderRuns(token);
    if (route === "sessions") await renderSessions(token);
    if (route === "settings") await renderSettings(token);
  } catch (error) {
    if (token === renderToken) showPageError(error);
  }
}

async function withToggle(input, request, successMessage) {
  input.disabled = true;
  try {
    await request();
    toast(successMessage);
  } catch (error) {
    input.checked = !input.checked;
    toast("更新失败", errorMessage(error), "error");
  } finally {
    input.disabled = false;
  }
}

function confirmDeleteAccount(account) {
  openModal({
    title: "删除本地账号？",
    description: account.name,
    body: `<div class="notice danger"><span aria-hidden="true">!</span><span>这会擦除 D1 中的加密凭据。若账号仍有关联任务，服务会拒绝删除，请先删除这些任务。此操作<strong>不会</strong>撤销 Telegram 中的 Session。</span></div>`,
    footer: `<span class="field-help">如需撤销授权，请先在 Telegram 客户端的“设备”中终止该 Session</span><div><button class="button" type="button" data-action="close-modal">取消</button><button class="button danger" type="button" data-action="confirm-delete-account" data-id="${escapeHtml(account.id)}">删除本地凭据</button></div>`,
  });
}

function confirmDeleteTask(task) {
  openModal({
    title: "删除签到任务？",
    description: task.name,
    body: `<p>任务将停止调度；已有运行会保留执行时的账号、Skill、Bot、Command、Cron 等上下文和脱敏日志，但不能一键恢复已删除任务。</p>`,
    footer: `<span></span><div><button class="button" type="button" data-action="close-modal">取消</button><button class="button danger" type="button" data-action="confirm-delete-task" data-id="${escapeHtml(task.id)}">删除任务</button></div>`,
  });
}

function confirmRunTask(task) {
  openModal({
    title: "立即执行任务？",
    description: task.name,
    body: `<div class="notice warning"><span aria-hidden="true">!</span><span>将立即通过 GitHub Actions 向 <strong>${escapeHtml(task.bot)}</strong> 发送命令，并创建一条手动运行记录；同一次请求若发生网络重送会自动去重。</span></div>`,
    footer: `<span class="field-help">账号：${escapeHtml(task.account_name || "已选择账号")}</span><div><button class="button" type="button" data-action="close-modal">取消</button><button class="button primary" type="button" data-action="confirm-run-task" data-id="${escapeHtml(task.id)}">立即执行</button></div>`,
  });
}

async function submitAuthForm(form) {
  const data = new FormData(form);
  const button = form.querySelector('button[type="submit"]');
  const turnstileToken = String(data.get("turnstile_token") || "");
  button.disabled = true;
  button.textContent = "正在提交…";
  try {
    if (form.id === "email-login-form") {
      const payload = {
        email: String(data.get("email") || "").trim(),
        password: String(data.get("password") || ""),
        turnstile_token: turnstileToken,
      };
      const operation = api.loginEmail(payload);
      clearSensitive(form);
      payload.password = "";
      payload.turnstile_token = "";
      await operation;
      history.replaceState(null, "", "/#/dashboard");
      if (await loadIdentity()) await refreshRoute();
      return;
    }
    if (form.id === "email-register-form") {
      const payload = {
        display_name: String(data.get("display_name") || "").trim(),
        email: String(data.get("email") || "").trim(),
        password: String(data.get("password") || ""),
        turnstile_token: turnstileToken,
      };
      const operation = api.registerEmail(payload);
      clearSensitive(form);
      payload.password = "";
      payload.turnstile_token = "";
      await operation;
      if (!store.get().authConfig?.email_verification_required) {
        history.replaceState(null, "", "/#/dashboard");
        if (await loadIdentity()) await refreshRoute();
        return;
      }
      history.replaceState(null, "", "/#/login");
      renderAuthGate("login", "验证邮件已发送，请先在邮箱中完成验证。 ");
      return;
    }
    if (form.id === "forgot-password-form") {
      const payload = {
        email: String(data.get("email") || "").trim(),
        turnstile_token: turnstileToken,
      };
      const operation = api.forgotPassword(payload);
      clearSensitive(form);
      payload.turnstile_token = "";
      await operation;
      history.replaceState(null, "", "/#/login");
      renderAuthGate("login", "如果该邮箱已注册，重置邮件已经发送。 ");
      return;
    }
    if (form.id === "reset-password-form") {
      const password = String(data.get("password") || "");
      const confirmation = String(data.get("password_confirm") || "");
      if (password !== confirmation) throw new ApiError("两次输入的密码不一致。", { code: "PASSWORD_MISMATCH" });
      const token = authLocation().query.get("token") || "";
      const payload = { token, password, turnstile_token: turnstileToken };
      const operation = api.resetPassword(payload);
      clearSensitive(form);
      payload.password = "";
      payload.token = "";
      payload.turnstile_token = "";
      await operation;
      history.replaceState(null, "", "/#/login");
      renderAuthGate("login", "密码已重置，请使用新密码登录。 ");
    }
  } catch (error) {
    clearSensitive(form);
    renderAuthGate(authLocation().mode, errorMessage(error));
  }
}

view.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  const id = target.dataset.id;
  const state = store.get();
  if (action === "refresh") return refreshRoute();
  if (action === "add-account") return openAccountWizard();
  if (action === "add-task") return openTaskModal();
  if (action === "run-detail") return showRunDetail(id);
  if (action === "revoke-session") {
    target.disabled = true;
    try { await api.revokeSession(id); toast("登录会话已撤销"); return refreshRoute(); }
    catch (error) { target.disabled = false; return toast("撤销失败", errorMessage(error), "error"); }
  }
  if (action === "validate-account") {
    target.disabled = true;
    try { return renderLoginFlow(await api.validateAccount(id)); }
    catch (error) { target.disabled = false; return toast("无法检查账号", errorMessage(error), "error"); }
  }
  if (action === "edit-account") return openEditAccount(state.accounts.find((item) => String(item.id) === id));
  if (action === "delete-account") return confirmDeleteAccount(state.accounts.find((item) => String(item.id) === id));
  if (action === "edit-task") return openTaskModal(state.tasks.find((item) => String(item.id) === id));
  if (action === "delete-task") return confirmDeleteTask(state.tasks.find((item) => String(item.id) === id));
  if (action === "run-task") return confirmRunTask(state.tasks.find((item) => String(item.id) === id));
});

view.addEventListener("change", async (event) => {
  const input = event.target;
  if (input.matches('[data-action="toggle-account"]')) {
    const account = store.get().accounts.find((item) => String(item.id) === input.dataset.id);
    await withToggle(input, () => api.updateAccount(account.id, { enabled: input.checked }), input.checked ? "账号已启用" : "账号已停用");
  }
  if (input.matches('[data-action="toggle-task"]')) {
    const task = store.get().tasks.find((item) => String(item.id) === input.dataset.id);
    await withToggle(input, () => api.updateTask(task.id, { enabled: input.checked }), input.checked ? "任务已启用" : "任务已停用");
  }
  if (input.matches('[data-filter="account-status"]')) {
    store.set((state) => ({ filters: { ...state.filters, accounts: { ...state.filters.accounts, status: input.value } } }));
    document.querySelector("#accounts-table").innerHTML = renderAccountsTable(filterRows(store.get().accounts, store.get().filters.accounts));
  }
  if (input.matches('[data-filter="task-account"]')) {
    store.set((state) => ({ filters: { ...state.filters, tasks: { ...state.filters.tasks, accountId: input.value } } }));
    document.querySelector("#tasks-table").innerHTML = renderTasksTable(filterRows(store.get().tasks, store.get().filters.tasks), store.get().accounts);
  }
  if (input.matches('[data-filter="run-status"]')) {
    store.set((state) => ({ filters: { ...state.filters, runs: { ...state.filters.runs, status: input.value } } }));
    refreshRoute();
  }
  if (input.matches('[data-filter="run-task"]')) {
    store.set((state) => ({ filters: { ...state.filters, runs: { ...state.filters.runs, taskId: input.value } } }));
    refreshRoute();
  }
});

view.addEventListener("input", (event) => {
  const input = event.target;
  if (input.matches('[data-filter="account-query"]')) {
    store.set((state) => ({ filters: { ...state.filters, accounts: { ...state.filters.accounts, query: input.value } } }));
    document.querySelector("#accounts-table").innerHTML = renderAccountsTable(filterRows(store.get().accounts, store.get().filters.accounts));
  }
  if (input.matches('[data-filter="task-query"]')) {
    store.set((state) => ({ filters: { ...state.filters, tasks: { ...state.filters.tasks, query: input.value } } }));
    document.querySelector("#tasks-table").innerHTML = renderTasksTable(filterRows(store.get().tasks, store.get().filters.tasks), store.get().accounts);
  }
});

modalRoot.addEventListener("click", async (event) => {
  const actionTarget = event.target.closest("[data-action]");
  if (!actionTarget) {
    if (event.target.matches("[data-modal-backdrop]")) closeModal();
    return;
  }
  const action = actionTarget.dataset.action;
  const id = actionTarget.dataset.id;
  if (action === "close-modal") return closeModal();
  if (action === "account-tab") return openAccountWizard(actionTarget.dataset.mode);
  if (action === "restart-login") return openAccountWizard();
  if (action === "retry-account-validation") {
    actionTarget.disabled = true;
    try { return renderLoginFlow(await api.validateAccount(id)); }
    catch (error) { actionTarget.disabled = false; return toast("无法检查账号", errorMessage(error), "error"); }
  }
  if (action === "resend-login") {
    actionTarget.disabled = true;
    try {
      const flow = await api.resendLoginCode(id);
      toast("已请求重新发送", "请等待 Telegram 验证码。");
      return renderLoginFlow(flow?.login_flow || flow);
    } catch (error) {
      actionTarget.disabled = false;
      return toast("无法重新发送", errorMessage(error), "error");
    }
  }
  if (action === "finish-login") { closeModal(false); toast("Telegram 账号已连接"); return refreshRoute(); }
  if (action === "cancel-login") {
    actionTarget.disabled = true;
    try { await api.cancelLoginFlow(id); } catch { /* The flow may already be terminal. */ }
    closeModal(false);
    toast("登录流程已取消");
  }
  if (action === "confirm-delete-account") {
    actionTarget.disabled = true;
    try { await api.deleteAccount(id); closeModal(false); toast("本地账号已删除"); await refreshRoute(); }
    catch (error) { toast("删除失败", errorMessage(error), "error"); actionTarget.disabled = false; }
  }
  if (action === "confirm-delete-task") {
    actionTarget.disabled = true;
    try { await api.deleteTask(id); closeModal(false); toast("任务已删除"); await refreshRoute(); }
    catch (error) { toast("删除失败", errorMessage(error), "error"); actionTarget.disabled = false; }
  }
  if (action === "confirm-run-task") {
    actionTarget.disabled = true;
    actionTarget.textContent = "正在派发…";
    try {
      const run = await api.runTask(id);
      closeModal(false);
      toast("任务已进入队列", `Run ${shortId(run?.id || run?.run_id)}`);
      location.hash = "#/runs";
    } catch (error) {
      toast("无法执行任务", errorMessage(error), "error");
      actionTarget.disabled = false;
      actionTarget.textContent = "立即执行";
    }
  }
});

modalRoot.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  if (form.id === "account-form") await submitAccountForm(form);
  if (form.id === "telegram-application-setup-form") await submitTelegramApplicationSetup(form);
  if (form.id === "login-code-form") await submitLoginSecret(form, "code");
  if (form.id === "login-password-form") await submitLoginSecret(form, "password");
  if (form.id === "task-form") await submitTaskForm(form);
  if (form.id === "edit-account-form") await submitEditAccountForm(form);
});

modalRoot.addEventListener("input", (event) => {
  if (event.target.matches("#task-cron, #task-timezone")) updateCronPreview();
});

drawerRoot.addEventListener("click", (event) => {
  if (event.target.closest('[data-action="close-drawer"]') || event.target.matches("[data-drawer-backdrop]")) closeDrawer();
});

view.addEventListener("submit", async (event) => {
  if (event.target.id !== "settings-form") return;
  event.preventDefault();
  await submitSettings(event.target);
});

authGate.addEventListener("click", (event) => {
  const target = event.target.closest("[data-auth-mode]");
  if (!target) return;
  const mode = target.dataset.authMode;
  history.replaceState(null, "", `/#/${mode}`);
  renderAuthGate(mode);
});

authGate.addEventListener("submit", async (event) => {
  event.preventDefault();
  await submitAuthForm(event.target);
});

window.addEventListener("hashchange", () => {
  closeModal();
  closeDrawer();
  document.body.classList.remove("nav-open");
  if (!appShell.hidden) refreshRoute();
  else showLogin();
});

document.querySelector("#menu-toggle").addEventListener("click", (event) => {
  const open = document.body.classList.toggle("nav-open");
  event.currentTarget.setAttribute("aria-expanded", String(open));
});

document.querySelector("#logout-button").addEventListener("click", async (event) => {
  event.currentTarget.disabled = true;
  try {
    await api.logout();
    location.replace("/");
  } catch (error) {
    event.currentTarget.disabled = false;
    toast("退出失败", errorMessage(error), "error");
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (modalRoot.firstElementChild) closeModal();
  else if (drawerRoot.firstElementChild) closeDrawer();
  else document.body.classList.remove("nav-open");
});

async function bootstrap() {
  if (await loadIdentity()) {
    if (!location.hash) location.replace("#/dashboard");
    await refreshRoute();
  }
}

bootstrap();
