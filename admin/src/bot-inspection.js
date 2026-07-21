const TERMINAL_INSPECTIONS = new Set(["success", "failed", "expired", "cancelled"]);

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
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
    const error = new Error(payload?.error?.message || `请求失败（HTTP ${response.status}）`);
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

function universalMarkup() {
  return `<div class="card-head"><div><h3>自动识别机器人操作</h3><p>普通用户和管理员都可使用。平台会发送上方命令，读取机器人回复和按钮，但不会在识别阶段自动点击。</p></div><button class="button small" type="button" data-bot-inspection-action="inspect">开始识别</button></div>
    <div data-inspection-feedback hidden></div>
    <div data-inspection-result></div>`;
}

function ensureUniversalInspectionControls() {
  const form = document.querySelector("#task-form");
  const commandField = form?.querySelector("#task-command")?.closest(".field");
  if (!form || !commandField) return;

  let section = form.querySelector("[data-bot-inspection-controls]");
  if (!section) {
    section = document.createElement("section");
    section.dataset.botInspectionControls = "true";
  }
  if (section.dataset.universalBotInspection !== "true") {
    section.dataset.universalBotInspection = "true";
    section.className = "field span-2";
    section.innerHTML = universalMarkup();
  }
  if (section.parentElement !== commandField.parentElement || section.previousElementSibling !== commandField) {
    commandField.insertAdjacentElement("afterend", section);
  }
}

async function waitForGuidedButton(form) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const field = form.querySelector("#guided-button-text");
    if (field) return field;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return null;
}

async function applyInspectedButton(form, buttonText, feedbackBox, { automatic = false } = {}) {
  const select = form?.querySelector("#task-skill");
  const option = select ? [...select.options].find((item) => item.value === "tg_signer") : null;
  if (!select || !option || option.disabled) {
    feedback(feedbackBox, "已识别机器人按钮，但平台当前没有启用“机器人按钮签到”任务类型，请联系管理员启用。", "error");
    return false;
  }

  if (select.value !== "tg_signer") {
    select.value = "tg_signer";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }
  const field = await waitForGuidedButton(form);
  if (!field) {
    feedback(feedbackBox, "已识别按钮，但任务配置区未能加载，请关闭窗口后重新新增任务。", "error");
    return false;
  }
  field.value = String(buttonText || "").trim();
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.focus();
  feedback(
    feedbackBox,
    automatic
      ? `已自动切换为“机器人按钮签到”，并填入按钮：${field.value}`
      : `已切换为“机器人按钮签到”，并填入按钮：${field.value}`,
    "success",
  );
  return true;
}

async function pollInspection(id, controls) {
  const feedbackBox = controls.querySelector("[data-inspection-feedback]");
  const resultBox = controls.querySelector("[data-inspection-result]");
  const form = controls.closest("#task-form");
  const deadline = Date.now() + 90_000;

  while (Date.now() < deadline) {
    const inspection = await request(`/api/v1/bot-inspections/${encodeURIComponent(id)}`);
    if (!TERMINAL_INSPECTIONS.has(inspection.status)) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      continue;
    }
    if (inspection.status !== "success") {
      feedback(feedbackBox, inspection.error_message || "识别未完成。请确认 VPS Listener 在线，并检查 Telegram 账号连接。", "error");
      return;
    }

    const result = inspection.result || {};
    const buttons = Array.isArray(result.buttons)
      ? [...new Set(result.buttons.map((value) => String(value || "").trim()).filter(Boolean))]
      : [];
    const suggested = String(result.suggested_button_text || "").trim();
    resultBox.innerHTML = `<div class="notice mt-sm"><span aria-hidden="true">i</span><span><strong>机器人回复</strong><br>${escapeHtml(result.reply_text || "未返回文字内容")}</span></div>
      ${buttons.length ? `<div class="field mt-sm"><label>检测到的按钮</label><div class="actions">${buttons.map((label) => `<button type="button" class="button small ghost" data-bot-inspection-action="use-button" data-button-text="${escapeHtml(label)}">${escapeHtml(label)}</button>`).join("")}</div><p class="field-help">系统会自动采用建议按钮；也可以点击其他按钮替换。</p></div>` : '<p class="field-help mt-sm">没有检测到内联按钮。这个机器人可能只需要发送命令，或需要修改命令后重新识别。</p>'}`;

    if (suggested && buttons.includes(suggested)) {
      await applyInspectedButton(form, suggested, feedbackBox, { automatic: true });
    } else if (buttons.length === 1) {
      await applyInspectedButton(form, buttons[0], feedbackBox, { automatic: true });
    } else if (result.reply_received) {
      feedback(feedbackBox, buttons.length ? "已读取机器人回复，请选择需要点击的按钮。" : "已读取机器人回复，但没有发现按钮。", "success");
    } else {
      feedback(feedbackBox, "命令已发送，但等待时间内没有收到机器人回复。", "info");
    }
    return;
  }
  feedback(feedbackBox, "识别等待超时。VPS Listener 可能尚未上线、正在重连或任务排队中。", "error");
}

async function inspectBot(button) {
  const form = button.closest("#task-form");
  const controls = form?.querySelector("[data-bot-inspection-controls]");
  if (!form || !controls) return;

  const accountId = String(form.elements.namedItem("account_id")?.value || "");
  const target = String(form.elements.namedItem("bot")?.value || "").trim();
  const startCommand = String(form.elements.namedItem("command")?.value || "").trim() || "/start";
  const feedbackBox = controls.querySelector("[data-inspection-feedback]");
  if (!accountId || !target) {
    feedback(feedbackBox, "请先选择 Telegram 账号，并填写机器人用户名或 Chat ID。", "error");
    return;
  }

  button.disabled = true;
  const label = button.textContent;
  button.textContent = "正在识别…";
  controls.querySelector("[data-inspection-result]").innerHTML = "";
  try {
    const inspection = await request("/api/v1/bot-inspections", {
      method: "POST",
      body: {
        account_id: accountId,
        target,
        start_command: startCommand,
        wait_seconds: 30,
      },
    });
    feedback(feedbackBox, "识别任务已提交。平台正在读取机器人回复，请保持此窗口打开。", "info");
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

function refresh() {
  ensureUniversalInspectionControls();
}

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-bot-inspection-action]");
  if (!button) return;
  const action = button.dataset.botInspectionAction;
  if (action === "inspect") return inspectBot(button);
  if (action === "use-button") {
    const form = button.closest("#task-form");
    const controls = form?.querySelector("[data-bot-inspection-controls]");
    return applyInspectedButton(
      form,
      button.dataset.buttonText || "",
      controls?.querySelector("[data-inspection-feedback]"),
    );
  }
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
queueMicrotask(refresh);
