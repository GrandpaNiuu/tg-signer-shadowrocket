import { ApiClient, ApiError } from "./api.js";
import { buildNotificationSettingsPatch, validateNotificationSettings } from "./notification-settings.js";
import {
  createStore,
  filterRows,
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
  dashboard: ["??", "???????????"],
  accounts: ["Telegram ??", "???????????"],
  tasks: ["????", "?????????????"],
  skills: ["Skills", "??????????"],
  runs: ["????", "????????????"],
  sessions: ["????", "???????????????"],
  settings: ["??", "???????????"],
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
    <div class="card loading-card" aria-busy="true" aria-label="????">
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
  element.innerHTML = `<span aria-hidden="true">${kind === "error" ? "!" : "?"}</span><div><strong>${escapeHtml(title)}</strong>${message ? escapeHtml(message) : ""}</div>`;
  toastRegion.append(element);
  setTimeout(() => element.remove(), 4800);
}

function errorMessage(error) {
  if (error instanceof ApiError) {
    return error.requestId ? `${error.message}??? ${shortId(error.requestId)}?` : error.message;
  }
  return "????????????";
}

function showPageError(error, retryAction = "refresh") {
  if (error instanceof ApiError && error.status === 401) {
    showLogin("??????????????");
    return;
  }
  setApiState("error", "????");
  view.innerHTML = `${pageHead(...routeMeta[store.get().route])}
    <div class="card">${emptyState("!", "??????", errorMessage(error), `<button class="button primary" type="button" data-action="${retryAction}">????</button>`)}</div>`;
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
      <header class="modal-head"><div><h2 id="modal-title">${escapeHtml(title)}</h2>${description ? `<p>${escapeHtml(description)}</p>` : ""}</div><button type="button" class="modal-close" data-action="close-modal" aria-label="??">?</button></header>
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
      <header class="drawer-head"><div><h2 id="drawer-title">${escapeHtml(title)}</h2>${description ? `<p>${escapeHtml(description)}</p>` : ""}</div><button type="button" class="modal-close" data-action="close-drawer" aria-label="??">?</button></header>
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
    container.textContent = "??????????????????";
  }
}

function authTabs(mode) {
  return `<div class="auth-tabs" role="tablist" aria-label="?????">
    <button type="button" role="tab" data-auth-mode="login" class="${mode === "login" ? "active" : ""}" aria-selected="${mode === "login"}">??</button>
    <button type="button" role="tab" data-auth-mode="register" class="${mode === "register" ? "active" : ""}" aria-selected="${mode === "register"}">??</button>
  </div>`;
}

function turnstileField() {
  return `<div class="turnstile-slot" data-turnstile aria-label="????"></div><input type="hidden" name="turnstile_token" data-sensitive value="">`;
}

function emailUnavailable() {
  return `<div class="notice warning"><span aria-hidden="true">!</span><span>????????????????????? GitHub ???</span></div>`;
}

function renderAuthGate(mode = "login", message = "") {
  const config = store.get().authConfig || {};
  authMessage.textContent = message || (mode === "register"
    ? "??????????????? Telegram ???"
    : "???????? Telegram ????????");
  const github = config.github_enabled
    ? `<a class="button auth-button github-button" href="/api/auth/github/start">?? GitHub ??</a><div class="auth-divider"><span>??????</span></div>`
    : "";
  let content = "";
  if (mode === "login") {
    content = `${authTabs(mode)}${github}${config.email_enabled ? `<form id="email-login-form" class="auth-form" novalidate>
      <div class="field"><label class="required" for="auth-login-email">??</label><input id="auth-login-email" name="email" type="email" maxlength="254" autocomplete="email" required></div>
      <div class="field"><label class="required" for="auth-login-password">??</label><input id="auth-login-password" name="password" type="password" maxlength="1024" autocomplete="current-password" data-sensitive required></div>
      ${turnstileField()}<button class="button primary auth-button" type="submit">????</button>
      <button class="auth-link" type="button" data-auth-mode="forgot-password">?????</button>
    </form>` : emailUnavailable()}`;
  } else if (mode === "register") {
    content = `${authTabs(mode)}${github}${config.email_enabled ? `<form id="email-register-form" class="auth-form" novalidate>
      <div class="field"><label class="required" for="auth-register-name">????</label><input id="auth-register-name" name="display_name" maxlength="80" autocomplete="name" required></div>
      <div class="field"><label class="required" for="auth-register-email">??</label><input id="auth-register-email" name="email" type="email" maxlength="254" autocomplete="email" required></div>
      <div class="field"><label class="required" for="auth-register-password">??</label><input id="auth-register-password" name="password" type="password" minlength="12" maxlength="1024" autocomplete="new-password" data-sensitive required><p class="field-help">?? 12 ????</p></div>
      ${turnstileField()}<button class="button primary auth-button" type="submit">????</button>
    </form>` : emailUnavailable()}`;
  } else if (mode === "forgot-password") {
    content = `${config.email_enabled ? `<form id="forgot-password-form" class="auth-form" novalidate>
      <div class="auth-section-head"><h2>????</h2><p>??????????????????????</p></div>
      <div class="field"><label class="required" for="auth-forgot-email">??</label><input id="auth-forgot-email" name="email" type="email" maxlength="254" autocomplete="email" required></div>
      ${turnstileField()}<button class="button primary auth-button" type="submit">??????</button>
      <button class="auth-link" type="button" data-auth-mode="login">????</button>
    </form>` : emailUnavailable()}`;
  } else if (mode === "reset-password") {
    content = `${config.email_enabled ? `<form id="reset-password-form" class="auth-form" novalidate>
      <div class="auth-section-head"><h2>?????</h2><p>?????????????????</p></div>
      <div class="field"><label class="required" for="auth-reset-password">???</label><input id="auth-reset-password" name="password" type="password" minlength="12" maxlength="1024" autocomplete="new-password" data-sensitive required></div>
      <div class="field"><label class="required" for="auth-reset-confirm">?????</label><input id="auth-reset-confirm" name="password_confirm" type="password" minlength="12" maxlength="1024" autocomplete="new-password" data-sensitive required></div>
      ${turnstileField()}<button class="button primary auth-button" type="submit">????</button>
    </form>` : emailUnavailable()}`;
  } else {
    content = `<div class="auth-progress" aria-busy="true">???????</div>`;
  }
  authContent.innerHTML = content;
  queueMicrotask(mountTurnstile);
}

async function completeEmailVerification(token) {
  renderAuthGate("verify-email", "???????????");
  try {
    await api.verifyEmail(token);
    history.replaceState(null, "", "/#/login");
    renderAuthGate("login", "?????????????? ");
  } catch (error) {
    history.replaceState(null, "", "/#/login");
    renderAuthGate("login", errorMessage(error));
  }
}

function showLogin(message = "????????????????") {
  closeModal(false);
  closeDrawer();
  appShell.hidden = true;
  authGate.hidden = false;
  const { mode, query } = authLocation();
  if (mode === "verify-email") {
    const token = query.get("token") || "";
    if (token) completeEmailVerification(token);
    else renderAuthGate("login", "???????????");
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
    const login = identity.login || identity.email || identity.provider || "??";
    document.querySelector("#identity-name").textContent = identity.name || "??";
    document.querySelector("#identity-email").textContent = identity.provider === "github" ? `@${login}` : login;
    document.querySelector(".avatar").textContent = initials(login);
    authGate.hidden = true;
    appShell.hidden = false;
    return true;
  } catch {
    showLogin("?????????????????");
    return false;
  }
}

function runName(run) {
  return run.task_name || run.task?.name || run.task_snapshot?.name || "?????";
}

function accountName(item) {
  return item.account_name || item.account?.name || "?";
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
  if (!runs.length) return emptyState("?", "???????", "??????? Cron ?????????????");
  return `<div class="table-wrap"><table>
    <thead><tr><th>??</th>${compact ? "" : "<th>??</th>"}<th>??</th><th>??</th><th>??</th><th>??</th><th><span class="sr-only">??</span></th></tr></thead>
    <tbody>${runs.map((run) => `<tr>
      <td><span class="cell-title">${escapeHtml(runName(run))}</span><span class="cell-sub mono">${escapeHtml(shortId(run.id))}</span></td>
      ${compact ? "" : `<td>${escapeHtml(accountName(run))}</td>`}
      <td>${statusBadge(run.status)}</td>
      <td class="nowrap">${formatDate(run.started_at || run.created_at || run.scheduled_for)}</td>
      <td>${formatDuration(run.duration_ms)}</td>
      <td>${escapeHtml(run.attempt_count ?? run.retry_count ?? 0)}</td>
      <td><div class="actions"><button class="button small ghost" type="button" data-action="run-detail" data-id="${escapeHtml(run.id)}">??</button></div></td>
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
  setApiState("ok", "????");
  view.innerHTML = `${pageHead(`${identity.name || "??"}????`, `${workspace.accounts ?? 0} ? Telegram ?? ? ${workspace.tasks ?? 0} ??? ? ${workspace.all_runs ?? 0} ?????`, `<button class="button" type="button" data-action="refresh">? ??</button>`)}
    <section class="stats-grid" aria-label="????">
      <article class="stat-card"><div class="stat-label">????</div><div class="stat-value">${escapeHtml(today.total ?? 0)}</div><div class="stat-meta">???????</div></article>
      <article class="stat-card success"><div class="stat-label">??</div><div class="stat-value">${escapeHtml(today.success ?? today.succeeded ?? 0)}</div><div class="stat-meta">Telegram ????</div></article>
      <article class="stat-card failed"><div class="stat-label">??</div><div class="stat-value">${escapeHtml(today.failed ?? 0)}</div><div class="stat-meta">????????</div></article>
      <article class="stat-card running"><div class="stat-label">???</div><div class="stat-value">${escapeHtml(today.running ?? 0)}</div><div class="stat-meta">?????????</div></article>
    </section>
    <div class="dashboard-grid">
      <section class="card"><div class="card-head"><div><h2>????</h2><p>??????????</p></div><a class="button small ghost" href="#/runs">???? ?</a></div>${renderRunsTable(runs, { compact: true })}</section>
      <div class="stack">
        <section class="card"><div class="card-head"><div><h2>????</h2><p>Serverless ????</p></div></div><div class="card-body service-list">
          ${serviceRow("D1 ???", health.database ?? "ok", "???????")}
          ${serviceRow("GitHub Actions", health.github ?? "unknown", "Telegram Runner")}
          ${serviceRow("?????", health.scheduler ?? settings?.scheduler_mode ?? "legacy", (settings?.scheduler_mode ?? "legacy") === "d1" ? "D1 ????" : "Legacy ????")}
        </div></section>
        <section class="card"><div class="card-head"><div><h2>????</h2><p>????????</p></div></div><div class="card-body">${renderDashboardLogs(logs)}</div></section>
      </div>
    </div>
    <div class="dashboard-grid mt-md">
      <section class="card"><div class="card-head"><div><h2>????</h2><p>??????????</p></div><a class="button small ghost" href="#/tasks">???? ?</a></div><div class="card-body">${renderUpcomingTasks(upcoming)}</div></section>
      <section class="card"><div class="card-head"><div><h2>Telegram ????</h2><p>?????????</p></div><a class="button small ghost" href="#/accounts">???? ?</a></div><div class="card-body">${renderAccountHealth(accountHealth)}</div></section>
    </div>`;
}

function renderUpcomingTasks(tasks) {
  if (!tasks.length) return `<p class="field-help">??????????</p>`;
  return `<div class="service-list">${tasks.map((task) => `<div class="service-row"><div><strong>${escapeHtml(task.name)}</strong><small>${escapeHtml(task.account_name || "?")} ? ${escapeHtml(task.skill_key || "Skill")}</small></div><span class="nowrap">${formatDate(task.next_run_at)}</span></div>`).join("")}</div>`;
}

function renderAccountHealth(accounts) {
  if (!accounts.length) return `<p class="field-help">???? Telegram ???</p>`;
  return `<div class="service-list">${accounts.map((account) => `<div class="service-row"><div><strong>${escapeHtml(account.name)}</strong><small>${escapeHtml(account.phone_masked || "?")} ? ???? ${formatDate(account.last_connected_at)}</small></div>${statusBadge(account.status)}</div>`).join("")}</div>`;
}

function serviceRow(name, status, description) {
  const healthy = ["ok", "healthy", "d1"].includes(status);
  const label = healthy ? "??" : status === "legacy" ? "??" : status === "unknown" ? "???" : "??";
  const badge = healthy ? "success" : status === "legacy" || status === "unknown" ? "pending" : "error";
  return `<div class="service-row"><div><strong>${escapeHtml(name)}</strong><small>${escapeHtml(description)}</small></div><span class="badge ${badge}">${label}</span></div>`;
}

function renderDashboardLogs(logs) {
  if (!logs.length) return `<p class="field-help">?????</p>`;
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
  setApiState("ok", "????");
  const rows = filterRows(accounts, store.get().filters.accounts || {});
  view.innerHTML = `${pageHead("Telegram ??", "????????????????? Session ? API_HASH", `<button class="button primary" type="button" data-action="add-account">? ????</button>`)}
    <section class="card">
      <div class="toolbar"><div class="field search"><label for="account-search">??</label><input id="account-search" data-filter="account-query" type="search" placeholder="????????????" value="${escapeHtml(store.get().filters.accounts?.query || "")}"></div><div class="field"><label for="account-status">????</label><select id="account-status" data-filter="account-status"><option value="">????</option>${["connected","disconnected","login_pending","needs_reauth","error"].map((status) => `<option value="${status}" ${store.get().filters.accounts?.status === status ? "selected" : ""}>${statusText(status)}</option>`).join("")}</select></div></div>
      <div id="accounts-table">${renderAccountsTable(rows)}</div>
    </section>`;
}

function renderAccountsTable(accounts) {
  if (!accounts.length) return emptyState("?", "??? Telegram ??", "???????????? Session ?????", `<button class="button primary" type="button" data-action="add-account">????</button>`);
  return `<div class="table-wrap"><table><thead><tr><th>??</th><th>???</th><th>????</th><th>????</th><th>??</th><th><span class="sr-only">??</span></th></tr></thead><tbody>
    ${accounts.map((account) => `<tr><td><span class="cell-title">${escapeHtml(account.name)}</span><span class="cell-sub">${account.username ? `@${escapeHtml(String(account.username).replace(/^@/, ""))}` : "?? Telegram ????"}</span></td><td class="mono">${textOrDash(account.phone_masked || account.phone_hint)}</td><td>${statusBadge(account.status)}</td><td>${formatDate(account.last_checked_at || account.last_connected_at)}</td><td><label class="switch"><input type="checkbox" data-action="toggle-account" data-id="${escapeHtml(account.id)}" ${account.enabled ? "checked" : ""} aria-label="${account.enabled ? "??" : "??"}${escapeHtml(account.name)}"><span></span></label></td><td><div class="actions"><button class="button small" type="button" data-action="validate-account" data-id="${escapeHtml(account.id)}">??</button><button class="button small ghost" type="button" data-action="edit-account" data-id="${escapeHtml(account.id)}">??</button><button class="button small ghost danger" type="button" data-action="delete-account" data-id="${escapeHtml(account.id)}">??</button></div></td></tr>`).join("")}
  </tbody></table></div>`;
}

function proxyFields(values = {}) {
  const proxy = values.proxy || {};
  return `<details class="span-2"><summary class="field-label">??????</summary><div class="form-grid">
    <div class="field"><label for="proxy-scheme">??</label><select id="proxy-scheme" name="proxy_scheme"><option value="socks5" ${(proxy.protocol || proxy.scheme) === "socks5" ? "selected" : ""}>SOCKS5</option><option value="http" ${(proxy.protocol || proxy.scheme) === "http" ? "selected" : ""}>HTTP</option></select></div>
    <div class="field"><label for="proxy-host">??</label><input id="proxy-host" name="proxy_host" maxlength="255" autocomplete="off" value="${escapeHtml(proxy.host || "")}" placeholder="127.0.0.1"></div>
    <div class="field"><label for="proxy-port">??</label><input id="proxy-port" name="proxy_port" type="number" min="1" max="65535" inputmode="numeric" value="${escapeHtml(proxy.port || "")}" placeholder="1080"><div data-error-for="proxy_port"></div></div>
    <div class="field"><label for="proxy-username">???</label><input id="proxy-username" name="proxy_username" maxlength="128" autocomplete="off" value="${escapeHtml(proxy.username || "")}"></div>
    <div class="field span-2"><label for="proxy-password">??</label><input id="proxy-password" name="proxy_password" type="password" maxlength="512" autocomplete="new-password" data-sensitive><p class="field-help">?????????????????</p></div>
  </div></details>`;
}

function accountFields(mode, values = {}, errors = {}) {
  return `<div class="form-grid">
    ${mode === "import" ? `<div class="field span-2"><label class="required" for="account-name">??</label><input id="account-name" name="name" maxlength="80" autocomplete="off" value="${escapeHtml(values.name || "")}" placeholder="??????" ${invalidAttr(errors,"name")}>${fieldError(errors,"name")}</div>` : ""}
    <div class="field span-2"><label class="required" for="account-phone">???</label><input id="account-phone" name="phone" type="tel" maxlength="20" autocomplete="tel" data-sensitive value="" placeholder="+8613812345678" ${invalidAttr(errors,"phone")}>${fieldError(errors,"phone")}<p class="field-help">????/?????????????????????</p></div>
    ${mode === "import" ? `<div class="field span-2"><label class="required" for="account-session">Telegram Session</label><textarea id="account-session" name="session" maxlength="16384" autocomplete="off" data-sensitive placeholder="???? Session????????" ${invalidAttr(errors,"session")}></textarea>${fieldError(errors,"session")}</div>` : ""}
    ${proxyFields(values)}
  </div>`;
}

function openTelegramApplicationSetup(errors = {}) {
  openModal({
    title: "??? Telegram ??",
    description: "??????????????????????????????????",
    wide: true,
    body: `<div class="notice warning mb-md"><span aria-hidden="true">!</span><span><strong>????????</strong><br>Telegram ??????????? API_ID ? API_HASH??????? Session ??????????????</span></div>
      <ol class="setup-steps">
        <li>?? <a href="https://my.telegram.org/apps" target="_blank" rel="noopener noreferrer">Telegram API ????</a>??????? Telegram ?????</li>
        <li>????????? API_ID ? API_HASH?</li>
        <li>????????????? D1???????????</li>
      </ol>
      <form id="telegram-application-setup-form" novalidate>
        <div class="form-grid">
          <div class="field"><label class="required" for="setup-telegram-api-id">API_ID</label><input id="setup-telegram-api-id" name="telegram_api_id" type="password" inputmode="numeric" maxlength="12" autocomplete="new-password" data-sensitive value="" placeholder="???12345678" ${invalidAttr(errors, "telegram_api_id")}>${fieldError(errors, "telegram_api_id")}</div>
          <div class="field"><label class="required" for="setup-telegram-api-hash">API_HASH</label><input id="setup-telegram-api-hash" name="telegram_api_hash" type="password" maxlength="64" autocomplete="new-password" data-sensitive value="" placeholder="32 ????????" ${invalidAttr(errors, "telegram_api_hash")}>${fieldError(errors, "telegram_api_hash")}</div>
        </div>
      </form>`,
    footer: `<span class="field-help">???????????????????????</span><div><button class="button" type="button" data-action="close-modal">??</button><button class="button primary" type="submit" form="telegram-application-setup-form">?????</button></div>`,
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
  submit.textContent = "???????";
  try {
    await api.updateTelegramApplicationSettings(credentials);
    credentials.api_id = "";
    credentials.api_hash = "";
    const settingsPayload = await api.settings();
    store.set({ settings: settingsPayload?.values || settingsPayload || {} });
    toast("Telegram ??????", "??????????????");
    openAccountWizard();
  } catch (error) {
    credentials.api_id = "";
    credentials.api_hash = "";
    toast("?????", errorMessage(error), "error");
    submit.disabled = false;
    submit.textContent = "?????";
  }
}

function openAccountWizard(mode = "login", values = {}, errors = {}) {
  if (mode === "login" && needsTelegramApplicationSetup(store.get().settings)) {
    if (store.get().identity?.role === "admin") {
      openTelegramApplicationSetup();
    } else {
      openModal({
        title: "?????? Telegram ??",
        description: "?????????",
        body: `<div class="notice warning"><span aria-hidden="true">!</span><span>???????????? Telegram ??????????????????????</span></div>`,
        footer: `<span></span><button class="button" type="button" data-action="close-modal">??</button>`,
      });
    }
    return;
  }
  const isLogin = mode === "login";
  openModal({
    title: "?? Telegram ??",
    description: isLogin ? "? Telegram App ????????????????????" : "????????? Telegram Session",
    wide: true,
    body: `<div class="tabs" role="tablist" aria-label="????"><button type="button" role="tab" data-action="account-tab" data-mode="login" class="${isLogin ? "active" : ""}" aria-selected="${isLogin}">?????</button><button type="button" role="tab" data-action="account-tab" data-mode="import" class="${!isLogin ? "active" : ""}" aria-selected="${!isLogin}">?????? Session</button></div>
      ${isLogin ? `<div class="stepper" aria-label="????"><div class="step active"><b>1</b>?????</div><div class="step"><b>2</b>???</div><div class="step"><b>3</b>????</div><div class="step"><b>4</b>??</div></div><div class="notice mb-md"><span aria-hidden="true">i</span><span>Telegram ????????????????????????</span></div>` : `<div class="notice mb-md"><span aria-hidden="true">i</span><span>?????? GitHub Secrets ?? Session???????? GitHub Runner ?? Telegram ???????????????</span></div>`}
      <form id="account-form" data-mode="${mode}" novalidate>${accountFields(mode, values, errors)}</form>`,
    footer: `<span class="field-help">??????????</span><div><button class="button" type="button" data-action="close-modal">??</button><button class="button primary" type="submit" form="account-form">${isLogin ? "?????" : "????"}</button></div>`,
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
  submit.textContent = mode === "login" ? "?????" : "?????";
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
        toast("Session ?????", "???? Telegram ???");
        renderLoginFlow(flow?.login_flow || flow);
      } catch (validationError) {
        closeModal(false);
        toast("????????????", errorMessage(validationError), "error");
        await refreshRoute();
      }
    }
  } catch (error) {
    clearSensitive(form);
    payload.session = "";
    if (error instanceof ApiError && error.code === "telegram_application_not_configured") {
      payload.phone = "";
      openAccountWizard();
      return;
    }
    toast("??????", errorMessage(error), "error");
    submit.disabled = false;
    submit.textContent = mode === "login" ? "?????" : "????";
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
  return `<div class="stepper" aria-label="????">${["?????","???","????","??"].map((label,index) => `<div class="step ${index + 1 < current ? "done" : index + 1 === current ? "active" : ""}"><b>${index + 1 < current ? "?" : index + 1}</b>${label}</div>`).join("")}</div>`;
}

function renderLoginFlow(flow) {
  const id = flow?.id || flow?.login_flow_id;
  const status = flow?.status || "starting";
  const sessionValidation = flow?.mode === "session_validation";
  if (!id) {
    toast("??????", "??????? ID?", "error");
    return;
  }
  if (loginPollTimer) clearTimeout(loginPollTimer);
  let body = sessionValidation ? "" : loginStepper(status);
  let shouldPoll = false;
  let footer = `<span class="field-help">?? ID?${escapeHtml(shortId(id))}</span><div><button class="button" type="button" data-action="cancel-login" data-id="${escapeHtml(id)}">??</button></div>`;

  if (["created", "starting", "code_submitted", "password_submitted"].includes(status)) {
    if (status === "starting" && flow.last_error) {
      body += `<div class="notice warning mb-md"><span aria-hidden="true">!</span><span>${escapeHtml(flow.last_error)} ??????????Runner ???????????????</span></div>`;
    }
    body += `<div class="empty-state"><span class="skeleton w42"></span><h3>${escapeHtml(sessionValidation ? "???? Session" : statusText(status))}</h3><p>${sessionValidation ? "GitHub Runner ??? Telegram ?????? Session?" : "GitHub Login Runner ??????????????"}</p></div>`;
    shouldPoll = true;
  } else if (status === "code_required") {
    body += `${flow.last_error ? `<div class="notice warning mb-md"><span aria-hidden="true">!</span><span>${escapeHtml(flow.last_error)}</span></div>` : ""}<div class="notice mb-md"><span aria-hidden="true">i</span><span>???????? Telegram ????? App?Telegram ??????????????????????????????????????</span></div><form id="login-code-form" data-id="${escapeHtml(id)}"><div class="field"><label class="required" for="login-code">Telegram ???</label><input id="login-code" name="code" type="text" inputmode="numeric" maxlength="12" autocomplete="one-time-code" data-sensitive required placeholder="??????"></div></form>`;
    footer = `<span class="field-help">??????? Telegram ????</span><div><button class="button" type="button" data-action="resend-login" data-id="${escapeHtml(id)}">????</button><button class="button" type="button" data-action="cancel-login" data-id="${escapeHtml(id)}">??</button><button class="button primary" type="submit" form="login-code-form">??</button></div>`;
  } else if (status === "password_required") {
    body += `${flow.last_error ? `<div class="notice danger mb-md"><span aria-hidden="true">!</span><span>${escapeHtml(flow.last_error)}</span></div>` : ""}<div class="notice warning mb-md"><span aria-hidden="true">!</span><span>?????? Telegram ?????????????????????????</span></div><form id="login-password-form" data-id="${escapeHtml(id)}"><div class="field"><label class="required" for="login-password">??????</label><input id="login-password" name="password" type="password" maxlength="512" autocomplete="current-password" data-sensitive required></div></form>`;
    footer = `<span></span><div><button class="button" type="button" data-action="cancel-login" data-id="${escapeHtml(id)}">??</button><button class="button primary" type="submit" form="login-password-form">??</button></div>`;
  } else if (status === "connected") {
    body += `<div class="success-panel"><div class="success-check" aria-hidden="true">?</div><h3>?????</h3><p>${escapeHtml(flow.account_name || flow.name || "Telegram ??")} ?????????????????</p></div>`;
    footer = `<span></span><div><button class="button primary" type="button" data-action="finish-login">??</button></div>`;
  } else {
    body += `<div class="empty-state"><div class="empty-icon" aria-hidden="true">!</div><h3>${escapeHtml(statusText(status))}</h3><p>${escapeHtml(flow.error_message || flow.last_error || "??????????????")}</p></div>`;
    footer = `<span class="field-help">????${escapeHtml(flow.error_code || "LOGIN_FAILED")}</span><div><button class="button" type="button" data-action="close-modal">??</button>${sessionValidation ? `<button class="button primary" type="button" data-action="retry-account-validation" data-id="${escapeHtml(flow.account_id)}">????</button>` : `<button class="button primary" type="button" data-action="restart-login">????</button>`}</div>`;
  }

  openModal({
    title: "?? Telegram",
    description: sessionValidation ? "??? GitHub Runner ????? Session" : "??? GitHub Runner ?????????????",
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
    toast("????????", errorMessage(error), "error");
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
    toast("????", errorMessage(error), "error");
    button.disabled = false;
  }
}

function editAccountFields(account, errors = {}, options = {}) {
  return `<div class="form-grid">
    <div class="field span-2"><label class="required" for="edit-account-name">??</label><input id="edit-account-name" name="name" maxlength="80" autocomplete="off" value="${escapeHtml(account.name)}" ${invalidAttr(errors, "name")}>${fieldError(errors, "name")}</div>
    <label class="check-row span-2"><input type="checkbox" name="enabled" ${account.enabled ? "checked" : ""}>?????</label>
    <div class="notice span-2"><span aria-hidden="true">i</span><span>?????????????API_ID ? API_HASH ??????????????</span></div>
    <div class="field span-2"><label for="edit-account-phone">????????</label><input id="edit-account-phone" name="phone" type="tel" maxlength="20" autocomplete="off" data-sensitive value="" placeholder="??????? +8613812345678" ${invalidAttr(errors, "phone")}>${fieldError(errors, "phone")}</div>
    <div class="field span-2"><label for="edit-account-session">? Telegram Session????</label><textarea id="edit-account-session" name="session" maxlength="16384" autocomplete="off" data-sensitive placeholder="????????????" ${invalidAttr(errors, "session")}></textarea>${fieldError(errors, "session")}</div>
    <label class="check-row span-2"><input type="checkbox" name="clear_session" ${options.clearSession ? "checked" : ""}>?????? Session??????????</label>
    <details class="span-2" ${errors.proxy_protocol || errors.proxy_host || errors.proxy_port || errors.proxy_username || errors.proxy_password || options.clearProxy ? "open" : ""}><summary class="field-label">???????????</summary><div class="form-grid">
      <div class="notice span-2"><span aria-hidden="true">i</span><span>?????????????????????????????????</span></div>
      <div class="field"><label for="edit-proxy-protocol">??</label><select id="edit-proxy-protocol" name="proxy_protocol" ${invalidAttr(errors, "proxy_protocol")}><option value="socks5">SOCKS5</option><option value="socks5h">SOCKS5H</option><option value="socks4">SOCKS4</option><option value="http">HTTP</option><option value="https">HTTPS</option></select>${fieldError(errors, "proxy_protocol")}</div>
      <div class="field"><label for="edit-proxy-host">??</label><input id="edit-proxy-host" name="proxy_host" maxlength="253" autocomplete="off" data-sensitive value="" placeholder="????" ${invalidAttr(errors, "proxy_host")}>${fieldError(errors, "proxy_host")}</div>
      <div class="field"><label for="edit-proxy-port">??</label><input id="edit-proxy-port" name="proxy_port" type="password" inputmode="numeric" maxlength="5" autocomplete="new-password" data-sensitive value="" placeholder="?? 1080" ${invalidAttr(errors, "proxy_port")}>${fieldError(errors, "proxy_port")}</div>
      <div class="field"><label for="edit-proxy-username">???</label><input id="edit-proxy-username" name="proxy_username" maxlength="255" autocomplete="off" data-sensitive value="" placeholder="??" ${invalidAttr(errors, "proxy_username")}>${fieldError(errors, "proxy_username")}</div>
      <div class="field span-2"><label for="edit-proxy-password">??</label><input id="edit-proxy-password" name="proxy_password" type="password" maxlength="1024" autocomplete="new-password" data-sensitive value="" placeholder="??" ${invalidAttr(errors, "proxy_password")}>${fieldError(errors, "proxy_password")}</div>
      <label class="check-row span-2"><input type="checkbox" name="clear_proxy" ${options.clearProxy ? "checked" : ""}>????????</label>
    </div></details>
  </div>`;
}

function openEditAccount(account, errors = {}, options = {}) {
  openModal({
    title: "????",
    description: "????????????????????",
    wide: true,
    body: `<form id="edit-account-form" data-id="${escapeHtml(account.id)}" novalidate>${editAccountFields(account, errors, options)}</form>`,
    footer: `<span class="field-help">????????? PATCH ???</span><div><button class="button" type="button" data-action="close-modal">??</button><button class="button primary" type="submit" form="edit-account-form">??</button></div>`,
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
  button.textContent = "?????";
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
        toast("?????", "?????? Telegram ???");
        renderLoginFlow(flow?.login_flow || flow);
      } catch (validationError) {
        closeModal(false);
        toast("????????????", errorMessage(validationError), "error");
        await refreshRoute();
      }
    } else {
      closeModal(false);
      toast("?????");
      await refreshRoute();
    }
  } catch (error) {
    toast("????", errorMessage(error), "error");
    button.disabled = false;
    button.textContent = "??";
  }
}

async function renderTasks(token) {
  const [tasksPayload, accountsPayload, skillsPayload] = await Promise.all([api.tasks(), api.accounts(), api.skills()]);
  if (token !== renderToken) return;
  const tasks = listFrom(tasksPayload, ["tasks"]);
  const accounts = listFrom(accountsPayload, ["accounts"]);
  const skills = listFrom(skillsPayload, ["skills"]).map(normalizeSkill);
  store.set({ tasks, accounts, skills });
  setApiState("ok", "????");
  const rows = filterRows(tasks, store.get().filters.tasks || {});
  view.innerHTML = `${pageHead("????", "?? Runner ?? Skill?????????", `<button class="button primary" type="button" data-action="add-task" ${accounts.length && skills.length ? "" : "disabled"}>? ????</button>`)}
    ${!accounts.length ? `<div class="notice warning mb-sm"><span aria-hidden="true">!</span><span>???? Telegram ???????????</span></div>` : ""}
    <section class="card"><div class="toolbar"><div class="field search"><label for="task-search">??</label><input id="task-search" type="search" data-filter="task-query" placeholder="?????????" value="${escapeHtml(store.get().filters.tasks?.query || "")}"></div><div class="field"><label for="task-account-filter">??</label><select id="task-account-filter" data-filter="task-account"><option value="">????</option>${accounts.map((account) => `<option value="${escapeHtml(account.id)}" ${store.get().filters.tasks?.accountId === String(account.id) ? "selected" : ""}>${escapeHtml(account.name)}</option>`).join("")}</select></div></div><div id="tasks-table">${renderTasksTable(rows, accounts)}</div></section>`;
}

function renderTasksTable(tasks, accounts) {
  if (!tasks.length) return emptyState("?", "???????", "????? Skill?????????? Cron ?????", `<button class="button primary" type="button" data-action="add-task" ${accounts.length ? "" : "disabled"}>????</button>`);
  const names = new Map(accounts.map((account) => [String(account.id), account.name]));
  return `<div class="table-wrap"><table><thead><tr><th>??</th><th>?? / Skill</th><th>??? / ??</th><th>Cron</th><th>????</th><th>??</th><th><span class="sr-only">??</span></th></tr></thead><tbody>
    ${tasks.map((task) => `<tr><td><span class="cell-title">${escapeHtml(task.name)}</span><span class="cell-sub">?? ${escapeHtml(task.retry ?? task.retry_count ?? 0)} ? ? ?? ${escapeHtml(task.timeout_seconds ?? 120)} ?</span></td><td><span class="cell-title">${escapeHtml(task.account_name || names.get(String(task.account_id)) || "????")}</span><span class="cell-sub mono">${escapeHtml(task.skill_key || task.skill || "?")}</span></td><td><span class="cell-title mono">${escapeHtml(task.bot)}</span><span class="cell-sub">${escapeHtml(String(task.command || "").slice(0, 48))}${String(task.command || "").length > 48 ? "?" : ""}</span></td><td><span class="mono">${escapeHtml(task.cron || task.cron_expr)}</span><span class="cell-sub">${escapeHtml(task.timezone || "Asia/Shanghai")}</span></td><td>${formatDate(task.next_run_at)}</td><td><label class="switch"><input type="checkbox" data-action="toggle-task" data-id="${escapeHtml(task.id)}" ${task.enabled ? "checked" : ""} aria-label="${task.enabled ? "??" : "??"}${escapeHtml(task.name)}"><span></span></label></td><td><div class="actions"><button class="button small" type="button" data-action="run-task" data-id="${escapeHtml(task.id)}">??</button><button class="button small ghost" type="button" data-action="edit-task" data-id="${escapeHtml(task.id)}">??</button><button class="button small ghost danger" type="button" data-action="delete-task" data-id="${escapeHtml(task.id)}">??</button></div></td></tr>`).join("")}
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
    <div class="field span-2"><label class="required" for="task-name">????</label><input id="task-name" name="name" maxlength="100" value="${escapeHtml(values.name)}" placeholder="???????" ${invalidAttr(errors,"name")}>${fieldError(errors,"name")}</div>
    <div class="field"><label class="required" for="task-account">??</label><select id="task-account" name="account_id" ${invalidAttr(errors,"account_id")}><option value="">???</option>${accounts.map((account) => `<option value="${escapeHtml(account.id)}" ${String(values.account_id) === String(account.id) ? "selected" : ""}>${escapeHtml(account.name)}${account.status !== "connected" ? `?${statusText(account.status)}?` : ""}</option>`).join("")}</select>${fieldError(errors,"account_id")}</div>
    <div class="field"><label class="required" for="task-skill">Skill</label><select id="task-skill" name="skill_key" ${invalidAttr(errors,"skill_key")}>${skills.map((skill) => `<option value="${escapeHtml(skill.key)}" ${String(values.skill_key) === String(skill.key) ? "selected" : ""} ${skill.enabled === false ? "disabled" : ""}>${escapeHtml(skill.name || skill.key)}${skill.enabled === false ? "?????" : ""}</option>`).join("")}</select>${fieldError(errors,"skill_key")}</div>
    <div class="field span-2"><label class="required" for="task-bot">Bot / Chat</label><input id="task-bot" name="bot" maxlength="128" value="${escapeHtml(values.bot)}" placeholder="@example_bot ? Chat ID" ${invalidAttr(errors,"bot")}>${fieldError(errors,"bot")}</div>
    <div class="field span-2"><label class="required" for="task-command">Command</label><textarea id="task-command" name="command" maxlength="2000" ${invalidAttr(errors,"command")}>${escapeHtml(values.command)}</textarea>${fieldError(errors,"command")}</div>
    <div class="field span-2"><label for="task-signer-import">tg_signer ?? <small>${values.has_tg_signer_import ? "????????????" : "? tg_signer Skill ??"}</small></label><textarea id="task-signer-import" name="tg_signer_import" maxlength="131072" autocomplete="off" data-sensitive placeholder="?? tg-signer ?? JSON ? Base64????????" ${invalidAttr(errors,"tg_signer_import")}></textarea>${fieldError(errors,"tg_signer_import")}</div>
    <div class="field"><label class="required" for="task-cron">Cron</label><input id="task-cron" class="mono" name="cron" maxlength="96" value="${escapeHtml(values.cron)}" placeholder="0 0 * * *" ${invalidAttr(errors,"cron")}>${fieldError(errors,"cron")}<p class="field-help">?? 5 ??? ? ? ? ??</p></div>
    <div class="field"><label class="required" for="task-timezone">??</label><select id="task-timezone" name="timezone" ${invalidAttr(errors,"timezone")}>${["Asia/Shanghai","Asia/Hong_Kong","Asia/Tokyo","UTC","America/Los_Angeles"].map((zone) => `<option value="${zone}" ${values.timezone === zone ? "selected" : ""}>${zone}</option>`).join("")}</select>${fieldError(errors,"timezone")}</div>
    <div class="field"><label for="task-retry">Retry <small>????</small></label><input id="task-retry" name="retry" type="number" min="0" max="5" value="${escapeHtml(values.retry)}" ${invalidAttr(errors,"retry")}>${fieldError(errors,"retry")}</div>
    <div class="field"><label for="task-timeout">Timeout <small>?</small></label><input id="task-timeout" name="timeout_seconds" type="number" min="10" max="900" value="${escapeHtml(values.timeout_seconds)}" ${invalidAttr(errors,"timeout_seconds")}>${fieldError(errors,"timeout_seconds")}</div>
    <div class="field"><label for="task-thread">Thread ID <small>??</small></label><input id="task-thread" name="thread_id" type="number" min="1" value="${escapeHtml(values.thread_id)}" ${invalidAttr(errors,"thread_id")}>${fieldError(errors,"thread_id")}</div>
    <div class="field"><label for="task-delete-after">Delete After <small>????</small></label><input id="task-delete-after" name="delete_after_seconds" type="number" min="0" max="86400" value="${escapeHtml(values.delete_after_seconds)}" ${invalidAttr(errors,"delete_after_seconds")}>${fieldError(errors,"delete_after_seconds")}</div>
    <div class="field span-2"><label class="check-row"><input type="checkbox" name="enabled" ${values.enabled ? "checked" : ""}>???????</label></div>
  </div></form>
  <section><h3 class="section-title">?? 5 ?????</h3><div id="cron-preview" class="notice">?????</div></section>`;
}

function openTaskModal(task = null, errors = {}, attempted = null) {
  const values = { ...taskFormValues(task || {}), ...(attempted || {}), id: task?.id || "" };
  openModal({
    title: task ? "??????" : "??????",
    description: "??????? Runner ??",
    wide: true,
    body: taskFormHtml(values, errors),
    footer: `<span class="field-help">?????????????</span><div><button class="button" type="button" data-action="close-modal">??</button><button class="button primary" type="submit" form="task-form">????</button></div>`,
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
    target.textContent = "Cron ?????? 45 ?????????";
    return;
  }
  target.className = "notice";
  target.innerHTML = `<span aria-hidden="true">?</span><span>${occurrences.map((date) => escapeHtml(new Intl.DateTimeFormat("zh-CN", { timeZone: String(values.get("timezone")), month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date))).join("???")}</span>`;
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
  button.textContent = "?????";
  try {
    if (id) await api.updateTask(id, values);
    else await api.createTask(values);
    closeModal(false);
    toast(id ? "?????" : "?????");
    await refreshRoute();
  } catch (error) {
    toast("????", errorMessage(error), "error");
    button.disabled = false;
    button.textContent = "????";
  }
}

async function renderSkills(token) {
  const payload = await api.skills();
  if (token !== renderToken) return;
  const skills = listFrom(payload, ["skills"]).map(normalizeSkill);
  store.set({ skills });
  setApiState("ok", "????");
  view.innerHTML = `${pageHead("Skills", "Skill Registry ?????????????????")}
    <div class="notice mb-md"><span aria-hidden="true">i</span><span>?????? Python ????? Shell??? Skill ?????????????????</span></div>
    <section class="skill-grid">${skills.length ? skills.map(renderSkillCard).join("") : `<div class="card grid-all">${emptyState("?", "Skill Registry ??", "???? D1 migration ????? Skills?")}</div>`}</section>`;
}

function renderSkillCard(skill) {
  const params = skill.params_schema || skill.params_schema_json;
  const fieldCount = params?.properties ? Object.keys(params.properties).length : Array.isArray(params) ? params.length : 0;
  return `<article class="skill-card"><div class="skill-card-head"><div><div class="skill-icon" aria-hidden="true">${skill.key === "send_text" ? "T" : "S"}</div><h2>${escapeHtml(skill.name || skill.key)}</h2></div><span class="badge ${skill.enabled ? "enabled" : "disabled"}">${skill.enabled ? "???" : "???"}</span></div><p>${escapeHtml(skill.description || (skill.key === "send_text" ? "??????????? Thread ??????" : "?? tg-signer ????????????"))}</p><div class="skill-meta"><span>Registry Key<strong class="mono">${escapeHtml(skill.key)}</strong></span><span>????<strong>${escapeHtml(skill.implementation_version || skill.version || "1")}</strong></span><span>Schema<strong>v${escapeHtml(skill.schema_version || 1)}</strong></span><span>??<strong>${escapeHtml(fieldCount)} ???</strong></span></div></article>`;
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
  setApiState("ok", "????");
  view.innerHTML = `${pageHead("????", "??????????????????", `<button class="button" type="button" data-action="refresh">? ??</button>`)}
    <section class="card"><div class="toolbar"><div class="field"><label for="run-status">??</label><select id="run-status" data-filter="run-status"><option value="">????</option>${["queued","claimed","running","success","failed","ambiguous","cancelled"].map((status) => `<option value="${status}" ${filters.status === status ? "selected" : ""}>${statusText(status)}</option>`).join("")}</select></div><div class="field"><label for="run-task">??</label><select id="run-task" data-filter="run-task"><option value="">????</option>${tasks.map((task) => `<option value="${escapeHtml(task.id)}" ${String(filters.taskId || "") === String(task.id) ? "selected" : ""}>${escapeHtml(task.name)}</option>`).join("")}</select></div></div>${renderRunsTable(runs)}</section>`;
}

async function showRunDetail(id) {
  openDrawer({ title: "????", description: `Run ${shortId(id)}`, body: `<div class="loading-card" aria-busy="true"><span class="skeleton w55"></span><span class="skeleton w90"></span><span class="skeleton w75"></span></div>` });
  try {
    const detailPayload = await api.taskRun(id);
    if (!drawerRoot.firstElementChild) return;
    const run = detailPayload?.run || detailPayload;
    const attempts = listFrom(run?.attempts || detailPayload?.attempts, ["attempts"]);
    const logs = listFrom(run?.logs || detailPayload?.logs, ["logs"]);
    const githubUrl = safeUrl(run.github_run_url || run.github_url);
    drawerRoot.querySelector(".drawer-body").innerHTML = `<div class="run-summary">
      <div class="summary-item"><span>??</span><strong>${statusBadge(run.status)}</strong></div>
      <div class="summary-item"><span>????</span><strong>${escapeHtml(run.trigger || run.trigger_type || "?")}</strong></div>
      <div class="summary-item"><span>???</span><strong>${formatDuration(run.duration_ms)}</strong></div>
      <div class="summary-item"><span>??</span><strong>${escapeHtml(runName(run))}</strong></div>
      <div class="summary-item"><span>??</span><strong>${escapeHtml(accountName(run))}</strong></div>
      <div class="summary-item"><span>????</span><strong>${formatDate(run.started_at || run.created_at)}</strong></div>
    </div>
    ${run.error_code || run.error_message ? `<div class="notice danger"><span aria-hidden="true">!</span><span><strong>${escapeHtml(run.error_code || "TASK_FAILED")}</strong><br>${escapeHtml(run.error_message || "???????")}</span></div>` : ""}
    ${githubUrl ? `<p><a class="button small" href="${escapeHtml(githubUrl)}" target="_blank" rel="noopener noreferrer">?? GitHub Actions ?</a></p>` : ""}
    <h3 class="section-title">????</h3>${attempts.length ? attempts.map((attempt,index) => `<div class="attempt"><div class="attempt-no">${escapeHtml(attempt.attempt_no || index + 1)}</div><div><strong>${escapeHtml(statusText(attempt.status))}</strong><p>${escapeHtml(attempt.error_message || attempt.message || "???????")}</p></div><span class="cell-sub">${formatDuration(attempt.duration_ms)}</span></div>`).join("") : `<p class="field-help">?????????</p>`}
    <h3 class="section-title">????</h3>${renderRunLogs(logs)}
    <p class="field-help mt-md">???? Worker ???????????????</p>`;
  } catch (error) {
    drawerRoot.querySelector(".drawer-body").innerHTML = emptyState("!", "????????", errorMessage(error), `<button class="button" type="button" data-action="close-drawer">??</button>`);
  }
}

function renderRunLogs(logs) {
  if (!logs.length) return `<div class="notice"><span aria-hidden="true">i</span><span>??????????</span></div>`;
  return `<div class="log-list">${logs.map((log) => {
    const item = typeof log === "string" ? { message: log } : log;
    return `<div class="log-line"><span class="log-level ${item.level === "error" ? "error" : ""}">${escapeHtml(String(item.level || "info").toUpperCase())}</span><span>${escapeHtml(item.message || item.text || "")}</span><span class="log-time">${formatDate(item.created_at || item.timestamp)}</span></div>`;
  }).join("")}</div>`;
}

async function renderSessions(token) {
  const sessions = await api.sessions();
  if (token !== renderToken) return;
  setApiState("ok", "????");
  const rowsHtml = sessions.length ? `<div class="table-wrap"><table><thead><tr><th>??</th><th>????</th><th>????</th><th>????</th><th><span class="sr-only">??</span></th></tr></thead><tbody>
    ${sessions.map((session) => `<tr><td><span class="cell-title">${escapeHtml(session.user_agent_label || "?????")}</span>${session.current ? '<span class="badge success">????</span>' : ""}</td><td>${escapeHtml(session.provider === "email" ? "??" : "GitHub")}</td><td>${formatDate(session.created_at)}</td><td>${formatDate(session.expires_at)}</td><td>${session.current ? "?" : `<button class="button small ghost danger" type="button" data-action="revoke-session" data-id="${escapeHtml(session.id)}">??</button>`}</td></tr>`).join("")}
  </tbody></table></div>` : emptyState("?", "??????", "?????????????????");
  view.innerHTML = `${pageHead("????", "?????????????????", `<button class="button" type="button" data-action="refresh">? ??</button>`)}
    <section class="card">${rowsHtml}</section>`;
}

async function renderSettings(token) {
  const identity = store.get().identity || {};
  if (identity.role !== "admin") {
    if (token !== renderToken) return;
    setApiState("ok", "????");
    view.innerHTML = `${pageHead("??", "?????????")}
      <div class="settings-layout"><section class="card"><div class="settings-section"><h2>????</h2><p>?????${escapeHtml(identity.name || "??")}</p><p>?????${escapeHtml(identity.provider === "email" ? "??" : "GitHub")}</p><p>???${escapeHtml(identity.email || identity.login || "?")}</p></div></section>
      <aside class="stack"><section class="card"><div class="card-head"><h2>????</h2></div><div class="card-body"><a class="button" href="#/sessions">??????</a></div></section></aside></div>`;
    return;
  }
  const payload = await api.settings();
  if (token !== renderToken) return;
  const settings = payload?.values || payload || {};
  store.set({ settings });
  setApiState("ok", "????");
  const telegramApplicationStatus = settings.telegram_application_source === "global"
    ? '<span class="badge success">?????</span>'
    : settings.telegram_application_source === "legacy_account"
      ? '<span class="badge success">????????</span>'
      : '<span class="badge pending">????</span>';
  view.innerHTML = `${pageHead("??", "??????????????")}
    <div class="settings-layout"><section class="card"><form id="settings-form" novalidate>
      <div class="settings-section"><h2>?????</h2><p>???????????????</p><div class="form-grid">
        <div class="field"><label for="default-timezone">????</label><select id="default-timezone" name="default_timezone">${["Asia/Shanghai","Asia/Hong_Kong","Asia/Tokyo","UTC","America/Los_Angeles"].map((zone) => `<option value="${zone}" ${(settings.default_timezone || "Asia/Shanghai") === zone ? "selected" : ""}>${zone}</option>`).join("")}</select></div>
        <div class="field"><label for="scheduler-mode">Scheduler Mode</label><select id="scheduler-mode" name="scheduler_mode"><option value="legacy" ${settings.scheduler_mode !== "d1" ? "selected" : ""}>legacy ? ??? Cron</option><option value="d1" ${settings.scheduler_mode === "d1" ? "selected" : ""}>d1 ? ??????</option></select><p class="field-help">??? d1 ??????? canary ???????? legacy?</p></div>
      </div></div>
      <div class="settings-section"><h2>Telegram ??</h2><p>???????? Telegram ??????????????????????${telegramApplicationStatus}</p>
        <div class="form-grid">
          <div class="field"><label for="telegram-api-id">? API_ID????</label><input id="telegram-api-id" name="telegram_api_id" type="password" inputmode="numeric" maxlength="12" autocomplete="new-password" data-sensitive value="" placeholder="????????"></div>
          <div class="field"><label for="telegram-api-hash">? API_HASH????</label><input id="telegram-api-hash" name="telegram_api_hash" type="password" maxlength="64" autocomplete="new-password" data-sensitive value="" placeholder="????????"></div>
        </div>
        <div class="notice mt-md"><span aria-hidden="true">i</span><span>${settings.telegram_application_source === "legacy_account" ? "?????????????????????????" : "???????????????????? D1 ??????"}</span></div>
      </div>
      <div class="settings-section"><h2>??</h2><p>??????? Telegram Bot ?????GitHub Actions ????????????????????????????</p>
        <label class="check-row"><input type="checkbox" name="notifications_enabled" ${settings.notifications_enabled ? "checked" : ""}>?????????</label>
        <div class="form-grid">
          <div class="field"><label for="notification-bot-token">? Bot Token????</label><input id="notification-bot-token" name="notification_bot_token" type="password" maxlength="256" autocomplete="new-password" data-sensitive value="" placeholder="????"><p class="field-help">???${settings.notification_bot_token_configured ? '<span class="badge success">???</span>' : '<span class="badge pending">???</span>'}</p></div>
          <div class="field"><label for="notification-chat-id">? Chat ID????</label><input id="notification-chat-id" name="notification_chat_id" type="password" maxlength="33" autocomplete="new-password" data-sensitive value="" placeholder="?????????? @??"><p class="field-help">???${settings.notification_chat_id_configured ? '<span class="badge success">???</span>' : '<span class="badge pending">???</span>'}</p></div>
          <label class="check-row"><input type="checkbox" name="clear_notification_bot_token">?????? Bot Token</label>
          <label class="check-row"><input type="checkbox" name="clear_notification_chat_id">?????? Chat ID</label>
        </div>
        <div class="notice mt-md"><span aria-hidden="true">i</span><span>Token ? Chat ID ???? API ???? D1???????????????????</span></div>
      </div>
      <div class="settings-section"><button class="button primary" type="submit">????</button></div>
    </form></section>
    <aside class="stack"><section class="card"><div class="card-head"><h2>????</h2></div><div class="card-body service-list">${serviceRow("?????", "ok", "GitHub OAuth")}${serviceRow("????", "ok", "AES-256-GCM")}${serviceRow("Runner ??", "ok", "GitHub OIDC")}</div></section><div class="notice warning"><span aria-hidden="true">!</span><span><strong>??????</strong><br>?? legacy ? d1 ???????????????</span></div></aside></div>`;
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
    toast("?????", Object.values(errors)[0], "error");
    return;
  }
  const notificationPatch = buildNotificationSettingsPatch(submission.notificationInput, submission.notificationOptions);
  submission.notificationInput.bot_token = "";
  submission.notificationInput.chat_id = "";
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  button.textContent = "?????";
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
    toast("?????");
    await refreshRoute();
  } catch (error) {
    toast("????", errorMessage(error), "error");
    button.disabled = false;
    button.textContent = "????";
  }
}

async function refreshRoute() {
  const route = routeFromHash(location.hash);
  store.set({ route });
  const token = ++renderToken;
  const [title, description] = routeMeta[route];
  document.title = `${title} ? Telegram ????`;
  document.querySelector("#breadcrumb").textContent = title;
  document.querySelectorAll("[data-route]").forEach((link) => link.classList.toggle("active", link.dataset.route === route));
  view.innerHTML = loadingPage(title, description);
  setApiState("loading", "???");
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
    toast("????", errorMessage(error), "error");
  } finally {
    input.disabled = false;
  }
}

function confirmDeleteAccount(account) {
  openModal({
    title: "???????",
    description: account.name,
    body: `<div class="notice danger"><span aria-hidden="true">!</span><span>???? D1 ?????????????????????????????????????<strong>??</strong>?? Telegram ?? Session?</span></div>`,
    footer: `<span class="field-help">?????????? Telegram ???????????? Session</span><div><button class="button" type="button" data-action="close-modal">??</button><button class="button danger" type="button" data-action="confirm-delete-account" data-id="${escapeHtml(account.id)}">??????</button></div>`,
  });
}

function confirmDeleteTask(task) {
  openModal({
    title: "???????",
    description: task.name,
    body: `<p>??????????????????????Skill?Bot?Command?Cron ???????????????????????</p>`,
    footer: `<span></span><div><button class="button" type="button" data-action="close-modal">??</button><button class="button danger" type="button" data-action="confirm-delete-task" data-id="${escapeHtml(task.id)}">????</button></div>`,
  });
}

function confirmRunTask(task) {
  openModal({
    title: "???????",
    description: task.name,
    body: `<div class="notice warning"><span aria-hidden="true">!</span><span>????? GitHub Actions ? <strong>${escapeHtml(task.bot)}</strong> ???????????????????????????????????</span></div>`,
    footer: `<span class="field-help">???${escapeHtml(task.account_name || "?????")}</span><div><button class="button" type="button" data-action="close-modal">??</button><button class="button primary" type="button" data-action="confirm-run-task" data-id="${escapeHtml(task.id)}">????</button></div>`,
  });
}

async function submitAuthForm(form) {
  const data = new FormData(form);
  const button = form.querySelector('button[type="submit"]');
  const turnstileToken = String(data.get("turnstile_token") || "");
  button.disabled = true;
  button.textContent = "?????";
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
      history.replaceState(null, "", "/#/login");
      renderAuthGate("login", "??????????????????? ");
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
      renderAuthGate("login", "?????????????????? ");
      return;
    }
    if (form.id === "reset-password-form") {
      const password = String(data.get("password") || "");
      const confirmation = String(data.get("password_confirm") || "");
      if (password !== confirmation) throw new ApiError("???????????", { code: "PASSWORD_MISMATCH" });
      const token = authLocation().query.get("token") || "";
      const payload = { token, password, turnstile_token: turnstileToken };
      const operation = api.resetPassword(payload);
      clearSensitive(form);
      payload.password = "";
      payload.token = "";
      payload.turnstile_token = "";
      await operation;
      history.replaceState(null, "", "/#/login");
      renderAuthGate("login", "??????????????? ");
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
    try { await api.revokeSession(id); toast("???????"); return refreshRoute(); }
    catch (error) { target.disabled = false; return toast("????", errorMessage(error), "error"); }
  }
  if (action === "validate-account") {
    target.disabled = true;
    try { return renderLoginFlow(await api.validateAccount(id)); }
    catch (error) { target.disabled = false; return toast("??????", errorMessage(error), "error"); }
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
    await withToggle(input, () => api.updateAccount(account.id, { enabled: input.checked }), input.checked ? "?????" : "?????");
  }
  if (input.matches('[data-action="toggle-task"]')) {
    const task = store.get().tasks.find((item) => String(item.id) === input.dataset.id);
    await withToggle(input, () => api.updateTask(task.id, { enabled: input.checked }), input.checked ? "?????" : "?????");
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
    catch (error) { actionTarget.disabled = false; return toast("??????", errorMessage(error), "error"); }
  }
  if (action === "resend-login") {
    actionTarget.disabled = true;
    try {
      const flow = await api.resendLoginCode(id);
      toast("???????", "??? Telegram ????");
      return renderLoginFlow(flow?.login_flow || flow);
    } catch (error) {
      actionTarget.disabled = false;
      return toast("??????", errorMessage(error), "error");
    }
  }
  if (action === "finish-login") { closeModal(false); toast("Telegram ?????"); return refreshRoute(); }
  if (action === "cancel-login") {
    actionTarget.disabled = true;
    try { await api.cancelLoginFlow(id); } catch { /* The flow may already be terminal. */ }
    closeModal(false);
    toast("???????");
  }
  if (action === "confirm-delete-account") {
    actionTarget.disabled = true;
    try { await api.deleteAccount(id); closeModal(false); toast("???????"); await refreshRoute(); }
    catch (error) { toast("????", errorMessage(error), "error"); actionTarget.disabled = false; }
  }
  if (action === "confirm-delete-task") {
    actionTarget.disabled = true;
    try { await api.deleteTask(id); closeModal(false); toast("?????"); await refreshRoute(); }
    catch (error) { toast("????", errorMessage(error), "error"); actionTarget.disabled = false; }
  }
  if (action === "confirm-run-task") {
    actionTarget.disabled = true;
    actionTarget.textContent = "?????";
    try {
      const run = await api.runTask(id);
      closeModal(false);
      toast("???????", `Run ${shortId(run?.id || run?.run_id)}`);
      location.hash = "#/runs";
    } catch (error) {
      toast("??????", errorMessage(error), "error");
      actionTarget.disabled = false;
      actionTarget.textContent = "????";
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
    toast("????", errorMessage(error), "error");
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
