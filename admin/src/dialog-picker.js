const documentRef = globalThis.document;
const API_PATH = "/api/v1/account-dialogs";
const REFRESH_PATH = "/api/v1/account-dialogs/refresh";
const MANUAL_VALUE = "__manual_target__";
const POLL_DELAY_MS = 1_500;
const POLL_ATTEMPTS = 24;
const REALTIME_FORM = "#skill-hub-realtime-form";
const AUTO_REPLY_TYPES = Object.freeze(["private", "group", "supergroup"]);

const TYPE_LABELS = Object.freeze({
  private: "好友",
  bot: "机器人",
  group: "群组",
  supergroup: "超级群组",
  channel: "频道",
});

const PICKERS = Object.freeze([
  {
    form: "#task-form",
    account: "#task-account",
    target: "#task-bot",
    title: "选择发送对象",
    help: "先选择 Telegram 账号，系统会自动列出该账号的好友、机器人、群组和频道。",
    placeholder: "选择好友、群组、频道或机器人",
    writableOnly: true,
    wildcard: false,
  },
  {
    form: REALTIME_FORM,
    account: "#hub-rule-account",
    target: "#hub-rule-chat",
    realtime: true,
    wildcard: true,
  },
]);

function realtimePickerPresentation(kind) {
  if (kind === "keyword_reply") {
    return {
      title: "选择自动回复对象",
      fieldLabel: "自动回复对象",
      fieldHelp: "可选择一个好友、群组或超级群组；选择“全部可回复会话”后，所有符合触发条件的真人消息都会自动回复。机器人、频道身份和账号自身消息仍会被安全过滤。",
      help: "选择 Telegram 账号后，可从会话目录中指定自动回复对象，也可以选择全部可回复会话。",
      placeholder: "选择要自动回复的好友或群组",
      wildcardLabel: "全部可回复会话 · 对符合触发条件的真人消息自动回复",
      writableOnly: true,
      allowedTypes: AUTO_REPLY_TYPES,
      emptyMessage: "同步完成，但没有找到可自动回复的好友或群组。请确认该 Telegram 账号已有可发送消息的会话。",
    };
  }
  return {
    title: "选择监听会话",
    fieldLabel: "监听范围",
    fieldHelp: "可选择具体好友、群组、超级群组或频道；选择“全部会话”表示监听该账号收到的所有适用消息。",
    help: "选择 Telegram 账号后，可直接从该账号的会话目录中选择监听范围。",
    placeholder: "选择要监听的好友、群组或频道",
    wildcardLabel: "全部会话 · 监听该账号收到的所有消息",
    writableOnly: false,
    allowedTypes: Object.freeze(["private", "bot", "group", "supergroup", "channel"]),
    emptyMessage: "同步完成，但没有找到可监听的会话。请确认该 Telegram 账号已有好友、群组、机器人或频道对话。",
  };
}

function resolvePickerConfig(config, form) {
  return config.realtime
    ? { ...config, ...realtimePickerPresentation(String(form?.dataset?.kind || "")) }
    : config;
}

function dialogAllowed(dialog, config) {
  const peerType = String(dialog?.peer_type || "");
  if (Array.isArray(config.allowedTypes) && !config.allowedTypes.includes(peerType)) return false;
  if (config.writableOnly && dialog?.is_writable === false) return false;
  return true;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    headers: {
      accept: "application/json",
      ...(options.body ? { "content-type": "application/json" } : {}),
      "x-requested-with": "tg-checkin-admin",
      ...(options.headers || {}),
    },
    ...options,
  });
  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok) {
    const error = new Error(String(payload?.error?.message || "会话目录请求失败，请稍后重试。"));
    error.code = String(payload?.error?.code || "request_failed");
    error.status = response.status;
    throw error;
  }
  return payload?.data ?? payload ?? null;
}

function dispatchValue(input, value) {
  input.value = String(value || "");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function syncLabel(sync) {
  const status = String(sync?.status || "");
  if (status === "queued") return "正在等待 Listener 同步…";
  if (status === "running") return "正在读取该账号的好友和群组…";
  if (status === "success") {
    const count = Math.max(0, Number(sync?.dialog_count || 0));
    return `已同步 ${count} 个会话`;
  }
  if (status === "failed") return String(sync?.error_message || "同步失败，请重新刷新。" );
  if (status === "expired") return "上次同步超时，请重新刷新。";
  return "尚未同步该账号的会话目录。";
}

function safeDialogLabel(dialog) {
  const label = String(dialog?.label || dialog?.title || "会话名称未公开").trim();
  const writable = dialog?.is_writable !== false;
  return `${label}${writable ? "" : "（只读）"}`;
}

function updateFieldCopy(config, targetInput, field) {
  if (!field) return;
  const label = targetInput.id ? field.querySelector(`label[for="${targetInput.id}"]`) : null;
  if (label && config.fieldLabel) {
    label.textContent = config.fieldLabel;
    if (targetInput.required) label.classList.add("required");
  }
  const help = field.querySelector(".field-help");
  if (help && config.fieldHelp) help.textContent = config.fieldHelp;
}

function createPicker(config, form, accountInput, targetInput) {
  if (targetInput.dataset.dialogPickerEnhanced === "true") return;
  targetInput.dataset.dialogPickerEnhanced = "true";

  const originalType = targetInput.type;
  const originalPlaceholder = targetInput.placeholder;
  const initialValue = String(targetInput.value || "").trim();
  const field = targetInput.closest(".field") || targetInput.parentElement;
  updateFieldCopy(config, targetInput, field);
  targetInput.type = "hidden";
  targetInput.removeAttribute("placeholder");
  targetInput.dataset.dialogPickerOriginalType = originalType;

  const root = documentRef.createElement("div");
  root.className = "dialog-picker";
  root.dataset.dialogPicker = config.target;
  root.dataset.dialogPickerKind = String(form?.dataset?.kind || "");
  root.innerHTML = `
    <div class="dialog-picker-head">
      <div class="dialog-picker-title">
        <strong>${config.title}</strong>
        <small>${config.help}</small>
      </div>
      <button class="button small ghost dialog-picker-refresh" type="button" data-dialog-refresh>刷新好友与群组</button>
    </div>
    <input class="dialog-picker-search" type="search" inputmode="search" autocomplete="off" placeholder="搜索名称、@用户名或会话类型" aria-label="搜索 Telegram 会话">
    <select class="dialog-picker-select" required aria-label="${config.title}"></select>
    <p class="dialog-picker-status" data-state="idle" aria-live="polite">请先选择 Telegram 账号。</p>
    <details class="dialog-picker-manual">
      <summary>高级：手动输入用户名或 Chat ID</summary>
      <input type="text" maxlength="128" autocomplete="off" placeholder="${originalPlaceholder || "@username 或 Chat ID"}">
      <p class="dialog-picker-help">仅在目标没有出现在自动目录时使用。一般用户无需查找或填写数字 ID。</p>
    </details>`;

  if (field) field.append(root);
  else targetInput.insertAdjacentElement("afterend", root);

  const search = root.querySelector(".dialog-picker-search");
  const select = root.querySelector(".dialog-picker-select");
  const refresh = root.querySelector("[data-dialog-refresh]");
  const status = root.querySelector(".dialog-picker-status");
  const manualDetails = root.querySelector(".dialog-picker-manual");
  const manualInput = manualDetails.querySelector("input");
  const state = {
    dialogs: [],
    currentValue: initialValue,
    accountId: "",
    requestVersion: 0,
    autoRequested: new Set(),
  };

  function setStatus(message, statusState = "idle") {
    status.textContent = message;
    status.dataset.state = statusState;
  }

  function optionsForQuery() {
    const query = String(search.value || "").trim().toLocaleLowerCase();
    return state.dialogs.filter((dialog) => {
      if (!dialogAllowed(dialog, config)) return false;
      if (!query) return true;
      return [dialog.label, dialog.title, dialog.username, TYPE_LABELS[dialog.peer_type], dialog.target]
        .filter(Boolean)
        .some((value) => String(value).toLocaleLowerCase().includes(query));
    });
  }

  function addOption(parent, value, label, { disabled = false } = {}) {
    const option = documentRef.createElement("option");
    option.value = value;
    option.textContent = label;
    option.disabled = disabled;
    parent.append(option);
    return option;
  }

  function renderOptions() {
    const selected = String(targetInput.value || state.currentValue || "");
    select.replaceChildren();
    addOption(select, "", config.placeholder, { disabled: true });
    if (config.wildcard) addOption(select, "*", config.wildcardLabel || "全部会话");

    const dialogs = optionsForQuery();
    for (const [type, typeLabel] of Object.entries(TYPE_LABELS)) {
      const matches = dialogs.filter((dialog) => dialog.peer_type === type);
      if (!matches.length) continue;
      const group = documentRef.createElement("optgroup");
      group.label = `${typeLabel}（${matches.length}）`;
      for (const dialog of matches) {
        addOption(group, String(dialog.target), safeDialogLabel(dialog), {
          disabled: config.writableOnly && dialog.is_writable === false,
        });
      }
      select.append(group);
    }

    const available = [...select.options].some((option) => option.value === selected);
    if (selected && !available && selected !== MANUAL_VALUE) {
      addOption(select, selected, "当前目标（已保存，目录中暂未找到）");
    }
    addOption(select, MANUAL_VALUE, "其他目标…手动输入");

    if (selected && [...select.options].some((option) => option.value === selected)) {
      select.value = selected;
    } else if (config.wildcard && !selected) {
      select.value = "*";
      dispatchValue(targetInput, "*");
    } else {
      select.value = "";
    }
  }

  function applyDirectory(data) {
    state.dialogs = Array.isArray(data?.dialogs) ? data.dialogs : [];
    renderOptions();
    const sync = data?.sync || null;
    const syncState = String(sync?.status || "idle");
    setStatus(syncLabel(sync), syncState);
    const usable = state.dialogs.filter((dialog) => dialogAllowed(dialog, config)).length;
    if (syncState === "success" && usable === 0) {
      setStatus(config.emptyMessage || "同步完成，但没有找到可选择的会话。", "success");
    }
    return { sync, usable };
  }

  async function loadDirectory({ autoRefresh = false } = {}) {
    const accountId = String(accountInput.value || "").trim();
    state.accountId = accountId;
    const requestVersion = ++state.requestVersion;
    if (!accountId) {
      state.dialogs = [];
      refresh.disabled = true;
      search.disabled = true;
      select.disabled = true;
      renderOptions();
      setStatus("请先选择 Telegram 账号。", "idle");
      return;
    }
    refresh.disabled = false;
    search.disabled = false;
    select.disabled = false;
    setStatus("正在读取会话目录…", "running");
    try {
      const data = await api(`${API_PATH}?account_id=${encodeURIComponent(accountId)}`);
      if (requestVersion !== state.requestVersion || accountId !== state.accountId) return;
      const { sync, usable } = applyDirectory(data);
      if (autoRefresh && usable === 0 && !["queued", "running"].includes(String(sync?.status || ""))
        && !state.autoRequested.has(accountId)) {
        state.autoRequested.add(accountId);
        await refreshDirectory();
      } else if (["queued", "running"].includes(String(sync?.status || ""))) {
        await pollDirectory(requestVersion, accountId);
      }
    } catch (error) {
      if (requestVersion !== state.requestVersion) return;
      setStatus(error instanceof Error ? error.message : "会话目录读取失败。", "failed");
      state.dialogs = [];
      renderOptions();
    }
  }

  async function pollDirectory(requestVersion, accountId) {
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
      await sleep(POLL_DELAY_MS);
      if (requestVersion !== state.requestVersion || accountId !== state.accountId) return;
      try {
        const data = await api(`${API_PATH}?account_id=${encodeURIComponent(accountId)}`);
        if (requestVersion !== state.requestVersion || accountId !== state.accountId) return;
        const { sync } = applyDirectory(data);
        if (!["queued", "running"].includes(String(sync?.status || ""))) return;
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "同步状态读取失败。", "failed");
        return;
      }
    }
    setStatus("同步仍在进行。可以稍后再次打开此表单，或点击“刷新好友与群组”。", "running");
  }

  async function refreshDirectory() {
    const accountId = String(accountInput.value || "").trim();
    if (!accountId) {
      setStatus("请先选择 Telegram 账号。", "failed");
      accountInput.focus();
      return;
    }
    const requestVersion = ++state.requestVersion;
    state.accountId = accountId;
    refresh.disabled = true;
    setStatus("正在提交同步请求…", "queued");
    try {
      const sync = await api(REFRESH_PATH, {
        method: "POST",
        body: JSON.stringify({ account_id: accountId }),
      });
      if (requestVersion !== state.requestVersion) return;
      setStatus(syncLabel(sync), String(sync?.status || "queued"));
      await pollDirectory(requestVersion, accountId);
    } catch (error) {
      if (requestVersion !== state.requestVersion) return;
      setStatus(error instanceof Error ? error.message : "会话目录同步失败。", "failed");
    } finally {
      if (requestVersion === state.requestVersion) refresh.disabled = false;
    }
  }

  select.addEventListener("change", () => {
    if (select.value === MANUAL_VALUE) {
      manualDetails.open = true;
      manualInput.value = String(targetInput.value || "");
      manualInput.focus();
      return;
    }
    manualDetails.open = false;
    state.currentValue = select.value;
    dispatchValue(targetInput, select.value);
  });

  manualInput.addEventListener("input", () => {
    const value = String(manualInput.value || "").trim();
    state.currentValue = value;
    dispatchValue(targetInput, value);
  });

  manualDetails.addEventListener("toggle", () => {
    if (manualDetails.open && String(targetInput.value || "")
      && !state.dialogs.some((dialog) => String(dialog.target) === String(targetInput.value))) {
      manualInput.value = String(targetInput.value || "");
    }
  });

  search.addEventListener("input", renderOptions);
  refresh.addEventListener("click", refreshDirectory);
  accountInput.addEventListener("change", () => {
    search.value = "";
    loadDirectory({ autoRefresh: true });
  });
  form.addEventListener("reset", () => queueMicrotask(() => {
    state.currentValue = String(targetInput.value || "");
    manualInput.value = "";
    search.value = "";
    loadDirectory({ autoRefresh: false });
  }));

  renderOptions();
  loadDirectory({ autoRefresh: true });
}

function enhance() {
  for (const config of PICKERS) {
    const form = documentRef?.querySelector(config.form);
    const account = form?.querySelector(config.account) || documentRef?.querySelector(config.account);
    const target = form?.querySelector(config.target) || documentRef?.querySelector(config.target);
    if (form && account && target) createPicker(resolvePickerConfig(config, form), form, account, target);
  }
}

if (documentRef) {
  enhance();
  const observer = new MutationObserver(enhance);
  observer.observe(documentRef.body, { childList: true, subtree: true });
}

export const __test = {
  API_PATH,
  AUTO_REPLY_TYPES,
  MANUAL_VALUE,
  PICKERS,
  REALTIME_FORM,
  REFRESH_PATH,
  TYPE_LABELS,
  dialogAllowed,
  realtimePickerPresentation,
  resolvePickerConfig,
  safeDialogLabel,
  syncLabel,
};
