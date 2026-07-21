const HEALTH_ROUTE = "#/users";
const MAX_BATCH = 20;

let accountsCache = [];
let healthLoading = false;
let healthLoaded = false;

function isAdministrator() {
  const marker = document.querySelector("[data-admin-only]");
  return Boolean(marker && !marker.hidden);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-CN", { hour12: false });
}

function notify(title, message = "", kind = "success") {
  const region = document.querySelector("#toast-region");
  if (!region) return;
  const element = document.createElement("div");
  element.className = `toast ${kind === "error" ? "error" : ""}`;
  element.innerHTML = `<span aria-hidden="true">${kind === "error" ? "!" : "✓"}</span><div><strong>${escapeHtml(title)}</strong>${message ? `<p>${escapeHtml(message)}</p>` : ""}</div>`;
  region.append(element);
  setTimeout(() => element.remove(), 5600);
}

async function request(path, { method = "GET", body } = {}) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(method === "GET" || method === "HEAD" ? {} : { "x-requested-with": "tg-checkin-admin" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `请求失败（HTTP ${response.status}）`);
    error.code = payload?.error?.code;
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function fetchAllAccounts() {
  const items = [];
  let cursor = "0";
  const seen = new Set();
  do {
    if (seen.has(cursor)) throw new Error("账号健康中心返回了重复分页游标。");
    seen.add(cursor);
    const payload = await request(`/api/v1/admin/account-health?limit=100&cursor=${encodeURIComponent(cursor)}`);
    if (!Array.isArray(payload?.data)) throw new Error("账号健康中心返回了无效数据。");
    items.push(...payload.data);
    cursor = payload.pagination?.next_cursor || null;
    if (items.length >= 1000) break;
  } while (cursor !== null);
  return items;
}

function statusMeta(status) {
  return ({
    connected: { label: "已连接", badge: "success" },
    login_pending: { label: "连接中", badge: "pending" },
    disconnected: { label: "未连接", badge: "pending" },
    error: { label: "异常", badge: "error" },
  })[status] || { label: status || "未知", badge: "pending" };
}

function validationActive(account) {
  return ["created", "starting", "code_submitted", "password_submitted"].includes(account.validation_status);
}

function filteredAccounts(section) {
  const search = String(section.querySelector("[data-health-search]")?.value || "").trim().toLowerCase();
  const status = String(section.querySelector("[data-health-status]")?.value || "");
  return accountsCache.filter((account) => {
    if (status && account.status !== status) return false;
    if (!search) return true;
    return [
      account.owner_display_name,
      account.owner_login,
      account.account_name,
      account.phone_masked,
      account.telegram_username,
      account.telegram_display_name,
      account.last_error,
      account.validation_error,
    ].some((value) => String(value || "").toLowerCase().includes(search));
  });
}

function accountRows(accounts) {
  if (!accounts.length) {
    return '<tr><td colspan="8"><div class="empty-state"><div class="empty-icon" aria-hidden="true">◎</div><h3>没有符合条件的账号</h3><p>调整搜索条件或刷新账号列表。</p></div></td></tr>';
  }
  return accounts.map((account) => {
    const state = statusMeta(account.status);
    const active = validationActive(account);
    const disabledReason = !account.session_configured
      ? "尚未保存 Session"
      : active ? "检测进行中" : "";
    const error = account.last_error || account.validation_error || "—";
    const telegramIdentity = account.telegram_username
      ? `@${account.telegram_username}`
      : account.telegram_display_name || "—";
    return `<tr data-health-account-row data-account-id="${escapeHtml(account.id)}">
      <td data-label="选择"><input type="checkbox" data-health-select value="${escapeHtml(account.id)}" ${disabledReason ? "disabled" : ""} aria-label="选择 ${escapeHtml(account.account_name)}"></td>
      <td data-label="用户"><span class="cell-title">${escapeHtml(account.owner_display_name)}</span><span class="cell-sub">${escapeHtml(account.owner_login)}${account.owner_status === "disabled" ? " · 用户已停用" : ""}</span></td>
      <td data-label="Telegram 账号"><span class="cell-title">${escapeHtml(account.account_name)}</span><span class="cell-sub">${escapeHtml(account.phone_masked || "—")} · ${escapeHtml(telegramIdentity)}</span></td>
      <td data-label="状态"><span class="badge ${state.badge}">${escapeHtml(state.label)}</span>${account.enabled ? "" : '<span class="cell-sub">账号已停用</span>'}</td>
      <td data-label="最近检测"><span class="cell-title">${escapeHtml(formatDate(account.last_checked_at || account.validation_started_at))}</span><span class="cell-sub">最近连接：${escapeHtml(formatDate(account.last_connected_at))}</span></td>
      <td data-label="错误"><span class="cell-sub" title="${escapeHtml(error)}">${escapeHtml(error.length > 90 ? `${error.slice(0, 90)}…` : error)}</span></td>
      <td data-label="凭据"><span class="badge ${account.session_configured ? "success" : "pending"}">${account.session_configured ? "Session 已保存" : "缺少 Session"}</span></td>
      <td data-label="操作"><button class="button small" type="button" data-health-action="validate-one" data-id="${escapeHtml(account.id)}" ${disabledReason ? `disabled title="${escapeHtml(disabledReason)}"` : ""}>${active ? "检测中" : "检测"}</button></td>
    </tr>`;
  }).join("");
}

function statsMarkup(accounts) {
  const connected = accounts.filter((item) => item.status === "connected").length;
  const errors = accounts.filter((item) => item.status === "error").length;
  const unchecked = accounts.filter((item) => !item.last_checked_at).length;
  return `<div class="stats-grid mb-md">
    <section class="stat-card"><span class="stat-label">平台账号</span><strong>${accounts.length}</strong><small>只显示脱敏信息</small></section>
    <section class="stat-card"><span class="stat-label">已连接</span><strong>${connected}</strong><small>可正常执行任务</small></section>
    <section class="stat-card"><span class="stat-label">异常</span><strong>${errors}</strong><small>建议优先处理</small></section>
    <section class="stat-card"><span class="stat-label">尚未检测</span><strong>${unchecked}</strong><small>可代用户发起检查</small></section>
  </div>`;
}

function healthBody(section) {
  const visible = filteredAccounts(section);
  const tbody = section.querySelector("[data-health-table-body]");
  if (tbody) tbody.innerHTML = accountRows(visible);
  const count = section.querySelector("[data-health-visible-count]");
  if (count) count.textContent = `当前显示 ${visible.length} / ${accountsCache.length} 个账号`;
}

function healthSectionMarkup(accounts) {
  return `<div class="card-head"><div><h2>全平台账号健康中心</h2><p>帮助不会排查的用户确认 Session、Telegram API 和代理连接；不会显示或导出任何秘密凭据。</p></div><button class="button small ghost" type="button" data-health-action="refresh">刷新</button></div>
    <div class="card-body">
      ${statsMarkup(accounts)}
      <div class="notice mb-md"><span aria-hidden="true">i</span><span>检测只建立一次安全验证连接，不发送业务消息。账号仍由原用户所有，管理员不能查看 Session、验证码、二步验证密码或代理密码。</span></div>
      <div class="toolbar">
        <div class="field"><label for="platform-health-search">搜索</label><input id="platform-health-search" data-health-search type="search" placeholder="用户、账号、脱敏手机号或错误"></div>
        <div class="field"><label for="platform-health-status">状态</label><select id="platform-health-status" data-health-status><option value="">全部状态</option><option value="error">异常</option><option value="disconnected">未连接</option><option value="login_pending">连接中</option><option value="connected">已连接</option></select></div>
        <div class="actions"><button class="button primary" type="button" data-health-action="validate-selected">检测所选</button><button class="button" type="button" data-health-action="select-problems">选择异常账号</button></div>
      </div>
      <div class="summary-row"><span data-health-visible-count>当前显示 ${accounts.length} / ${accounts.length} 个账号</span><strong>单次最多检测 ${MAX_BATCH} 个</strong></div>
      <div class="table-wrap"><table><thead><tr><th><input type="checkbox" data-health-select-all aria-label="全选当前账号"></th><th>用户</th><th>Telegram 账号</th><th>状态</th><th>最近检测</th><th>最近错误</th><th>凭据</th><th><span class="sr-only">操作</span></th></tr></thead><tbody data-health-table-body>${accountRows(accounts)}</tbody></table></div>
    </div>`;
}

function ensureSection() {
  if (!isAdministrator() || !String(location.hash).startsWith(HEALTH_ROUTE)) return null;
  const view = document.querySelector("#view");
  if (!view || !view.querySelector("table")) return null;
  let section = view.querySelector("[data-platform-health-center]");
  if (!section) {
    section = document.createElement("section");
    section.className = "card mt-md";
    section.dataset.platformHealthCenter = "true";
    section.innerHTML = '<div class="card-body"><p class="field-help">正在加载全平台账号健康状态…</p></div>';
    view.append(section);
  }
  return section;
}

async function renderHealthCenter({ force = false } = {}) {
  const section = ensureSection();
  if (!section || healthLoading || (healthLoaded && !force)) return;
  healthLoading = true;
  section.innerHTML = '<div class="card-body"><p class="field-help">正在加载全平台账号健康状态…</p></div>';
  try {
    accountsCache = await fetchAllAccounts();
    if (!section.isConnected) return;
    section.innerHTML = healthSectionMarkup(accountsCache);
    healthLoaded = true;
    if (sessionStorage.getItem("focus-platform-account-health") === "1") {
      sessionStorage.removeItem("focus-platform-account-health");
      setTimeout(() => section.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
    }
  } catch (error) {
    if (section.isConnected) {
      section.innerHTML = `<div class="card-head"><div><h2>全平台账号健康中心</h2></div><button class="button small ghost" type="button" data-health-action="refresh">重试</button></div><div class="card-body"><div class="notice danger"><span aria-hidden="true">!</span><span>${escapeHtml(error.message)}</span></div></div>`;
    }
  } finally {
    healthLoading = false;
  }
}

async function validateAccounts(ids, button) {
  const unique = [...new Set(ids)].slice(0, MAX_BATCH);
  if (!unique.length) {
    notify("尚未选择账号", "请勾选需要检测的账号。", "error");
    return;
  }
  const oldLabel = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = "正在启动…";
  }
  try {
    const payload = unique.length === 1
      ? await request(`/api/v1/admin/account-health/${encodeURIComponent(unique[0])}/validate`, { method: "POST", body: {} })
      : await request("/api/v1/admin/account-health/validate-batch", { method: "POST", body: { account_ids: unique } });
    const result = payload?.data || payload;
    const started = unique.length === 1 ? 1 : Number(result?.started || 0);
    const failures = unique.length === 1 ? 0 : Number(result?.failures?.length || 0);
    notify("检测已启动", `成功启动 ${started} 个${failures ? `，${failures} 个未能启动` : ""}。结果稍后显示在账号状态中。`);
    healthLoaded = false;
    setTimeout(() => renderHealthCenter({ force: true }), 1200);
  } catch (error) {
    notify("检测启动失败", error.message, "error");
  } finally {
    if (button?.isConnected) {
      button.disabled = false;
      button.textContent = oldLabel;
    }
  }
}

function selectedIds(section) {
  return [...section.querySelectorAll("[data-health-select]:checked")].map((input) => input.value);
}

function adaptSkillCard() {
  const card = document.querySelector('[data-skill-hub-capability="account_connection_check"]');
  if (!card) return;
  const button = card.querySelector('[data-skill-hub-action="create-validation"]');
  if (button) button.textContent = "打开健康中心";
  const entry = [...card.querySelectorAll(".skill-meta span")].find((item) => item.textContent.includes("配置入口"));
  if (entry) entry.innerHTML = "配置入口<strong>全平台账号健康中心</strong>";
}

function refresh() {
  adaptSkillCard();
  renderHealthCenter();
}

document.addEventListener("click", (event) => {
  const validationButton = event.target.closest('[data-skill-hub-capability="account_connection_check"] [data-skill-hub-action="create-validation"]');
  if (!validationButton || !isAdministrator()) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  sessionStorage.setItem("focus-platform-account-health", "1");
  location.hash = HEALTH_ROUTE;
}, true);

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-health-action]");
  if (!button) return;
  const section = button.closest("[data-platform-health-center]");
  const action = button.dataset.healthAction;
  if (action === "refresh") {
    healthLoaded = false;
    return renderHealthCenter({ force: true });
  }
  if (!section) return;
  if (action === "validate-one") return validateAccounts([button.dataset.id], button);
  if (action === "validate-selected") return validateAccounts(selectedIds(section), button);
  if (action === "select-problems") {
    let selected = 0;
    for (const row of section.querySelectorAll("[data-health-account-row]")) {
      const account = accountsCache.find((item) => String(item.id) === String(row.dataset.accountId));
      const checkbox = row.querySelector("[data-health-select]");
      const shouldSelect = selected < MAX_BATCH && checkbox && !checkbox.disabled && account && account.status !== "connected";
      if (checkbox) checkbox.checked = Boolean(shouldSelect);
      if (shouldSelect) selected += 1;
    }
    notify("已选择异常账号", `共选择 ${selected} 个可检测账号。`);
  }
});

document.addEventListener("change", (event) => {
  const section = event.target.closest("[data-platform-health-center]");
  if (!section) return;
  if (event.target.matches("[data-health-status]")) healthBody(section);
  if (event.target.matches("[data-health-select-all]")) {
    let selected = 0;
    for (const checkbox of section.querySelectorAll("[data-health-select]")) {
      const checked = event.target.checked && !checkbox.disabled && selected < MAX_BATCH;
      checkbox.checked = checked;
      if (checked) selected += 1;
    }
  }
});

document.addEventListener("input", (event) => {
  const section = event.target.closest("[data-platform-health-center]");
  if (section && event.target.matches("[data-health-search]")) healthBody(section);
});

let scheduled = false;
const observer = typeof MutationObserver === "undefined" ? null : new MutationObserver(() => {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    refresh();
  });
});
if (observer) observer.observe(document.body, { childList: true, subtree: true });
window.addEventListener("hashchange", () => {
  healthLoaded = false;
  queueMicrotask(refresh);
});
queueMicrotask(refresh);
