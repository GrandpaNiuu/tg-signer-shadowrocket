const SETTINGS_HASH = "#/settings";
const PANEL_ID = "profile-branding-settings";
const FALLBACK_ID = "profile-branding-fallback";
const DIRECT_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const DIRECT_SOURCE_BYTES = 8 * 1024 * 1024;
const ALBUM_SOURCE_BYTES = 32 * 1024 * 1024;
const ALBUM_EXTENSIONS = /\.(avif|bmp|gif|heic|heif|jpe?g|png|webp)$/i;
const ALBUM_PICKER_LABEL = "从手机相册选择";
const ALBUM_HELP_TEXT = "直接选择手机相册图片，系统会参照 Telegram 头像方式自动居中裁剪和压缩。";

function removeFallback() {
  document.querySelector(`#${FALLBACK_ID}`)?.remove();
}

function showFallback() {
  if (!location.hash.startsWith(SETTINGS_HASH)) {
    removeFallback();
    return;
  }
  const view = document.querySelector("#view");
  if (!view || view.querySelector(`#${PANEL_ID}`)) {
    removeFallback();
    return;
  }
  if (view.querySelector(`#${FALLBACK_ID}`)) return;

  const section = document.createElement("section");
  section.id = FALLBACK_ID;
  section.className = "card mb-md";
  section.innerHTML = `<div class="card-head"><div><h2>个人资料与平台头像</h2><p>资料模块正在连接后台服务。</p></div><span class="badge pending">等待部署</span></div>
    <div class="card-body"><div class="notice warning"><span aria-hidden="true">!</span><span>当前页面尚未取得资料接口。通常是 Worker 或 D1 migration 仍未完成部署。页面不会再静默隐藏该功能。</span></div>
    <div class="actions mt-md"><button class="button primary" type="button" data-profile-reload>重新加载</button></div></div>`;
  const head = view.querySelector(".page-head");
  if (head) head.insertAdjacentElement("afterend", section);
  else view.prepend(section);
  section.querySelector("[data-profile-reload]")?.addEventListener("click", () => location.reload());
}

function profileStatus(form, message, type = "info") {
  const target = form?.querySelector("[data-profile-status]");
  if (!target) return;
  target.textContent = message;
  target.dataset.status = type;
}

function isAlbumImage(file) {
  return Boolean(file && (String(file.type || "").startsWith("image/") || ALBUM_EXTENSIONS.test(file.name || "")));
}

function needsAlbumNormalization(file) {
  return !DIRECT_IMAGE_TYPES.has(String(file?.type || "").toLowerCase()) || Number(file?.size || 0) > DIRECT_SOURCE_BYTES;
}

async function loadAlbumImage(file) {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close(),
      };
    } catch {
      // Fall through to the browser image decoder.
    }
  }

  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => resolve({
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      close: () => URL.revokeObjectURL(url),
    });
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("当前浏览器无法读取这张相册图片，请在手机相册中另存为 JPG 后重试。"));
    };
    image.src = url;
  });
}

function canvasBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("图片转换失败，请重新选择。"));
    }, "image/jpeg", quality);
  });
}

async function normalizeAlbumImage(file) {
  if (!isAlbumImage(file)) throw new Error("请选择手机相册中的图片。即使图片不是正方形，系统也会自动处理。");
  if (file.size > ALBUM_SOURCE_BYTES) throw new Error("这张照片过大，请先在手机相册中保存一个副本后再上传。");

  const image = await loadAlbumImage(file);
  try {
    if (!image.width || !image.height) throw new Error("图片尺寸无效，请重新选择。");
    for (const maxEdge of [2048, 1600, 1280, 1024]) {
      const scale = Math.min(1, maxEdge / Math.max(image.width, image.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("当前浏览器无法处理这张图片。");
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image.source, 0, 0, canvas.width, canvas.height);

      for (const quality of [0.9, 0.82, 0.74, 0.66]) {
        const blob = await canvasBlob(canvas, quality);
        if (blob.size <= DIRECT_SOURCE_BYTES) {
          return new File([blob], "telegram-avatar.jpg", {
            type: "image/jpeg",
            lastModified: Date.now(),
          });
        }
      }
    }
    throw new Error("图片自动压缩失败，请重新选择一张照片。");
  } finally {
    image.close();
  }
}

function configureAlbumInputs(root = document) {
  root.querySelectorAll?.("input[data-avatar-input]").forEach((input) => {
    if (input.getAttribute("accept") !== "image/*,.heic,.heif") {
      input.setAttribute("accept", "image/*,.heic,.heif");
    }
    if (input.hasAttribute("capture")) input.removeAttribute("capture");
  });
  root.querySelectorAll?.("button[data-pick-avatar]").forEach((button) => {
    if (button.textContent !== ALBUM_PICKER_LABEL) button.textContent = ALBUM_PICKER_LABEL;
  });
  root.querySelectorAll?.(".profile-avatar-editor p").forEach((paragraph) => {
    if (paragraph.textContent !== ALBUM_HELP_TEXT) paragraph.textContent = ALBUM_HELP_TEXT;
  });
}

document.addEventListener("change", async (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || !input.matches("input[data-avatar-input]")) return;

  if (input.dataset.albumNormalized === "true") {
    delete input.dataset.albumNormalized;
    return;
  }

  const file = input.files?.[0];
  if (!file || !needsAlbumNormalization(file)) return;

  event.preventDefault();
  event.stopImmediatePropagation();
  const form = input.closest("form");
  profileStatus(form, "正在处理相册图片…");

  try {
    const normalized = await normalizeAlbumImage(file);
    if (typeof DataTransfer !== "function") {
      throw new Error("当前浏览器版本不支持相册图片转换，请升级浏览器后重试。");
    }
    const transfer = new DataTransfer();
    transfer.items.add(normalized);
    input.dataset.albumNormalized = "true";
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  } catch (error) {
    input.value = "";
    profileStatus(form, error instanceof Error ? error.message : "图片处理失败，请重新选择。", "error");
  }
}, true);

function scheduleCheck() {
  setTimeout(() => {
    configureAlbumInputs();
    showFallback();
  }, 1200);
}

window.addEventListener("hashchange", scheduleCheck);
window.addEventListener("pageshow", scheduleCheck);
const view = document.querySelector("#view");
if (view) new MutationObserver(() => {
  configureAlbumInputs(view);
  if (view.querySelector(`#${PANEL_ID}`)) removeFallback();
  else scheduleCheck();
}).observe(view, { childList: true });
configureAlbumInputs();
scheduleCheck();
