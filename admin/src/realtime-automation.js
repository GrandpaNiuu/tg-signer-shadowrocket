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

async function request(path) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error?.message || `请求失败（HTTP ${response.status}）`);
  }
  return payload?.data ?? payload;
}

function listenerStatusMarkup(status) {
  const online = status?.online === true;
  const configured = status?.configured === true;
  const label = online ? "在线" : configured ? "未连接" : "尚未配置";
  const badge = online ? "success" : configured ? "pending" : "error";
  return `<div class="service-list">
    <div class="service-row"><div><strong>常驻 Listener</strong><small>VPS 长期运行执行器</small></div><span class="badge ${badge}">${label}</span></div>
    <div class="service-row"><div><strong>最近心跳</strong><small>${escapeHtml(status?.instance?.label || "尚无实例")}</small></div><span>${escapeHtml(formatDate(status?.instance?.last_heartbeat_at))}</span></div>
    <div class="service-row"><div><strong>实时运行规模</strong><small>业务功能在“任务类型”和“自动消息”中创建</small></div><span>${Number(status?.active_accounts || 0)} 个账号 · ${Number(status?.active_rules || 0)} 个任务</span></div>
  </div>`;
}

async function renderListenerStatus(section) {
  if (!section || section.dataset.loading === "true") return;
  section.dataset.loading = "true";
  try {
    const status = await request("/api/v1/admin/listener-status");
    if (!section.isConnected) return;
    section.innerHTML = `<div class="card-head"><div><h2>Listener 基础设施</h2><p>设置页只显示服务状态，不在这里创建关键词回复、群监听或检测任务。</p></div><button class="button small ghost" type="button" data-listener-status-action="refresh">刷新</button></div>
      <div class="card-body">${listenerStatusMarkup(status)}
        <div class="actions mt-md"><a class="button primary" href="#/skills">前往任务类型</a><a class="button" href="#/tasks">管理任务</a></div>
      </div>`;
  } catch (error) {
    if (!section.isConnected) return;
    section.innerHTML = `<div class="card-head"><div><h2>Listener 基础设施</h2></div><button class="button small ghost" type="button" data-listener-status-action="refresh">重试</button></div><div class="card-body"><div class="notice danger"><span aria-hidden="true">!</span><span>${escapeHtml(error.message)}</span></div></div>`;
  } finally {
    if (section.isConnected) delete section.dataset.loading;
  }
}

function ensureListenerStatusSection() {
  if (!isAdministrator()) return;
  const layout = document.querySelector(".settings-layout");
  if (!layout) return;
  let section = layout.querySelector("[data-listener-status-section]");
  if (!section) {
    section = document.createElement("section");
    section.className = "card span-2";
    section.dataset.listenerStatusSection = "true";
    section.innerHTML = '<div class="card-body"><p class="field-help">正在加载 Listener 状态…</p></div>';
    layout.insertBefore(section, layout.querySelector("aside"));
  }
  if (!section.dataset.loaded) {
    section.dataset.loaded = "true";
    renderListenerStatus(section);
  }
}

function enforceAdminValidationVisibility() {
  if (isAdministrator()) return;
  document.querySelectorAll('[data-action="validate-account"], [data-action="validate-all-accounts"]').forEach((button) => {
    button.hidden = true;
  });
}

function refreshEnhancements() {
  ensureListenerStatusSection();
  enforceAdminValidationVisibility();
}

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-listener-status-action]");
  if (!button) return;
  const section = button.closest("[data-listener-status-section]");
  renderListenerStatus(section);
});

let scheduled = false;
const observer = typeof MutationObserver === "undefined" ? null : new MutationObserver(() => {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    refreshEnhancements();
  });
});
if (observer) observer.observe(document.body, { childList: true, subtree: true });
queueMicrotask(refreshEnhancements);
