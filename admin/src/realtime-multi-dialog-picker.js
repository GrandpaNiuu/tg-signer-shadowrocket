const documentRef = globalThis.document;
const API_PATH = "/api/v1/account-dialogs";
const REFRESH_PATH = "/api/v1/account-dialogs/refresh";
const FORM_SELECTOR = "#skill-hub-realtime-form";
const ACCOUNT_SELECTOR = "#hub-rule-account";
const TARGET_SELECTOR = "#hub-rule-chat";
const POLL_DELAY_MS = 1_500;
const POLL_ATTEMPTS = 24;
const FILTER_ALL = "all";
const FILTER_SELECTED = "selected";
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
  return output;
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
      help: "点击任意好友或群组即可自由组合多选。类型按钮只用于筛选，不会限制已选对象。",
      wildcard: "全部可回复会话",
      allowedTypes: new Set(["private", "group", "supergroup"]),
      writableOnly: true,
      empty: "同步完成，但没有找到可自动回复的好友或群组。",
    };
  }
  return {
    title: "选择监听会话",
    label: "监听范围",
    help: "好友、机器人、群组、超级群组和频道可以任意混合多选。类型按钮只用于筛选。",
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

function cleanDialogTitle(value) {
  return String(value || "")
    .replace(/\s*·\s*(?:好友|机器人|群组|超级群组|频道)(?:（只读）)?\s*$/u, "")
    .trim();
}

function safeLabel(dialog) {
  const title = cleanDialogTitle(dialog?.title || dialog?.label || "会话名称未公开");
  const username = String(dialog?.username || "").replace(/^@/, "").trim();
  if (!username || title.toLocaleLowerCase().includes(`@${username.toLocaleLowerCase()}`)) return title;
  return `${title}（@${username}）`;
}

function syncLabel(sync) {
  const state = String(sync?.status || "");
  if (state === "queued") return "正在等待 Listener 同步…";
  if (state === "running") return "正在读取该账号的会话目录…";
  if (state === "success") return `已同步 ${Math.max(0, Number(sync?.dialog_count || 0))} 个会话`;
  if (state === "failed") return String(sync?.error_message || "同步失败，请重新刷新。");
  if (state === "expired") return "上次同步超时，请重新刷新。";
  return "尚未同步该账号的会话目录。";
}

export function dialogMatchesFilter(dialog, {
  config,
  query = "",
  typeFilter = FILTER_ALL,
  selected = new Set(),
} = {}) {
  if (!dialogAllowed(dialog, config)) return false;
  const target = String(dialog?.target || "");
  if (typeFilter === FILTER_SELECTED && !selected.has(target)) return false;
  if (![FILTER_ALL, FILTER_SELECTED].includes(typeFilter)
    && String(dialog?.peer_type || "") !== typeFilter) return false;
  const normalizedQuery = String(query || "").trim().toLocaleLowerCase();
  if (!normalizedQuery) return true;
  return [dialog.label, dialog.title, dialog.username, TYPE_LABELS[dialog.peer_type], target]
    .filter(Boolean)
    .some((value) => String(value).toLocaleLowerCase().includes(normalizedQuery));
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
      <button class="button small ghost" type="button" data-multi-refresh>刷新会话</button>
    </div>
    <input class="realtime-multi-search" type="search" inputmode="search" autocomplete="off" placeholder="搜索名称或 @用户名" aria-label="搜索 Telegram 会话">
    <div class="realtime-multi-filters" data-multi-filters aria-label="筛选会话类型"></div>
    <div class="realtime-multi-summary">
      <span data-multi-count>尚未选择会话</span>
      <button class="button small ghost" type="button" data-multi-clear>清空已选</button>
    </div>
    <label class="realtime-multi-wildcard"><input type="checkbox" value="*" data-multi-wildcard> <span><strong>${config.wildcard}</strong><small>选中后覆盖所有具体会话</small></span></label>
    <div class="realtime-multi-list" data-multi-list aria-label="可自由多选的 Telegram 会话"></div>
    <p class="realtime-multi-status" data-state="idle" aria-live="polite">请先选择 Telegram 账号。</p>
    <details class="realtime-multi-manual">
      <summary>高级：手动补充用户名或 Chat ID</summary>
      <textarea rows="4" maxlength="32000" placeholder="每行填写一个 @用户名或数字 Chat ID"></textarea>
      <p>每行一个目标，也可以使用英文逗号分隔；可与列表中的任意会话混合保存。</p>
    </details>`;
  field?.append(root);

  const refreshButton = root.querySelector("[data-multi-refresh]");
  const searchInput = root.querySelector(".realtime-multi-search");
  const filters = root.querySelector("[data-multi-filters]");
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
    typeFilter: FILTER_ALL,
  };

  function setStatus(message, statusState = "idle") {
    status.textContent = message;
    status.dataset.state = statusState;
  }

  function allowedDialogs() {
    return state.dialogs.filter((dialog) => dialogAllowed(dialog, config));
  }

  function updateSummary() {
    wildcardInput.checked = state.selected.has("*");
    const concreteCount = [...state.selected].filter((target) => target !== "*").length;
    count.textContent = state.selected.has("*")
      ? `已选择：${config.wildcard}`
      : concreteCount
        ? `已选 ${concreteCount} 个会话`
        : "尚未选择会话";
    clearButton.disabled = state.selected.size === 0;
    targetInput.setCustomValidity(state.selected.size ? "" : "请至少选择一个会话");
  }

  function renderFilters() {
    const dialogs = allowedDialogs();
    const filterEntries = [
      [FILTER_ALL, "全部", dialogs.length],
      [FILTER_SELECTED, "已选", [...state.selected].filter((target) => target !== "*").length],
      ...Object.entries(TYPE_LABELS)
        .filter(([type]) => config.allowedTypes.has(type))
        .map(([type, typeLabel]) => [
          type,
          typeLabel,
          dialogs.filter((dialog) => String(dialog.peer_type || "") === type).length,
        ]),
    ];
    filters.replaceChildren();
    for (const [value, text, total] of filterEntries) {
      const button = documentRef.createElement("button");
      button.type = "button";
      button.className = "realtime-multi-filter";
      button.dataset.multiFilter = value;
      button.dataset.active = state.typeFilter === value ? "true" : "false";
      button.setAttribute("aria-pressed", state.typeFilter === value ? "true" : "false");
      button.textContent = `${text} ${total}`;
      filters.append(button);
    }
  }

  function commitSelected({ renderList = false } = {}) {
    const normalized = normalizeSelectedTargets([...state.selected]);
    state.selected = new Set(normalized);
    dispatchValue(targetInput, serializeSelectedTargets(normalized));
    updateSummary();
    renderFilters();
    if (renderList) renderDialogs({ preserveScroll: true });
  }

  function matchingDialogs() {
    return state.dialogs.filter((dialog) => dialogMatchesFilter(dialog, {
      config,
      query: searchInput.value,
      typeFilter: state.typeFilter,
      selected: state.selected,
    }));
  }

  function makeChoice(dialog, unknown = false) {
    const target = String(dialog.target || "");
    const labelElement = documentRef.createElement("label");
    labelElement.className = "realtime-multi-choice";
    labelElement.dataset.selected = state.selected.has(target) ? "true" : "false";

    const checkbox = documentRef.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = target;
    checkbox.checked = state.selected.has(target);
    checkbox.dataset.multiTarget = target;

    const text = documentRef.createElement("span");
    const strong = documentRef.createElement("strong");
    strong.textContent = unknown ? `${target}（目录中暂未找到）` : safeLabel(dialog);
    const small = documentRef.createElement("small");
    small.textContent = unknown
      ? "已保存的手动目标"
      : `${TYPE_LABELS[dialog.peer_type] || "会话"}${dialog.username ? ` · @${String(dialog.username).replace(/^@/, "")}` : ""}${dialog.is_writable === false ? " · 只读" : ""}`;
    text.append(strong, small);
    labelElement.append(checkbox, text);
    return labelElement;
  }

  function unknownTargets() {
    const knownTargets = new Set(state.dialogs.map((dialog) => String(dialog.target || "")));
    return [...state.selected].filter((target) => target !== "*" && !knownTargets.has(target));
  }

  function unknownMatches(target) {
    if (![FILTER_ALL, FILTER_SELECTED].includes(state.typeFilter)) return false;
    const query = String(searchInput.value || "").trim().toLocaleLowerCase();
    return !query || target.toLocaleLowerCase().includes(query);
  }

  function renderDialogs({ preserveScroll = false } = {}) {
    const scrollTop = preserveScroll ? list.scrollTop : 0;
    list.replaceChildren();

    const dialogs = matchingDialogs();
    const manualTargets = unknownTargets().filter(unknownMatches);
    for (const target of manualTargets) list.append(makeChoice({ target }, true));
    for (const dialog of dialogs) list.append(makeChoice(dialog));

    if (!list.children.length) {
      const empty = documentRef.createElement("p");
      empty.className = "realtime-multi-empty";
      empty.textContent = state.typeFilter === FILTER_SELECTED
        ? "还没有选择任何具体会话。"
        : searchInput.value
          ? "没有符合搜索条件的会话。"
          : "当前筛选条件下没有可选择的会话。";
      list.append(empty);
    }

    if (preserveScroll) queueMicrotask(() => { list.scrollTop = scrollTop; });
    updateSummary();
  }

  function applyDirectory(data) {
    state.dialogs = Array.isArray(data?.dialogs) ? data.dialogs : [];
    renderFilters();
    renderDialogs();
    const sync = data?.sync || null;
    const syncState = String(sync?.status || "idle");
    setStatus(syncLabel(sync), syncState);
    const usable = allowedDialogs().length;
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
      renderFilters();
      renderDialogs();
      setStatus("请先选择 Telegram 账号。", "idle");
      return;
    }
    refreshButton.disabled = false;
    searchInput.disabled = false;
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
      renderFilters();
      renderDialogs();
      setStatus(error instanceof Error ? error.message : "会话目录读取失败。", "failed");
    }
  }

  wildcardInput.addEventListener("change", () => {
    state.selected = wildcardInput.checked ? new Set(["*"]) : new Set();
    commitSelected({ renderList: true });
  });

  list.addEventListener("change", (event) => {
    const checkbox = event.target.closest("[data-multi-target]");
    if (!checkbox) return;
    const target = String(checkbox.dataset.multiTarget || "");
    state.selected.delete("*");
    wildcardInput.checked = false;
    if (checkbox.checked) state.selected.add(target);
    else state.selected.delete(target);

    const row = checkbox.closest(".realtime-multi-choice");
    if (row) row.dataset.selected = checkbox.checked ? "true" : "false";
    commitSelected({ renderList: state.typeFilter === FILTER_SELECTED });
  });

  filters.addEventListener("click", (event) => {
    const button = event.target.closest("[data-multi-filter]");
    if (!button) return;
    state.typeFilter = String(button.dataset.multiFilter || FILTER_ALL);
    renderFilters();
    renderDialogs();
  });

  clearButton.addEventListener("click", () => {
    state.selected.clear();
    commitSelected({ renderList: true });
  });

  manualInput.addEventListener("input", () => {
    const parsed = parseSelectedTargets(manualInput.value);
    const invalid = parsed.filter((value) => !TARGET_PATTERN.test(value));
    if (invalid.length) {
      setStatus("手动目标中包含无效的用户名或 Chat ID。", "failed");
      return;
    }
    state.selected = new Set(normalizeSelectedTargets(parsed));
    commitSelected({ renderList: true });
  });

  manual.addEventListener("toggle", () => {
    if (manual.open) manualInput.value = [...state.selected].filter((value) => value !== "*").join("\n");
  });

  searchInput.addEventListener("input", () => renderDialogs());
  refreshButton.addEventListener("click", refreshDirectory);
  accountInput.addEventListener("change", () => {
    searchInput.value = "";
    state.typeFilter = FILTER_ALL;
    state.selected = new Set(["*"]);
    commitSelected({ renderList: true });
    loadDirectory({ autoRefresh: true });
  });
  form.addEventListener("reset", () => queueMicrotask(() => {
    state.selected = new Set(normalizeSelectedTargets(parseSelectedTargets(targetInput.value || "*")));
    state.typeFilter = FILTER_ALL;
    searchInput.value = "";
    manualInput.value = "";
    loadDirectory({ autoRefresh: false });
  }));

  commitSelected({ renderList: true });
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
  FILTER_ALL,
  FILTER_SELECTED,
  FORM_SELECTOR,
  REFRESH_PATH,
  TARGET_PATTERN,
  TYPE_LABELS,
  dialogAllowed,
  presentation,
  safeLabel,
  serializeSelectedTargets,
  syncLabel,
};
