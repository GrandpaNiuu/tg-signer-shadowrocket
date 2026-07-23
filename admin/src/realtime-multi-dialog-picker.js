const documentRef = globalThis.document;
const API_PATH = "/api/v1/account-dialogs";
const REFRESH_PATH = "/api/v1/account-dialogs/refresh";
const FORM_SELECTOR = "#skill-hub-realtime-form";
const ACCOUNT_SELECTOR = "#hub-rule-account";
const TARGET_SELECTOR = "#hub-rule-chat";
const POLL_DELAY_MS = 1_500;
const POLL_ATTEMPTS = 24;
const MAX_SELECTED = 50;
const TARGET_PATTERN = /^(?:\*|@[A-Za-z][A-Za-z0-9_]{3,31}|-?\d{1,20})$/;

const TYPE_LABELS = Object.freeze({
  private: "好友",
  bot: "机器人",
  group: "群组",
  supergroup: "超级群组",
  channel: "频道",
});

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

export function parseSelectedTargets(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  const source = String(value || "").trim();
  if (!source) return [];
  if (source.startsWith("[")) {
    try {
      const parsed = JSON.parse(source);
      if (Array.isArray(parsed)) return parsed.map((item) => String(item || "").trim()).filter(Boolean);
    } catch {
      // Continue with comma/newline parsing.
    }
  }
  return source.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean);
}

export function normalizeSelectedTargets(values) {
  const output = [];
  const seen = new Set();
  for (const rawValue of values || []) {
    const value = String(rawValue || "").trim();
    if (!value) continue;
    const key = value.startsWith("@") ? value.toLowerCase() : value;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }
  if (output.includes("*")) return ["*"];
  return output.slice(0, MAX_SELECTED);
}

export function serializeSelectedTargets(values) {
  const normalized = normalizeSelectedTargets(values);
  if (!normalized.length) return "";
  return normalized.length === 1 ? normalized[0] : normalized.join(",");
}

function dispatchValue(input, value) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function presentation(kind) {
  if (kind === "keyword_reply") {
    return {
      title: "选择自动回复对象",
      label: "自动回复对象",
      help: "可以同时选择多个好友、群组或超级群组；只会在已选择会话中自动回复。选择“全部可回复会话”时不能再选择具体会话。",
      wildcard: "全部可回复会话",
      allowedTypes: new Set(["private", "group", "supergroup"]),
      writableOnly: true,
      empty: "同步完成，但没有找到可自动回复的好友或群组。",
    };
  }
  return {
    title: "选择监听会话",
    label: "监听范围",
    help: "可以同时选择多个好友、机器人、群组、超级群组或频道；只监听已选择的会话。选择“全部会话”时不能再选择具体会话。",
    wildcard: "全部会话",
    allowedTypes: new Set(["private", "bot", "group", "supergroup", "channel"]),
    writableOnly: false,
    empty: "同步完成，但没有找到可监听的会话。",
  };
}

function dialogAllowed(dialog, config) {
  const type = String(dialog?.peer_type || "");
  if (!config.allowedTypes.has(type)) return false;
  if (config.writableOnly && dialog?.is_writable === false) return false;
  return true;
}

function safeLabel(dialog) {
  const label = String(dialog?.label || dialog?.title || "会话名称未公开").trim();
  return `${label}${dialog?.is_writable === false ? "（只读）" : ""}`;
}

function syncLabel(sync) {
  const state = String(sync?.status || "");
  if (state === "queued") return "正在等待 Listener 同步…";
  if (state === "running") return "正在读取该账号的好友和群组…";
  if (state === "success") return `已同步 ${Math.max(0, Number(sync?.dialog_count || 0))} 个会话`;
  if (state === "failed") return String(sync?.error_message || "同步失败，请重新刷新。");
  if (state === "expired") return "上次同步超时，请重新刷新。";
  return "尚未同步该账号的会话目录。";
}

function enhance(form, accountInput, targetInput) {
  if (targetInput.dataset.realtimeMultiEnhanced === "true") return;
  targetInput.dataset.realtimeMultiEnhanced = "true";
  targetInput.dataset.dialogPickerEnhanced = "true";
  targetInput.type = "hidden";
  targetInput.removeAttribute("maxlength");
  targetInput.removeAttribute("placeholder");

  const config = presentation(String(form.dataset.kind || ""));
  const field = targetInput.closest(".field") || targetInput.parentElement;
  const label = field?.querySelector(`label[for="${targetInput.id}"]`);
  const help = field?.querySelector(".field-help");
  if (label) {
    label.textContent = config.label;
    label.classList.add("required");
  }
  if (help) help.textContent = config.help;

  const root = documentRef.createElement("div");
  root.className = "realtime-multi-picker";
  root.innerHTML = `
    <div class="realtime-multi-head">
      <div><strong>${config.title}</strong><small>${config.help}</small></div>
      <button class="button small ghost" type="button" data-multi-refresh>刷新好友与群组</button>
    </div>
    <input class="realtime-multi-search" type="search" inputmode="search" autocomplete="off" placeholder="搜索名称、@用户名或会话类型" aria-label="搜索 Telegram 会话">
    <div class="realtime-multi-actions">
      <button class="button small ghost" type="button" data-multi-select-visible>选择当前结果</button>
      <button class="button small ghost" type="button" data-multi-clear>清空选择</button>
      <span data-multi-count>尚未选择会话</span>
    </div>
    <label class="realtime-multi-wildcard"><input type="checkbox" value="*" data-multi-wildcard> <span><strong>${config.wildcard}</strong><small>该选项与具体会话互斥</small></span></label>
    <div class="realtime-multi-list" data-multi-list aria-label="可选择的 Telegram 会话"></div>
    <p class="realtime-multi-status" data-state="idle" aria-live="polite">请先选择 Telegram 账号。</p>
    <details class="realtime-multi-manual">
      <summary>高级：手动补充用户名或 Chat ID</summary>
      <textarea rows="4" maxlength="4096" placeholder="每行填写一个 @用户名或数字 Chat ID"></textarea>
      <p>每行一个目标，也可以使用英文逗号分隔。最多选择 ${MAX_SELECTED} 个会话。</p>
    </details>`;
  field?.append(root);

  const refreshButton = root.querySelector("[data-multi-refresh]");
  const searchInput = root.querySelector(".realtime-multi-search");
  const selectVisibleButton = root.querySelector("[data-multi-select-visible]");
  const clearButton = root.querySelector("[data-multi-clear]");
  const count = root.querySelector("[data-multi-count]");
  const wildcardInput = root.querySelector("[data-multi-wildcard]");
  const list = root.querySelector("[data-multi-list]");
  const status = root.querySelector(".realtime-multi-status");
  const manual = root.querySelector(".realtime-multi-manual");
  const manualInput = manual.querySelector("textarea");

  const state = {
    dialogs: [],
    selected: new Set(normalizeSelectedTargets(parseSelectedTargets(targetInput.value || "*"))),
    accountId: "",
    requestVersion: 0,
    autoRequested: new Set(),
  };

  function setStatus(message, statusState = "idle") {
    status.textContent = message;
    status.dataset.state = statusState;
  }

  function commitSelected({ render = true } = {}) {
    const normalized = normalizeSelectedTargets([...state.selected]);
    state.selected = new Set(normalized);
    dispatchValue(targetInput, serializeSelectedTargets(normalized));
    if (render) renderDialogs();
  }

  function matchingDialogs() {
    const query = String(searchInput.value || "").trim().toLocaleLowerCase();
    return state.dialogs.filter((dialog) => {
      if (!dialogAllowed(dialog, config)) return false;
      if (!query) return true;
      return [dialog.label, dialog.title, dialog.username, TYPE_LABELS[dialog.peer_type], dialog.target]
        .filter(Boolean)
        .some((value) => String(value).toLocaleLowerCase().includes(query));
    });
  }

  function makeChoice(dialog, unknown = false) {
    const target = String(dialog.target || "");
    const labelElement = documentRef.createElement("label");
    labelElement.className = "realtime-multi-choice";
    const checkbox = documentRef.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = target;
    checkbox.checked = state.selected.has(target);
    checkbox.dataset.multiTarget = target;
    const text = documentRef.createElement("span");
    const strong = documentRef.createElement("strong");
    strong.textContent = unknown ? `${target}（目录中暂未找到）` : safeLabel(dialog);
    const small = documentRef.createElement("small");
    small.textContent = unknown ? "保留已保存目标" : `${TYPE_LABELS[dialog.peer_type] || "会话"}${dialog.username ? ` · @${dialog.username}` : ""}`;
    text.append(strong, small);
    labelElement.append(checkbox, text);
    return labelElement;
  }

  function renderDialogs() {
    wildcardInput.checked = state.selected.has("*");
    list.replaceChildren();
    const dialogs = matchingDialogs();

    for (const [type, typeLabel] of Object.entries(TYPE_LABELS)) {
      const matches = dialogs.filter((dialog) => String(dialog.peer_type) === type);
      if (!matches.length) continue;
      const group = documentRef.createElement("fieldset");
      const legend = documentRef.createElement("legend");
      legend.textContent = `${typeLabel}（${matches.length}）`;
      group.append(legend);
      for (const dialog of matches) group.append(makeChoice(dialog));
      list.append(group);
    }

    const knownTargets = new Set(state.dialogs.map((dialog) => String(dialog.target || "")));
    const unknownTargets = [...state.selected].filter((target) => target !== "*" && !knownTargets.has(target));
    if (unknownTargets.length) {
      const group = documentRef.createElement("fieldset");
      const legend = documentRef.createElement("legend");
      legend.textContent = `已保存目标（${unknownTargets.length}）`;
      group.append(legend);
      for (const target of unknownTargets) group.append(makeChoice({ target }, true));
      list.append(group);
    }

    if (!list.children.length) {
      const empty = documentRef.createElement("p");
      empty.className = "realtime-multi-empty";
      empty.textContent = searchInput.value ? "没有符合搜索条件的会话。" : "当前没有可选择的会话。";
      list.append(empty);
    }

    const selectedCount = state.selected.has("*") ? "全部" : state.selected.size;
    count.textContent = state.selected.has("*")
      ? `已选择${config.wildcard}`
      : `已选择 ${selectedCount} 个会话（最多 ${MAX_SELECTED} 个）`;
    targetInput.setCustomValidity(state.selected.size ? "" : "请至少选择一个会话");
  }

  function applyDirectory(data) {
    state.dialogs = Array.isArray(data?.dialogs) ? data.dialogs : [];
    renderDialogs();
    const sync = data?.sync || null;
    const syncState = String(sync?.status || "idle");
    setStatus(syncLabel(sync), syncState);
    const usable = state.dialogs.filter((dialog) => dialogAllowed(dialog, config)).length;
    if (syncState === "success" && usable === 0) setStatus(config.empty, "success");
    return { sync, usable };
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
    setStatus("同步仍在进行，可以稍后再次刷新。", "running");
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
    refreshButton.disabled = true;
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
      if (requestVersion === state.requestVersion) refreshButton.disabled = false;
    }
  }

  async function loadDirectory({ autoRefresh = false } = {}) {
    const accountId = String(accountInput.value || "").trim();
    state.accountId = accountId;
    const requestVersion = ++state.requestVersion;
    if (!accountId) {
      state.dialogs = [];
      refreshButton.disabled = true;
      searchInput.disabled = true;
      selectVisibleButton.disabled = true;
      renderDialogs();
      setStatus("请先选择 Telegram 账号。", "idle");
      return;
    }
    refreshButton.disabled = false;
    searchInput.disabled = false;
    selectVisibleButton.disabled = false;
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
      state.dialogs = [];
      renderDialogs();
      setStatus(error instanceof Error ? error.message : "会话目录读取失败。", "failed");
    }
  }

  wildcardInput.addEventListener("change", () => {
    if (wildcardInput.checked) state.selected = new Set(["*"]);
    else state.selected.delete("*");
    commitSelected();
  });

  list.addEventListener("change", (event) => {
    const checkbox = event.target.closest("[data-multi-target]");
    if (!checkbox) return;
    const target = String(checkbox.dataset.multiTarget || "");
    state.selected.delete("*");
    if (checkbox.checked) {
      if (state.selected.size >= MAX_SELECTED) {
        checkbox.checked = false;
        setStatus(`每条规则最多选择 ${MAX_SELECTED} 个会话。`, "failed");
        return;
      }
      state.selected.add(target);
    } else {
      state.selected.delete(target);
    }
    commitSelected();
  });

  selectVisibleButton.addEventListener("click", () => {
    const targets = matchingDialogs().map((dialog) => String(dialog.target || "")).filter(Boolean);
    state.selected = new Set(normalizeSelectedTargets(targets));
    commitSelected();
    if (targets.length > MAX_SELECTED) setStatus(`当前结果超过 ${MAX_SELECTED} 个，仅选择前 ${MAX_SELECTED} 个。`, "failed");
  });

  clearButton.addEventListener("click", () => {
    state.selected.clear();
    commitSelected();
  });

  manualInput.addEventListener("input", () => {
    const parsed = parseSelectedTargets(manualInput.value);
    const invalid = parsed.filter((value) => !TARGET_PATTERN.test(value));
    if (invalid.length) {
      setStatus("手动目标中包含无效的用户名或 Chat ID。", "failed");
      return;
    }
    state.selected = new Set(normalizeSelectedTargets(parsed));
    commitSelected();
  });

  manual.addEventListener("toggle", () => {
    if (manual.open) manualInput.value = [...state.selected].filter((value) => value !== "*").join("\n");
  });

  searchInput.addEventListener("input", renderDialogs);
  refreshButton.addEventListener("click", refreshDirectory);
  accountInput.addEventListener("change", () => {
    searchInput.value = "";
    state.selected = new Set(["*"]);
    commitSelected();
    loadDirectory({ autoRefresh: true });
  });
  form.addEventListener("reset", () => queueMicrotask(() => {
    state.selected = new Set(normalizeSelectedTargets(parseSelectedTargets(targetInput.value || "*")));
    searchInput.value = "";
    manualInput.value = "";
    loadDirectory({ autoRefresh: false });
  }));

  commitSelected();
  loadDirectory({ autoRefresh: true });
}

function enhanceAll() {
  const form = documentRef?.querySelector(FORM_SELECTOR);
  const account = form?.querySelector(ACCOUNT_SELECTOR);
  const target = form?.querySelector(TARGET_SELECTOR);
  if (form && account && target) enhance(form, account, target);
}

if (documentRef) {
  enhanceAll();
  const observer = new MutationObserver(enhanceAll);
  observer.observe(documentRef.body, { childList: true, subtree: true });
}

export const __test = {
  API_PATH,
  FORM_SELECTOR,
  MAX_SELECTED,
  REFRESH_PATH,
  TARGET_PATTERN,
  TYPE_LABELS,
  dialogAllowed,
  presentation,
  safeLabel,
  serializeSelectedTargets,
  syncLabel,
};
