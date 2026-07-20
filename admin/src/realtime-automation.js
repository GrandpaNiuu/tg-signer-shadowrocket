const TERMINAL_INSPECTIONS = new Set(["success", "failed", "expired", "cancelled"]);

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

async function request(path, { method = "GET", body } = {}) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? { accept: "application/json" } : {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload?.error?.message || `请求失败（HTTP ${response.status}）`;
    const error = new Error(message);
    error.status = response.status;
    error.code = payload?.error?.code;
    throw error;
  }
  return payload?.data ?? payload;
}

function feedback(container, message, kind = "info") {
  if (!container) return;
  container.className = `notice ${kind === "error" ? "danger" : kind === "success" ? "" : "warning"}`;
  container.innerHTML = `<span aria-hidden="true">${kind === "error" ? "!" : kind === "success" ? "✓" : "i"}</span><span>${escapeHtml(message)}</span>`;
  container.hidden = false;
}

function ensureInspectionControls() {
  const form = document.querySelector("#task-form");
  const builder = form?.querySelector("[data-guided-signin-builder]");
  if (!form || !builder || form.querySelector("[data-bot-inspection-controls]")) return;
  const section = document.createElement("div");
  section.dataset.botInspectionControls = "true";
  section.className = "mt-md";
  section.innerHTML = `<div class="card-head"><div><h3>不知道按钮怎么填？</h3><p>平台可以发送上面的命令，读取机器人回复和可用按钮，但不会自动点击。</p></div><button class="button small" type="button" data-realtime-action="inspect-bot">自动识别机器人操作</button></div>
    <div data-inspection-feedback hidden></div>
    <div data-inspection-result></div>`;
  builder.append(section);
}

async function pollInspection(id, controls) {
  const feedbackBox = controls.querySelector("[data-inspection-feedback]");
  const resultBox = controls.querySelector("[data-inspection-result]");
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const inspection = await request(`/api/v1/bot-inspections/${encodeURIComponent(id)}`);
    if (!TERMINAL_INSPECTIONS.has(inspection.status)) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      continue;
    }
    if (inspection.status !== "success") {
      feedback(feedbackBox, inspection.error_message || "识别未完成。请确认常驻 Listener 在线，并检查 Telegram 账号连接。", "error");
      return;
    }
    const result = inspection.result || {};
    const buttons = Array.isArray(result.buttons) ? result.buttons : [];
    feedback(feedbackBox, result.reply_received ? "已读取机器人回复，请选择要点击的按钮。" : "命令已发送，但等待时间内没有收到机器人回复。", result.reply_received ? "success" : "info");
    resultBox.innerHTML = `<div class="notice mt-sm"><span aria-hidden="true">i</span><span><strong>机器人回复</strong><br>${escapeHtml(result.reply_text || "未返回文字内容")}</span></div>
      ${buttons.length ? `<div class="field mt-sm"><label>检测到的按钮</label><div class="actions">${buttons.map((button) => `<button type="button" class="button small ghost" data-realtime-action="use-inspected-button" data-button-text="${escapeHtml(button)}">${escapeHtml(button)}</button>`).join("")}</div><p class="field-help">点击一个按钮后，会自动填入“需要点击的按钮文字”。</p></div>` : '<p class="field-help mt-sm">没有检测到内联按钮。可以修改发送命令后重新识别。</p>'}`;
    if (result.suggested_button_text) {
      const input = formField("#guided-button-text");
      if (input && !input.value) {
        input.value = result.suggested_button_text;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }
    return;
  }
  feedback(feedbackBox, "识别等待超时。常驻 Listener 可能尚未上线或正在重连。", "error");
}

function formField(selector) {
  return document.querySelector(`#task-form ${selector}`);
}

async function inspectBot(button) {
  const form = document.querySelector("#task-form");
  const controls = form?.querySelector("[data-bot-inspection-controls]");
  if (!form || !controls) return;
  const accountId = form.elements.namedItem("account_id")?.value;
  const target = form.elements.namedItem("bot")?.value?.trim();
  const startCommand = form.elements.namedItem("command")?.value?.trim() || "/start";
  const feedbackBox = controls.querySelector("[data-inspection-feedback]");
  if (!accountId || !target) {
    return feedback(feedbackBox, "请先选择 Telegram 账号，并填写机器人用户名。", "error");
  }
  button.disabled = true;
  const label = button.textContent;
  button.textContent = "正在排队…";
  controls.querySelector("[data-inspection-result]").innerHTML = "";
  try {
    const inspection = await request("/api/v1/bot-inspections", {
      method: "POST",
      body: { account_id: accountId, target, start_command: startCommand, wait_seconds: 30 },
    });
    feedback(feedbackBox, "识别任务已提交。平台正在读取机器人回复，请不要关闭这个窗口。", "info");
    await pollInspection(inspection.id, controls);
  } catch (error) {
    feedback(feedbackBox, error.message, "error");
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.textContent = label;
    }
  }
}

function listenerStatusMarkup(status) {
  const online = status?.online === true;
  const configured = status?.configured === true;
  const label = online ? "在线" : configured ? "未连接" : "尚未配置";
  const badge = online ? "success" : configured ? "pending" : "error";
  return `<div class="service-list">
    <div class="service-row"><div><strong>常驻 Listener</strong><small>${configured ? "VPS 长期运行服务" : "需要先配置 LISTENER_API_TOKEN 并部署 VPS 服务"}</small></div><span class="badge ${badge}">${label}</span></div>
    <div class="service-row"><div><strong>最近心跳</strong><small>${escapeHtml(status?.instance?.label || "尚无实例")}</small></div><span>${escapeHtml(formatDate(status?.instance?.last_heartbeat_at))}</span></div>
    <div class="service-row"><div><strong>运行规模</strong><small>仅管理员专用 Telegram 账号</small></div><span>${Number(status?.active_accounts || 0)} 个账号 · ${Number(status?.active_rules || 0)} 条规则</span></div>
  </div>`;
}

function ruleKindLabel(kind) {
  return kind === "keyword_reply" ? "关键词自动回复" : "群消息监听";
}

function ruleListMarkup(rules) {
  if (!rules.length) return '<p class="field-help">尚未创建实时规则。</p>';
  return `<div class="service-list">${rules.map((rule) => `<div class="service-row"><div><strong>${escapeHtml(rule.name)}</strong><small>${escapeHtml(rule.account_name || "—")} · ${ruleKindLabel(rule.kind)} · 范围 ${escapeHtml(rule.chat_selector)}</small></div><div class="actions"><span class="badge ${rule.enabled ? "success" : "pending"}">${rule.enabled ? "启用" : "停用"}</span><button class="button small ghost" type="button" data-realtime-action="toggle-rule" data-id="${escapeHtml(rule.id)}" data-enabled="${rule.enabled ? "true" : "false"}">${rule.enabled ? "停用" : "启用"}</button><button class="button small ghost danger" type="button" data-realtime-action="delete-rule" data-id="${escapeHtml(rule.id)}">删除</button></div></div>`).join("")}</div>`;
}

function eventListMarkup(events) {
  if (!events.length) return '<p class="field-help">暂无实时监听记录。</p>';
  return `<div class="log-list">${events.slice(0, 20).map((event) => `<div class="log-line"><span class="log-level">${escapeHtml(event.event_kind === "keyword_replied" ? "回复" : event.event_kind === "message_observed" ? "监听" : "状态")}</span><span>${escapeHtml(event.action_summary || event.message_preview || "实时事件")}</span><span class="log-time">${escapeHtml(formatDate(event.created_at))}</span></div>`).join("")}</div>`;
}

async function renderAdminRealtimeSection(section) {
  section.dataset.loading = "true";
  try {
    const [status, rules, events, accountsPayload, tasksPayload] = await Promise.all([
      request("/api/v1/admin/listener-status"),
      request("/api/v1/admin/realtime-rules"),
      request("/api/v1/admin/listener-events"),
      request("/api/v1/accounts?limit=100"),
      request("/api/v1/tasks?limit=100"),
    ]);
    const accounts = Array.isArray(accountsPayload) ? accountsPayload : accountsPayload?.items || accountsPayload?.data || [];
    const tasks = Array.isArray(tasksPayload) ? tasksPayload : tasksPayload?.items || tasksPayload?.data || [];
    const busy = new Set(tasks.filter((task) => task.enabled).map((task) => String(task.account_id)));
    const eligible = accounts.filter((account) => account.enabled && account.status === "connected" && !busy.has(String(account.id)));
    section.innerHTML = `<div class="card-head"><div><h2>24 小时实时服务</h2><p>仅平台管理员可配置。GitHub Actions 不承担长期连接。</p></div><button class="button small ghost" type="button" data-realtime-action="refresh-admin-realtime">刷新</button></div>
      <div class="card-body">${listenerStatusMarkup(status)}
        <div class="notice warning mt-md"><span aria-hidden="true">!</span><span><strong>必须使用专用账号</strong><br>实时监听账号不能同时启用普通定时任务，避免同一 Session 被两个执行器同时使用。</span></div>
        <form id="realtime-rule-form" class="mt-md"><div class="form-grid">
          <div class="field"><label class="required" for="realtime-rule-name">规则名称</label><input id="realtime-rule-name" name="name" maxlength="100" required placeholder="例如：客服关键词回复"></div>
          <div class="field"><label class="required" for="realtime-rule-account">专用 Telegram 账号</label><select id="realtime-rule-account" name="account_id" required><option value="">请选择</option>${eligible.map((account) => `<option value="${escapeHtml(account.id)}">${escapeHtml(account.name)}</option>`).join("")}</select><p class="field-help">这里只显示已连接且没有启用普通任务的账号。</p></div>
          <div class="field"><label class="required" for="realtime-rule-kind">功能</label><select id="realtime-rule-kind" name="kind"><option value="keyword_reply">24 小时关键词自动回复</option><option value="group_monitor">全天候群消息监听</option></select></div>
          <div class="field"><label class="required" for="realtime-rule-chat">监听范围</label><input id="realtime-rule-chat" name="chat_selector" value="*" maxlength="128" required placeholder="*、@群组用户名或数字 Chat ID"><p class="field-help">填写 * 表示该账号收到的所有适用会话。</p></div>
          <div class="field"><label for="realtime-rule-keyword">关键词</label><input id="realtime-rule-keyword" name="keyword" maxlength="200" placeholder="例如：价格、客服；群监听可留空"></div>
          <div class="field span-2" data-realtime-response-field><label for="realtime-rule-response">自动回复内容</label><textarea id="realtime-rule-response" name="response_text" maxlength="2000" placeholder="命中关键词后发送的固定回复"></textarea></div>
        </div><div data-realtime-form-feedback hidden></div><div class="actions mt-md"><button class="button primary" type="submit" ${eligible.length ? "" : "disabled"}>创建实时规则</button><button class="button" type="button" data-realtime-action="validate-listener-account">检测所选账号</button></div></form>
        ${eligible.length ? "" : '<div class="notice warning mt-md"><span aria-hidden="true">!</span><span>没有可用的专用账号。请新增或连接一个 Telegram 账号，并确保它没有启用普通定时任务。</span></div>'}
        <div class="settings-section mt-md"><h3>已配置规则</h3><div data-realtime-rule-list>${ruleListMarkup(Array.isArray(rules) ? rules : [])}</div></div>
        <div class="settings-section"><h3>最近实时事件</h3>${eventListMarkup(Array.isArray(events) ? events : [])}</div>
      </div>`;
    const kind = section.querySelector("#realtime-rule-kind");
    const syncKind = () => {
      const responseField = section.querySelector("[data-realtime-response-field]");
      responseField.hidden = kind.value !== "keyword_reply";
      section.querySelector("#realtime-rule-response").required = kind.value === "keyword_reply";
      section.querySelector("#realtime-rule-keyword").required = kind.value === "keyword_reply";
    };
    kind.addEventListener("change", syncKind);
    syncKind();
  } catch (error) {
    section.innerHTML = `<div class="card-head"><div><h2>24 小时实时服务</h2></div></div><div class="card-body"><div class="notice danger"><span aria-hidden="true">!</span><span>${escapeHtml(error.message)}</span></div></div>`;
  } finally {
    delete section.dataset.loading;
  }
}

function ensureAdminRealtimeSection() {
  if (!isAdministrator()) return;
  const layout = document.querySelector(".settings-layout");
  if (!layout || layout.querySelector("[data-admin-realtime-section]")) return;
  const section = document.createElement("section");
  section.className = "card span-2";
  section.dataset.adminRealtimeSection = "true";
  section.innerHTML = '<div class="card-body"><p class="field-help">正在加载实时服务状态…</p></div>';
  layout.insertBefore(section, layout.querySelector("aside"));
  renderAdminRealtimeSection(section);
}

function enforceAdminValidationVisibility() {
  if (isAdministrator()) return;
  document.querySelectorAll('[data-action="validate-account"], [data-action="validate-all-accounts"]').forEach((button) => {
    button.hidden = true;
  });
}

async function submitRule(form) {
  const data = new FormData(form);
  const feedbackBox = form.querySelector("[data-realtime-form-feedback]");
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await request("/api/v1/admin/realtime-rules", {
      method: "POST",
      body: {
        name: String(data.get("name") || ""),
        account_id: String(data.get("account_id") || ""),
        kind: String(data.get("kind") || "keyword_reply"),
        chat_selector: String(data.get("chat_selector") || "*"),
        keyword: String(data.get("keyword") || ""),
        response_text: String(data.get("response_text") || ""),
        enabled: true,
      },
    });
    feedback(feedbackBox, "实时规则已保存，Listener 会在下一次同步时加载。", "success");
    const section = form.closest("[data-admin-realtime-section]");
    await renderAdminRealtimeSection(section);
  } catch (error) {
    feedback(feedbackBox, error.message, "error");
    button.disabled = false;
  }
}

async function modifyRule(button, remove = false) {
  button.disabled = true;
  try {
    if (remove) {
      await request(`/api/v1/admin/realtime-rules/${encodeURIComponent(button.dataset.id)}`, { method: "DELETE" });
    } else {
      await request(`/api/v1/admin/realtime-rules/${encodeURIComponent(button.dataset.id)}`, {
        method: "PATCH",
        body: { enabled: button.dataset.enabled !== "true" },
      });
    }
    await renderAdminRealtimeSection(button.closest("[data-admin-realtime-section]"));
  } catch (error) {
    button.disabled = false;
    window.alert(error.message);
  }
}

async function validateListenerAccount(button) {
  const section = button.closest("[data-admin-realtime-section]");
  const accountId = section.querySelector("#realtime-rule-account")?.value;
  const feedbackBox = section.querySelector("[data-realtime-form-feedback]");
  if (!accountId) return feedback(feedbackBox, "请先选择专用 Telegram 账号。", "error");
  button.disabled = true;
  try {
    await request(`/api/v1/accounts/${encodeURIComponent(accountId)}/validate`, { method: "POST", body: {} });
    feedback(feedbackBox, "账号连接检测已启动，请稍后到 Telegram 账号页面查看状态。", "success");
  } catch (error) {
    feedback(feedbackBox, error.message, "error");
  } finally {
    button.disabled = false;
  }
}

function refreshEnhancements() {
  ensureInspectionControls();
  ensureAdminRealtimeSection();
  enforceAdminValidationVisibility();
}

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-realtime-action]");
  if (!button) return;
  const action = button.dataset.realtimeAction;
  if (action === "inspect-bot") return inspectBot(button);
  if (action === "use-inspected-button") {
    const field = formField("#guided-button-text");
    if (field) {
      field.value = button.dataset.buttonText || "";
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }
    return;
  }
  if (action === "refresh-admin-realtime") return renderAdminRealtimeSection(button.closest("[data-admin-realtime-section]"));
  if (action === "toggle-rule") return modifyRule(button, false);
  if (action === "delete-rule") return modifyRule(button, true);
  if (action === "validate-listener-account") return validateListenerAccount(button);
});

document.addEventListener("submit", (event) => {
  if (event.target.id !== "realtime-rule-form") return;
  event.preventDefault();
  submitRule(event.target);
});

const observer = typeof MutationObserver === "undefined" ? null : new MutationObserver(refreshEnhancements);
if (observer) observer.observe(document.body, { childList: true, subtree: true });
queueMicrotask(refreshEnhancements);
