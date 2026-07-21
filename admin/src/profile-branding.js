const MAX_DIMENSION = 512;
const TARGET_BYTES = 280_000;

let profile = null;
let branding = null;
let profileAvatarChange;
let brandingAvatarChange;
let loadingPromise = null;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

function dataUrlBytes(value) {
  const base64 = String(value || "").split(",")[1] || "";
  return Math.floor(base64.length * 0.75);
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: "include",
    cache: "no-store",
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || `请求失败（${response.status}）`);
  return payload.data;
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
      reject(new Error("无法读取图片。"));
    };
    image.src = url;
  });
}

async function compressAvatar(file) {
  if (!/^image\/(png|jpeg|webp)$/i.test(file.type)) {
    throw new Error("仅支持 PNG、JPEG 或 WebP 图片。");
  }
  const image = await loadImage(file);
  const scale = Math.min(1, MAX_DIMENSION / Math.max(image.naturalWidth, image.naturalHeight));
  let width = Math.max(1, Math.round(image.naturalWidth * scale));
  let height = Math.max(1, Math.round(image.naturalHeight * scale));
  let quality = 0.86;
  let output = "";

  for (let attempt = 0; attempt < 7; attempt += 1) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    output = canvas.toDataURL("image/jpeg", quality);
    if (dataUrlBytes(output) <= TARGET_BYTES) return output;
    quality = Math.max(0.55, quality - 0.08);
    if (attempt >= 3) {
      width = Math.max(128, Math.round(width * 0.85));
      height = Math.max(128, Math.round(height * 0.85));
    }
  }
  if (dataUrlBytes(output) > 300_000) throw new Error("图片压缩后仍然过大，请选择更小的图片。");
  return output;
}

function setVisualAvatar(element, image, fallback) {
  if (!element) return;
  if (image) {
    element.textContent = "";
    element.style.backgroundImage = `url(${JSON.stringify(image).slice(1, -1)})`;
    element.style.backgroundSize = "cover";
    element.style.backgroundPosition = "center";
  } else {
    element.style.backgroundImage = "none";
    element.textContent = fallback;
  }
}

function applyBranding() {
  if (!branding) return;
  const name = branding.platform_name || "Telegram 自动消息";
  document.title = name;
  document.querySelectorAll(".brand strong").forEach((node) => { node.textContent = name; });
  const authTitle = document.querySelector("#auth-title");
  if (authTitle) authTitle.textContent = name;
  document.querySelectorAll(".brand-mark").forEach((node) => {
    setVisualAvatar(node, branding.platform_avatar_data_url, name.trim().charAt(0).toUpperCase() || "T");
  });
}

function applyProfile() {
  if (!profile) return;
  const nameNode = document.querySelector("#identity-name");
  const detailNode = document.querySelector("#identity-email");
  if (nameNode) nameNode.textContent = profile.display_name || (profile.role === "admin" ? "管理员" : "用户");
  if (detailNode) detailNode.textContent = profile.email || (profile.login ? `@${profile.login}` : profile.role === "admin" ? "管理员" : "用户");
  document.querySelectorAll(".avatar").forEach((node) => {
    setVisualAvatar(node, profile.avatar_data_url, (profile.display_name || "U").trim().charAt(0).toUpperCase());
  });
}

function avatarPreview(image, fallback, id) {
  return `<div class="profile-avatar-preview" id="${id}" ${image ? `style="background-image:url('${escapeHtml(image)}')"` : ""}>${image ? "" : escapeHtml(fallback)}</div>`;
}

function renderPanels() {
  if (!profile || !branding || !location.hash.startsWith("#/settings")) return;
  const view = document.querySelector("#view");
  if (!view || view.querySelector("[data-profile-branding-panel]")) return;

  const wrapper = document.createElement("section");
  wrapper.dataset.profileBrandingPanel = "true";
  wrapper.className = "profile-branding-grid";
  wrapper.innerHTML = `
    <article class="card profile-branding-card">
      <div class="card-head"><div><h2>个人资料</h2><p>修改当前账号在平台内显示的用户名和头像。</p></div></div>
      <div class="card-body">
        <form id="profile-settings-form" class="profile-branding-form">
          <div class="profile-avatar-editor">
            ${avatarPreview(profile.avatar_data_url, (profile.display_name || "U").charAt(0), "profile-avatar-preview")}
            <div><label class="button small" for="profile-avatar-file">选择头像</label><input id="profile-avatar-file" type="file" accept="image/png,image/jpeg,image/webp" hidden><button class="button small ghost" type="button" data-clear-avatar="profile">移除头像</button><p>系统会自动压缩为适合平台显示的尺寸。</p></div>
          </div>
          <div class="field"><label for="profile-display-name">显示用户名</label><input id="profile-display-name" maxlength="40" value="${escapeHtml(profile.display_name)}" required></div>
          <div class="profile-branding-actions"><span class="profile-form-status" id="profile-form-status"></span><button class="button primary" type="submit">保存个人资料</button></div>
        </form>
      </div>
    </article>
    ${profile.role === "admin" ? `
    <article class="card profile-branding-card">
      <div class="card-head"><div><h2>平台品牌</h2><p>修改侧栏、登录区域和浏览器标题显示的平台名称与头像。</p></div></div>
      <div class="card-body">
        <form id="branding-settings-form" class="profile-branding-form">
          <div class="profile-avatar-editor">
            ${avatarPreview(branding.platform_avatar_data_url, (branding.platform_name || "T").charAt(0), "branding-avatar-preview")}
            <div><label class="button small" for="branding-avatar-file">选择平台头像</label><input id="branding-avatar-file" type="file" accept="image/png,image/jpeg,image/webp" hidden><button class="button small ghost" type="button" data-clear-avatar="branding">恢复文字头像</button><p>建议使用正方形 Logo，图片会自动压缩。</p></div>
          </div>
          <div class="field"><label for="platform-name">平台名称</label><input id="platform-name" maxlength="40" value="${escapeHtml(branding.platform_name)}" required></div>
          <div class="profile-branding-actions"><span class="profile-form-status" id="branding-form-status"></span><button class="button primary" type="submit">保存平台品牌</button></div>
        </form>
      </div>
    </article>` : ""}`;
  view.prepend(wrapper);
}

function setPreview(id, image, fallback) {
  const node = document.querySelector(`#${id}`);
  if (!node) return;
  setVisualAvatar(node, image, fallback);
}

function setStatus(id, message, error = false) {
  const node = document.querySelector(`#${id}`);
  if (!node) return;
  node.textContent = message;
  node.dataset.error = error ? "true" : "false";
}

async function loadData(force = false) {
  if (loadingPromise && !force) return loadingPromise;
  loadingPromise = (async () => {
    try {
      [profile, branding] = await Promise.all([
        request("/api/v1/profile"),
        request("/api/v1/platform-branding"),
      ]);
      profileAvatarChange = undefined;
      brandingAvatarChange = undefined;
      applyProfile();
      applyBranding();
      renderPanels();
    } catch {
      // The login screen may still be active. A later app visibility change retries safely.
    } finally {
      loadingPromise = null;
    }
  })();
  return loadingPromise;
}

function installStyles() {
  if (document.querySelector("#profile-branding-styles")) return;
  const style = document.createElement("style");
  style.id = "profile-branding-styles";
  style.textContent = `
    .profile-branding-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;margin-bottom:20px}
    .profile-branding-card{min-width:0}.profile-branding-form{display:grid;gap:18px}
    .profile-avatar-editor{display:flex;align-items:center;gap:16px}.profile-avatar-editor>div:last-child{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.profile-avatar-editor p{width:100%;margin:0;color:var(--muted);font-size:12px}
    .profile-avatar-preview{display:grid;place-items:center;flex:0 0 76px;width:76px;height:76px;border:1px solid var(--line);border-radius:50%;background:linear-gradient(145deg,#58c5f5,#2aabee);background-size:cover;background-position:center;color:#fff;font-size:28px;font-weight:700;box-shadow:0 8px 22px rgba(42,171,238,.18)}
    .profile-branding-actions{display:flex;align-items:center;justify-content:space-between;gap:12px}.profile-form-status{font-size:12px;color:var(--success)}.profile-form-status[data-error="true"]{color:var(--red)}
    .brand-mark,.avatar{background-size:cover!important;background-position:center!important}
    @media(max-width:900px){.profile-branding-grid{grid-template-columns:1fr}}
    @media(max-width:520px){.profile-avatar-editor{align-items:flex-start}.profile-avatar-editor>div:last-child{align-items:flex-start}.profile-branding-actions{align-items:stretch;flex-direction:column}.profile-branding-actions .button{width:100%}}
  `;
  document.head.append(style);
}

async function handleFile(input, kind) {
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  const statusId = kind === "profile" ? "profile-form-status" : "branding-form-status";
  try {
    setStatus(statusId, "正在处理图片…");
    const dataUrl = await compressAvatar(file);
    if (kind === "profile") {
      profileAvatarChange = dataUrl;
      setPreview("profile-avatar-preview", dataUrl, (profile?.display_name || "U").charAt(0));
    } else {
      brandingAvatarChange = dataUrl;
      setPreview("branding-avatar-preview", dataUrl, (branding?.platform_name || "T").charAt(0));
    }
    setStatus(statusId, "头像已处理，点击保存后生效。");
  } catch (error) {
    setStatus(statusId, error.message, true);
  }
}

document.addEventListener("change", (event) => {
  if (event.target?.id === "profile-avatar-file") handleFile(event.target, "profile");
  if (event.target?.id === "branding-avatar-file") handleFile(event.target, "branding");
});

document.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest("[data-clear-avatar]") : null;
  if (!button) return;
  const kind = button.dataset.clearAvatar;
  if (kind === "profile") {
    profileAvatarChange = null;
    setPreview("profile-avatar-preview", null, (profile?.display_name || "U").charAt(0));
    setStatus("profile-form-status", "保存后将移除个人头像。");
  } else {
    brandingAvatarChange = null;
    setPreview("branding-avatar-preview", null, (branding?.platform_name || "T").charAt(0));
    setStatus("branding-form-status", "保存后将恢复文字头像。");
  }
});

document.addEventListener("submit", async (event) => {
  if (event.target?.id === "profile-settings-form") {
    event.preventDefault();
    try {
      setStatus("profile-form-status", "正在保存…");
      const body = { display_name: document.querySelector("#profile-display-name").value.trim() };
      if (profileAvatarChange !== undefined) body.avatar_data_url = profileAvatarChange;
      profile = await request("/api/v1/profile", { method: "PATCH", body: JSON.stringify(body) });
      profileAvatarChange = undefined;
      applyProfile();
      setStatus("profile-form-status", "个人资料已保存。");
    } catch (error) {
      setStatus("profile-form-status", error.message, true);
    }
  }
  if (event.target?.id === "branding-settings-form") {
    event.preventDefault();
    try {
      setStatus("branding-form-status", "正在保存…");
      const body = { platform_name: document.querySelector("#platform-name").value.trim() };
      if (brandingAvatarChange !== undefined) body.platform_avatar_data_url = brandingAvatarChange;
      branding = await request("/api/v1/platform-branding", { method: "PATCH", body: JSON.stringify(body) });
      brandingAvatarChange = undefined;
      applyBranding();
      setStatus("branding-form-status", "平台品牌已保存。");
    } catch (error) {
      setStatus("branding-form-status", error.message, true);
    }
  }
});

installStyles();
loadData();
window.addEventListener("hashchange", () => setTimeout(() => { applyProfile(); applyBranding(); renderPanels(); }, 0));
const view = document.querySelector("#view");
if (view) new MutationObserver(() => { applyProfile(); applyBranding(); renderPanels(); }).observe(view, { childList: true });
const app = document.querySelector("#app");
if (app) new MutationObserver(() => { if (!app.hidden) loadData(true); }).observe(app, { attributes: true, attributeFilter: ["hidden"] });
