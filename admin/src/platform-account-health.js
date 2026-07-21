const HEALTH_ROUTE = "#/users";
const SKILLS_ROUTE = "#/skills";
const MAX_BATCH = 20;
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const ACTIVE_VALIDATION_STATUSES = new Set(["created", "starting", "code_submitted", "password_submitted"]);

let accountsCache = [];
let healthLoading = false;
let healthLoaded = false;
let syncScheduled = false;
let loadSequence = 0;
let viewObserver = null;
const resultRefreshTimers = new Set();

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

async function request(path, { method = "GET", body, timeoutMs = 20_000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
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
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("账号健康中心请求超时，请稍后重试。");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
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

function validationActive(account) {
  return ACTIVE_VALIDATION_STATUSES.has(account.validation_status);
}

function isStale(account) {
  if (!account.last_checked_at) return false;
  const timestamp = new Date(account.last_checked_at).getTime();
  return Number.isFinite(timestamp) && Date.now() - timestamp > STALE_AFTER_MS;
}

function statusMeta(status) {
  return ({
    connected: { label: "已连接", badge: "success" },
    login_pending: { label: "连接中", badge: "pending" },
    disconnected: { label: "未连接", badge: "pending" },
    error: { label: "异常", badge: "error" },
  })[status] || { label: status || "未知", badge: "pending" };
}

function riskMeta(account) {
  if (validationActive(account)) return { key: "checking", label: "检测中", badge: "pending" };
  if (!account.detectable) return { key: "blocked", label: "不可检测", badge: "error" };
  if (account.status === "error" || account.last_error || account.validation_error) {
    return { key: "problem", label: "需要处理", badge: "error" };
  }
  if (!account.last_checked_at) return { key: "unchecked", label: "尚未检测", badge: "pending" };
  if (isStale(account)) return { key: "stale", label: "结果已过期", badge: "pending" };
  if (account.status !== "connected") return { key: "problem", label: "需要处理", badge: "error" };
  return { key: "healthy", label: "正常", badge: "success" };
}

function diagnosis(account) {
  const raw = `${account.last_error || ""} ${account.validation_error || ""}`.toLowerCase();
  if (account.detection_block_reason === "owner_disabled") {
    return { title: "用户已停用", action: "先在用户管理中恢复该用户，再进行检测。" };
  }
  if (account.detection_block_reason === "account_disabled") {
    return { title: "账号已停用", action: "让用户启用该 Telegram 账号后再检测。" };
  }
  if (account.detection_block_reason === "account_credentials_incomplete" || !account.session_configured) {
    return { title: "缺少 Session", action: "让用户重新通过手机号、验证码完成 Telegram 登录。" };
  }
  if (validationActive(account)) {
    return { title: "正在检测", action: "等待检测完成，页面会自动刷新结果。" };
  }
  if (/auth_key|session_revoked|session.*invalid|unauthorized|401|unregistered/.test(raw)) {
    return { title: "Session 已失效", action: "让用户删除旧账号连接并重新登录 Telegram。" };
  }
  if (/api[_ -]?id|api[_ -]?hash|app_id_invalid|api_id_invalid/.test(raw)) {
    return { title: "Telegram 应用凭据异常", action: "管理员检查平台设置中的 API_ID 和 API_HASH。" };
  }
  if (/proxy|socks|timeout|timed out|network|connection|connect error|unreachable|dns/.test(raw)) {
    return { title: "网络或代理异常", action: "检查该账号代理地址、端口、认证信息及服务器网络。" };
  }
  if (/flood|wait|too many|rate limit/.test(raw)) {
    return { title: "Telegram 频率限制", action: "暂停操作并等待限制时间结束，不要反复重试。" };
  }
  if (/banned|deactivated|deleted account|phone.*ban/.test(raw)) {
    return { title: "账号可能受限", action: "让用户在 Telegram 官方客户端确认账号状态。" };
  }
  if (account.status === "disconnected") {
    return { title: "当前未连接", action: "点击检测确认 Session 是否仍有效；失败则重新登录。" };
  }
  if (!account.last_checked_at) {
    return { title: "尚无检测记录", action: "建议先执行一次连接检测建立健康基线。" };
  }
  if (isStale(account)) {
    return { title: "检测结果超过 7 天", action: "重新检测以确认当前连接状态。" };
  }
  if (account.status === "connected") {
    return { title: "连接正常", action: "无需处理；任务异常时再检查执行记录。" };
  }
  return { title: "需要进一步确认", action: "执行检测并根据最新错误信息处理。" };
}

function supportMessage(account) {
  const state = statusMeta(account.status);
  const advice = diagnosis(account);
  return `您好，系统检测到您的 Telegram 账号“${account.account_name || "未命名账号"}”（${account.phone_masked || "手机号已隐藏"}）当前状态为“${state.label}”。\n\n判断：${advice.title}\n建议：${advice.action}\n\n请不要向任何人发送 Telegram 验证码、二步验证密码或 Session。处理后可在平台重新发起连接检测。`;
}

function detectionDisabledReason(account) {
  if (validationActive(account)) return "检测进行中";
  if (account.detection_block_reason === "owner_disabled") return "所属用户已停用";
  if (account.detection_block_reason === "account_disabled") return "账号已停用";
  if (account.detection_block_reason === "account_credentials_incomplete") return "尚未保存 Session";
  return account.detectable === false ? "当前不可检测" : "";
}

function filteredAccounts(section) {
  const search = String(section.querySelector("[data-health-search]")?.value || "").trim().toLowerCase();
  const status = String(section.querySelector("[data-health-status]")?.value || "");
  const risk = String(section.querySelector("[data-health-risk]")?.value || "");
  return accountsCache.filter((account) => {
    if (status && account.status !== status) return false;
    if (risk && riskMeta(account).key !== risk) return false;
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
      diagnosis(account).title,
    ].some((value) => String(value || "").toLowerCase().includes(search));
  });
}

function accountRows(accounts) {
  if (!accounts.length) {
    return '<tr><td colspan="7"><div class="empty-state"><div class="empty-icon" aria-hidden="true">◎</div><h3>没有符合条件的账号</h3><p>调整搜索或筛选条件后重试。</p></div></td></tr>';
  }
  return accounts.map((account) => {
    const state = statusMeta(account.status);
    const risk = riskMeta(account);
    const advice = diagnosis(account);
    const disabledReason = detectionDisabledReason(account);
    const telegramIdentity = account.telegram_username
      ? `@${account.telegram_username}`
      : account.telegram_display_name || "—";
    const rawError = account.last_error || account.validation_error || "无技术错误";
    return `<tr data-health-account-row data-account-id="${escapeHtml(account.id)}">
      <td data-label="选择"><input type="checkbox" data-health-select value="${escapeHtml(account.id)}" ${disabledReason ? "disabled" : ""} aria-label="选择 ${escapeHtml(account.account_name)}"></td>
      <td data-label="用户"><span class="cell-title">${escapeHtml(account.owner_display_name)}</span><span class="cell-sub">${escapeHtml(account.owner_login)}${account.owner_status === "disabled" ? " · 用户已停用" : ""}</span></td>
      <td data-label="Telegram 账号"><span class="cell-title">${escapeHtml(account.account_name)}</span><span class="cell-sub">${escapeHtml(account.phone_masked || "—")} · ${escapeHtml(telegramIdentity)}</span></td>
      <td data-label="健康状态"><span class="badge ${state.badge}">${escapeHtml(state.label)}</span> <span class="badge ${risk.badge}">${escapeHtml(risk.label)}</span><span class="cell-sub">${account.session_configured ? "Session 已保存" : "缺少 Session"}</span></td>
      <td data-label="最近检测"><span class="cell-title">${escapeHtml(formatDate(account.last_checked_at || account.validation_started_at))}</span><span class="cell-sub">最近连接：${escapeHtml(formatDate(account.last_connected_at))}</span></td>
      <td data-label="诊断与建议"><span class="cell-title">${escapeHtml(advice.title)}</span><span class="cell-sub">${escapeHtml(advice.action)}</span><span class="cell-sub" title="${escapeHtml(rawError)}">技术信息：${escapeHtml(rawError.length > 80 ? `${rawError.slice(0, 80)}…` : rawError)}</span></td>
      <td data-label="操作"><div class="actions"><button class="button small" type="button" data-health-action="validate-one" data-id="${escapeHtml(account.id)}" ${disabledReason ? `disabled title="${escapeHtml(disabledReason)}"` : ""}>${validationActive(account) ? "检测中" : "检测"}</button><button class="button small ghost" type="button" data-health-action="copy-advice" data-id="${escapeHtml(account.id)}">复制建议</button></div></td>
    </tr>`;
  }).join("");
}

function statsMarkup(accounts) {
  const healthy = accounts.filter((item) => riskMeta(item).key === "healthy").length;
  const problems = accounts.filter((item) => ["problem", "blocked"].includes(riskMeta(item).key)).length;
  const checking = accounts.filter(validationActive).length;
  const unchecked = accounts.filter((item) => !item.last_checked_at).length;
  return `<div class="stats-grid mb-md">
    <section class="stat-card"><span class="stat-label">平台账号</span><strong>${accounts.length}</strong><small>仅显示脱敏信息</small></section>
    <section class="stat-card"><span class="stat-label">健康</span><strong>${healthy}</strong><small>最近检测正常</small></section>
    <section class="stat-card"><span class="stat-label">需要处理</span><strong>${problems}</strong><small>优先协助用户</small></section>
    <section class="stat-card"><span class="stat-label">检测中 / 未检测</span><strong>${checking} / ${unchecked}</strong><small>结果自动刷新</small></section>
  </div>`;
}

function updateSelectionSummary(section) {
  const selected = section.querySelectorAll("[data-health-select]:checked").length;
  const target = section.querySelector("[data-health-selected-count]");
  if (target) target.textContent = `已选择 ${selected} / ${MAX_BATCH} 个账号`;
}

function healthBody(section) {
  const visible = filteredAccounts(section);
  const tbody = section.querySelector("[data-health-table-body]");
  if (tbody) tbody.innerHTML = accountRows(visible);
  const count = section.querySelector("[data-health-visible-count]");
  if (count) count.textContent = `当前显示 ${visible.length} / ${accountsCache.length} 个账号`;
  const selectAll = section.querySelector("[data-health-select-all]");
  if (selectAll) selectAll.checked = false;
  updateSelectionSummary(section);
}

function healthSectionMarkup(accounts) {
  return `<div class="card-head"><div><h2>全平台账号健康中心</h2><p>帮助用户排查 Telegram Session、应用凭据、代理和网络问题；不会显示或导出秘密凭据。</p></div><button class="button small ghost" type="button" data-health-action="refresh">刷新</button></div>
    <div class="card-body">
      ${statsMarkup(accounts)}
      <div class="notice mb-md"><span aria-hidden="true">i</span><span>管理员可以代用户发起连接检测和复制排查建议，但不能查看 Session、验证码、二步验证密码或代理密码。检测不会发送业务消息。</span></div>
      <div class="toolbar">
        <div class="field"><label for="platform-health-search">搜索</label><input id="platform-health-search" data-health-search type="search" placeholder="用户、账号、脱敏手机号、错误或诊断"></div>
        <div class="field"><label for="platform-health-status">连接状态</label><select id="platform-health-status" data-health-status><option value="">全部状态</option><option value="error">异常</option><option value="disconnected">未连接</option><option value="login_pending">连接中</option><option value="connected">已连接</option></select></div>
        <div class="field"><label for="platform-health-risk">处理优先级</label><select id="platform-health-risk" data-health-risk><option value="">全部</option><option value="problem">需要处理</option><option value="blocked">不可检测</option><option value="unchecked">尚未检测</option><option value="stale">结果已过期</option><option value="checking">检测中</option><option value="healthy">正常</option></select></div>
        <div class="actions"><button class="button primary" type="button" data-health-action="validate-selected">检测所选</button><button class="button" type="button" data-health-action="select-problems">选择需处理账号</button></div>
      </div>
      <div class="summary-row"><span data-health-visible-count>当前显示 ${accounts.length} / ${accounts.length} 个账号</span><span data-health-selected-count>已选择 0 / ${MAX_BATCH} 个账号</span><strong>单次最多检测 ${MAX_BATCH} 个</strong></div>
      <div class="table-wrap"><table><thead><tr><th><input type="checkbox" data-health-select-all aria-label="全选当前账号"></th><th>用户</th><th>Telegram 账号</th><th>健康状态</th><th>最近检测</th><th>诊断与建议</th><th><span class="sr-only">操作</span></th></tr></thead><tbody data-health-table-body>${accountRows(accounts)}</tbody></table></div>
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
  const sequence = ++loadSequence;
  healthLoading = true;
  section.innerHTML = '<div class="card-body"><p class="field-help">正在加载全平台账号健康状态…</p></div>';
  try {
    const accounts = await fetchAllAccounts();
    if (sequence !== loadSequence || !section.isConnected) return;
    accountsCache = accounts;
    section.innerHTML = healthSectionMarkup(accountsCache);
    healthLoaded = true;
    if (sessionStorage.getItem("focus-platform-account-health") === "1") {
      sessionStorage.removeItem("focus-platform-account-health");
      setTimeout(() => section.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
    }
  } catch (error) {
    if (sequence === loadSequence && section.isConnected) {
      section.innerHTML = `<div class="card-head"><div><h2>全平台账号健康中心</h2></div><button class="button small ghost" type="button" data-health-action="refresh">重试</button></div><div class="card-body"><div class="notice danger"><span aria-hidden="true">!</span><span>${escapeHtml(error.message)}</span></div></div>`;
    }
  } finally {
    if (sequence === loadSequence) healthLoading = false;
  }
}

function clearResultRefreshTimers() {
  for (const timer of resultRefreshTimers) clearTimeout(timer);
  resultRefreshTimers.clear();
}

function scheduleResultRefresh() {
  clearResultRefreshTimers();
  for (const delay of [3_000, 10_000, 30_000]) {
    const timer = setTimeout(() => {
      resultRefreshTimers.delete(timer);
      if (!String(location.hash).startsWith(HEALTH_ROUTE)) return;
      healthLoaded = false;
      renderHealthCenter({ force: true });
    }, delay);
    resultRefreshTimers.add(timer);
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
    notify("检测已启动", `成功启动 ${started} 个${failures ? `，${failures} 个未能启动` : ""}。页面将在 3 秒、10 秒和 30 秒后自动刷新。`);
    scheduleResultRefresh();
  } catch (error) {
    notify("检测启动失败", error.message, "error");
  } finally {
    if (button?.isConnected) {
      button.disabled = false;
      button.textContent = oldLabel;
    }
  }
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("浏览器不允许复制，请手动记录处理建议。");
}

function selectedIds(section) {
  return [...section.querySelectorAll("[data-health-select]:checked")].map((input) => input.value);
}

function adaptSkillCard() {
  if (!isAdministrator() || !String(location.hash).startsWith(SKILLS_ROUTE)) return;
  const card = document.querySelector('[data-skill-hub-capability="account_connection_check"]');
  if (!card || card.dataset.healthCenterAdapted === "true") return;
  const button = card.querySelector('[data-skill-hub-action="create-validation"]');
  if (button) button.textContent = "打开健康中心";
  const entry = [...card.querySelectorAll(".skill-meta span")].find((item) => item.textContent.includes("配置入口"));
  if (entry) entry.innerHTML = "配置入口<strong>全平台账号健康中心</strong>";
  card.dataset.healthCenterAdapted = "true";
}

function syncRoute() {
  attachViewObserver();
  if (String(location.hash).startsWith(SKILLS_ROUTE)) adaptSkillCard();
  if (String(location.hash).startsWith(HEALTH_ROUTE)) {
    renderHealthCenter();
  } else {
    clearResultRefreshTimers();
  }
}

function scheduleSync() {
  if (syncScheduled) return;
  syncScheduled = true;
  queueMicrotask(() => {
    syncScheduled = false;
    syncRoute();
  });
}

function attachViewObserver() {
  if (viewObserver) return;
  const view = document.querySelector("#view");
  if (!view) return;
  viewObserver = new MutationObserver(scheduleSync);
  viewObserver.observe(view, { childList: true });
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
  if (action === "copy-advice") {
    const account = accountsCache.find((item) => String(item.id) === String(button.dataset.id));
    if (!account) return notify("账号不存在", "请刷新健康中心后重试。", "error");
    try {
      await copyText(supportMessage(account));
      notify("处理建议已复制", "可以直接发送给对应用户。", "success");
    } catch (error) {
      notify("复制失败", error.message, "error");
    }
    return;
  }
  if (action === "select-problems") {
    let selected = 0;
    for (const row of section.querySelectorAll("[data-health-account-row]")) {
      const account = accountsCache.find((item) => String(item.id) === String(row.dataset.accountId));
      const checkbox = row.querySelector("[data-health-select]");
      const needsAttention = account && ["problem", "stale", "unchecked"].includes(riskMeta(account).key);
      const shouldSelect = selected < MAX_BATCH && checkbox && !checkbox.disabled && needsAttention;
      if (checkbox) checkbox.checked = Boolean(shouldSelect);
      if (shouldSelect) selected += 1;
    }
    updateSelectionSummary(section);
    notify("已选择需处理账号", `共选择 ${selected} 个可检测账号。`);
  }
});

document.addEventListener("change", (event) => {
  const section = event.target.closest("[data-platform-health-center]");
  if (!section) return;
  if (event.target.matches("[data-health-status], [data-health-risk]")) healthBody(section);
  if (event.target.matches("[data-health-select-all]")) {
    let selected = 0;
    for (const checkbox of section.querySelectorAll("[data-health-select]")) {
      const checked = event.target.checked && !checkbox.disabled && selected < MAX_BATCH;
      checkbox.checked = checked;
      if (checked) selected += 1;
    }
  }
  if (event.target.matches("[data-health-select], [data-health-select-all]")) updateSelectionSummary(section);
});

document.addEventListener("input", (event) => {
  const section = event.target.closest("[data-platform-health-center]");
  if (section && event.target.matches("[data-health-search]")) healthBody(section);
});

window.addEventListener("hashchange", () => {
  healthLoaded = false;
  loadSequence += 1;
  scheduleSync();
});

attachViewObserver();
queueMicrotask(syncRoute);
setTimeout(syncRoute, 600);
setTimeout(syncRoute, 1600);

export const __test = {
  diagnosis,
  detectionDisabledReason,
  riskMeta,
  supportMessage,
};
