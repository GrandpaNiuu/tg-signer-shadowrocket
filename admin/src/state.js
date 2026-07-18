export const ROUTES = Object.freeze(["dashboard", "accounts", "tasks", "skills", "runs", "sessions", "settings"]);

export function routeFromHash(hash = "") {
  const route = hash.replace(/^#?\/?/, "").split(/[/?]/)[0];
  return ROUTES.includes(route) ? route : "dashboard";
}

export function createStore(initial = {}) {
  let state = {
    route: "dashboard",
    loading: false,
    accounts: [],
    tasks: [],
    skills: [],
    runs: [],
    settings: {},
    dashboard: null,
    filters: {},
    ...initial,
  };
  const listeners = new Set();

  return {
    get: () => state,
    set(patch) {
      const next = typeof patch === "function" ? patch(state) : patch;
      state = { ...state, ...next };
      listeners.forEach((listener) => listener(state));
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function listFrom(value, candidateKeys = []) {
  if (Array.isArray(value)) return value;
  for (const key of ["items", ...candidateKeys]) {
    if (Array.isArray(value?.[key])) return value[key];
  }
  return [];
}

export function needsTelegramApplicationSetup(settings = {}) {
  if (settings.telegram_application_source === "global"
    || settings.telegram_application_source === "legacy_account") return false;
  return settings.telegram_application_configured !== true;
}

export function filterRows(rows, { query = "", status = "", accountId = "", taskId = "" } = {}) {
  const needle = query.trim().toLocaleLowerCase("zh-CN");
  return rows.filter((row) => {
    if (status && row.status !== status) return false;
    if (accountId && String(row.account_id) !== String(accountId)) return false;
    if (taskId && String(row.task_id) !== String(taskId)) return false;
    if (!needle) return true;
    const haystack = [row.name, row.bot, row.command, row.username, row.phone_masked, row.skill_key, row.error_message]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase("zh-CN");
    return haystack.includes(needle);
  });
}
