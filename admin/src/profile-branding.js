const PROFILE_ENDPOINT = "/api/v1/profile";
const PLATFORM_ENDPOINT = "/api/v1/admin/platform-branding";
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_RESULT_BYTES = 92 * 1024;
const ACCEPTED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

const state = {
  loaded: false,
  loading: null,
  profile: null,
  platform: { avatar_data_url: null },
  personalAvatar: null,
  platformAvatar: null,
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function errorMessage(error) {
  return error instanceof Error && error.message ? error.message : "操作失败，请稍后再试。";
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    ...options,
    headers: {
      accept: "application/json",
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error?.message || `请求失败（HTTP ${response.status}）`);
  return payload?.data ?? payload;
}

function initials(name, fallback = "U") {
  const text = String(name || "").trim();
  if (!text) return fallback;
  return Array.from(text)[0].toUpperCase();
}

function applyAvatar(element, dataUrl, fallback) {
  if (!element) return;
  if (dataUrl) {
    element.style.backgroundImage = `url(${JSON.stringify(dataUrl).slice(1, -1)})`;
    element.style.backgroundSize = "cover";
    element.style.backgroundPosition = "center";
    element.textContent = "";
    element.classList.add("has-custom-avatar");
  } else {
    element.style.removeProperty("background-image");
    element.style.removeProperty("background-size");
    element.style.removeProperty("background-position");
    element.textContent = fallback;
    element.classList.remove("has-custom-avatar");
  }
}

function applyPlatformBranding(platform = state.platform) {
  state.platform = platform || { avatar_data_url: null };
  const avatar = state.platform.avatar_data_url || null;
  document.querySelectorAll(".brand-mark").forEach((element) => applyAvatar(element, avatar, "T"));
  let favicon = document.querySelector('link[rel="icon"][data-platform-avatar]');
  if (avatar) {
    if (!favicon) {
      favicon = document.createElement("link");
      favicon.rel = "icon";
      favicon.dataset.platformAvatar = "true";
      document.head.append(favicon);
    }
    favicon.href = avatar;
  } else {
    favicon?.remove();
  }
}

function applyPersonalProfile(profile = state.profile) {
  if (!profile) return;
  state.profile = profile;
  const name = profile.display_name || "用户";
  const nameElement = document.querySelector("#identity-name");
  if (nameElement && nameElement.textContent !== name) nameElement.textContent = name;
  applyAvatar(document.querySelector(".topbar .avatar"), profile.avatar_data_url, initials(name, "U"));
  if (location.hash.startsWith("#/dashboard")) {
    const title = document.querySelector("#view .page-head h1");
    if (title && /工作区/.test(title.textContent || "")) title.textContent = `${name} 的工作区`;
  }
}

async function loadPublicBranding() {
  try {
    const platform = await request("/api/branding");
    applyPlatformBranding(platform || { avatar_data_url: null });
  } catch {
    applyPlatformBranding({ avatar_data_url: null });
  }
}

async function loadProfile({ force = false } = {}) {
  if (state.loaded && !force) return state;
  if (state.loading && !force) return state.loading;
  state.loading = (async () => {
    const data = await request(PROFILE_ENDPOINT);
    state.profile = data.profile;
    state.platform = data.platform || { avatar_data_url: null };
    state.personalAvatar = state.profile?.avatar_data_url || null;
    state.platformAvatar = state.platform.avatar_data_url || null;
    state.loaded = true;
    applyPersonalProfile();
    applyPlatformBranding();
    return state;
  })().finally(() => { state.loading = null; });
  return state.loading;
}

function dataUrlBytes(dataUrl) {
  if (!dataUrl) return 0;
  const base64 = dataUrl.split(",", 2)[1] || "";
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor(base64.length * 3 / 4) - padding;
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("无法读取这张图片。"));
    };
    image.src = url;
  });
}

function renderSquare(image, size, mimeType, quality) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) throw new Error("当前浏览器无法处理头像图片。");
  const sourceSize = Math.min(image.naturalWidth, image.naturalHeight);
  const sourceX = Math.floor((image.naturalWidth - sourceSize) / 2);
  const sourceY = Math.floor((image.naturalHeight - sourceSize) / 2);
  context.clearRect(0, 0, size, size);
  context.drawImage(image, sourceX, sourceY, sourceSize, sourceSize, 0, 0, size, size);
  return canvas.toDataURL(mimeType, quality);
}

async function prepareAvatar(file) {
  if (!file || !ACCEPTED_TYPES.has(file.type)) throw new Error("请选择 PNG、JPEG 或 WebP 图片。");
  if (file.size > MAX_SOURCE_BYTES) throw new Error("原始图片不能超过 8 MB。");
  const image = await loadImage(file);
  if (!image.naturalWidth || !image.naturalHeight) throw new Error("图片尺寸无效。");

  for (const size of [256, 224, 192, 160]) {
    for (const quality of [0.86, 0.74, 0.62, 0.5]) {
      let output = renderSquare(image, size, "image/webp", quality);
      if (!output.startsWith("data:image/webp")) output = renderSquare(image, size, "image/jpeg", quality);
      if (dataUrlBytes(output) <= MAX_RESULT_BYTES) return output;
    }
  }
  throw new Error("图片压缩后仍然过大，请换一张更简单的图片。");
}

function previewMarkup(id, avatar, fallback) {
  const style = avatar ? ` style="background-image:url('${escapeHtml(avatar)}')"` : "";
  return `<span id="${id}" class="profile-avatar-preview ${avatar ? "has-image" : ""}"${style}>${avatar ? "" : escapeHtml(fallback)}</span>`;
}

function setStatus(form, message, type = "info") {
  const target = form.querySelector("[data-profile-status]");
  if (!target) return;
  target.textContent = message || "";
  target.dataset.status = type;
}

function updatePreview(kind) {
  const isPlatform = kind === "platform";
  const avatar = isPlatform ? state.platformAvatar : state.personalAvatar;
  const fallback = isPlatform ? "T" : initials(state.profile?.display_name, "U");
  const element = document.querySelector(isPlatform ? "#platform-avatar-preview" : "#personal-avatar-preview");
  if (!element) return;
  applyAvatar(element, avatar, fallback);
  element.classList.toggle("has-image", Boolean(avatar));
}

function profilePanel() {
  const profile = state.profile;
  const personal = `<article class="card profile-settings-card">
    <div class="card-head"><div><h2>个人资料</h2><p>管理员和普通用户都可以修改自己的用户名与头像。</p></div></div>
    <form id="personal-profile-form" class="card-body profile-settings-form">
      <div class="profile-avatar-editor">
        ${previewMarkup("personal-avatar-preview", state.personalAvatar, initials(profile.display_name, "U"))}
        <div><strong>个人头像</strong><p>系统会自动居中裁剪并压缩，不保存原始照片。</p><div class="actions"><button class="button small" type="button" data-pick-avatar="personal">选择图片</button><button class="button small ghost" type="button" data-remove-avatar="personal">移除头像</button></div></div>
        <input type="file" accept="image/png,image/jpeg,image/webp" data-avatar-input="personal" hidden>
      </div>
      <div class="field"><label for="profile-display-name">用户名</label><input id="profile-display-name" name="display_name" maxlength="60" required value="${escapeHtml(profile.display_name)}" autocomplete="nickname"><p class="field-help">1–60 个字符，保存后会显示在顶部和工作区标题中。</p></div>
      <div class="profile-form-footer"><span data-profile-status aria-live="polite"></span><button class="button primary" type="submit">保存个人资料</button></div>
    </form>
  </article>`;

  const platform = profile.role === "admin" ? `<article class="card profile-settings-card">
    <div class="card-head"><div><h2>平台头像</h2><p>仅管理员可修改，保存后替换侧栏、登录页和浏览器图标中的默认 T。</p></div><span class="badge enabled">管理员</span></div>
    <form id="platform-branding-form" class="card-body profile-settings-form">
      <div class="profile-avatar-editor">
        ${previewMarkup("platform-avatar-preview", state.platformAvatar, "T")}
        <div><strong>平台品牌头像</strong><p>建议使用简洁的正方形 Logo，头像会同步到所有用户界面。</p><div class="actions"><button class="button small" type="button" data-pick-avatar="platform">选择图片</button><button class="button small ghost" type="button" data-remove-avatar="platform">恢复默认 T</button></div></div>
        <input type="file" accept="image/png,image/jpeg,image/webp" data-avatar-input="platform" hidden>
      </div>
      <div class="profile-form-footer"><span data-profile-status aria-live="polite"></span><button class="button primary" type="submit">保存平台头像</button></div>
    </form>
  </article>` : "";

  const section = document.createElement("section");
  section.id = "profile-branding-settings";
  section.className = "profile-branding-grid mb-md";
  section.innerHTML = personal + platform;
  return section;
}

function bindPanel(panel) {
  panel.querySelectorAll("[data-pick-avatar]").forEach((button) => {
    button.addEventListener("click", () => panel.querySelector(`[data-avatar-input="${button.dataset.pickAvatar}"]`)?.click());
  });
  panel.querySelectorAll("[data-remove-avatar]").forEach((button) => {
    button.addEventListener("click", () => {
      const kind = button.dataset.removeAvatar;
      if (kind === "platform") state.platformAvatar = null;
      else state.personalAvatar = null;
      updatePreview(kind);
    });
  });
  panel.querySelectorAll("[data-avatar-input]").forEach((input) => {
    input.addEventListener("change", async () => {
      const kind = input.dataset.avatarInput;
      const form = input.closest("form");
      const [file] = input.files || [];
      input.value = "";
      if (!file) return;
      setStatus(form, "正在处理图片…");
      try {
        const avatar = await prepareAvatar(file);
        if (kind === "platform") state.platformAvatar = avatar;
        else state.personalAvatar = avatar;
        updatePreview(kind);
        setStatus(form, "图片已处理，请点击保存。", "success");
      } catch (error) {
        setStatus(form, errorMessage(error), "error");
      }
    });
  });

  const personalForm = panel.querySelector("#personal-profile-form");
  personalForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const button = personalForm.querySelector('button[type="submit"]');
    button.disabled = true;
    setStatus(personalForm, "正在保存…");
    try {
      const data = await request(PROFILE_ENDPOINT, {
        method: "PATCH",
        body: JSON.stringify({
          display_name: personalForm.elements.display_name.value,
          avatar_data_url: state.personalAvatar,
        }),
      });
      state.profile = data;
      state.personalAvatar = data.avatar_data_url || null;
      applyPersonalProfile(data);
      updatePreview("personal");
      setStatus(personalForm, "个人资料已保存。", "success");
    } catch (error) {
      setStatus(personalForm, errorMessage(error), "error");
    } finally {
      button.disabled = false;
    }
  });

  const platformForm = panel.querySelector("#platform-branding-form");
  platformForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const button = platformForm.querySelector('button[type="submit"]');
    button.disabled = true;
    setStatus(platformForm, "正在保存…");
    try {
      const data = await request(PLATFORM_ENDPOINT, {
        method: "PATCH",
        body: JSON.stringify({ avatar_data_url: state.platformAvatar }),
      });
      state.platform = data;
      state.platformAvatar = data.avatar_data_url || null;
      applyPlatformBranding(data);
      updatePreview("platform");
      setStatus(platformForm, "平台头像已保存。", "success");
    } catch (error) {
      setStatus(platformForm, errorMessage(error), "error");
    } finally {
      button.disabled = false;
    }
  });
}

async function injectSettingsPanel() {
  if (!location.hash.startsWith("#/settings")) return;
  const view = document.querySelector("#view");
  if (!view || view.querySelector("#profile-branding-settings")) return;
  try {
    await loadProfile();
  } catch {
    return;
  }
  if (!location.hash.startsWith("#/settings") || view.querySelector("#profile-branding-settings")) return;
  const panel = profilePanel();
  const pageHead = view.querySelector(".page-head");
  if (pageHead) pageHead.insertAdjacentElement("afterend", panel);
  else view.prepend(panel);
  bindPanel(panel);
}

function scheduleSync() {
  queueMicrotask(() => {
    applyPlatformBranding();
    applyPersonalProfile();
    if (!state.loaded) {
      loadProfile().then(() => injectSettingsPanel()).catch(() => {});
    } else {
      injectSettingsPanel();
    }
  });
}

loadPublicBranding();
loadProfile().catch(() => {});
window.addEventListener("hashchange", scheduleSync);
window.addEventListener("pageshow", scheduleSync);

const view = document.querySelector("#view");
if (view) new MutationObserver(scheduleSync).observe(view, { childList: true });

const identityName = document.querySelector("#identity-name");
if (identityName) new MutationObserver(() => applyPersonalProfile()).observe(identityName, { childList: true, characterData: true, subtree: true });
