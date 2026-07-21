const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_RESULT_BYTES = 92 * 1024;
const VIEWPORT_SIZE = 320;
const ACCEPTED_EXTENSIONS = /\.(avif|bmp|gif|heic|heif|jpe?g|png|webp)$/i;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function dataUrlBytes(dataUrl) {
  const base64 = String(dataUrl || "").split(",", 2)[1] || "";
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor(base64.length * 3 / 4) - padding;
}

function isImageFile(file) {
  return Boolean(file && (String(file.type || "").startsWith("image/") || ACCEPTED_EXTENSIONS.test(file.name || "")));
}

function dimensions(source) {
  return {
    width: Number(source?.naturalWidth || source?.width || 0),
    height: Number(source?.naturalHeight || source?.height || 0),
  };
}

async function decodeWithImageBitmap(file) {
  if (typeof createImageBitmap !== "function") return null;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    return {
      source: bitmap,
      ...dimensions(bitmap),
      close: () => bitmap.close(),
    };
  } catch {
    return null;
  }
}

function decodeWithImageElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      const size = dimensions(image);
      if (!size.width || !size.height) {
        URL.revokeObjectURL(url);
        reject(new Error("图片尺寸无效。"));
        return;
      }
      resolve({
        source: image,
        ...size,
        close: () => URL.revokeObjectURL(url),
      });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("当前浏览器无法解码这张照片。请在相册中选择普通照片、截图，或将 HEIC/HEIF 另存为 JPEG 后重试。"));
    };
    image.src = url;
  });
}

async function decodeImage(file) {
  if (!isImageFile(file)) throw new Error("请选择手机相册中的图片。支持 JPEG、PNG、WebP、GIF、BMP、AVIF，以及浏览器可解码的 HEIC/HEIF。");
  if (Number(file.size || 0) > MAX_SOURCE_BYTES) throw new Error("图片超过 32 MB，请选择较小的照片或截图。");
  const bitmap = await decodeWithImageBitmap(file);
  if (bitmap?.width && bitmap?.height) return bitmap;
  return decodeWithImageElement(file);
}

function outputDataUrl(canvas, mimeType, quality) {
  const result = canvas.toDataURL(mimeType, quality);
  if (mimeType === "image/webp" && !result.startsWith("data:image/webp")) return null;
  return result;
}

function createCropperMarkup(title) {
  return `<div class="avatar-cropper-backdrop" data-avatar-cropper>
    <section class="avatar-cropper-card" role="dialog" aria-modal="true" aria-labelledby="avatar-cropper-title">
      <header class="avatar-cropper-head">
        <div><h2 id="avatar-cropper-title">${title}</h2><p>拖动照片调整位置，滑动缩放。圆框内就是最终头像。</p></div>
        <button class="icon-button" type="button" data-crop-cancel aria-label="关闭">×</button>
      </header>
      <div class="avatar-cropper-body">
        <div class="avatar-crop-stage" data-crop-stage>
          <canvas width="${VIEWPORT_SIZE}" height="${VIEWPORT_SIZE}" data-crop-canvas aria-label="头像裁剪预览"></canvas>
          <span class="avatar-crop-ring" aria-hidden="true"></span>
        </div>
        <label class="avatar-zoom-control"><span>缩放</span><input type="range" min="1" max="4" step="0.01" value="1" data-crop-zoom></label>
        <p class="avatar-crop-hint" data-crop-status>可以自由拖动和缩放，不会修改手机里的原图。</p>
      </div>
      <footer class="avatar-cropper-actions">
        <button class="button ghost" type="button" data-crop-reset>恢复居中</button>
        <div><button class="button ghost" type="button" data-crop-cancel>取消</button><button class="button primary" type="button" data-crop-confirm>使用此头像</button></div>
      </footer>
    </section>
  </div>`;
}

function renderToCanvas(canvas, decoded, state) {
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("当前浏览器无法处理头像图片。");
  const scale = state.baseScale * state.zoom;
  const drawnWidth = decoded.width * scale;
  const drawnHeight = decoded.height * scale;
  const centerX = VIEWPORT_SIZE / 2 + state.offsetX;
  const centerY = VIEWPORT_SIZE / 2 + state.offsetY;
  context.fillStyle = "#eef3f7";
  context.fillRect(0, 0, VIEWPORT_SIZE, VIEWPORT_SIZE);
  context.drawImage(decoded.source, centerX - drawnWidth / 2, centerY - drawnHeight / 2, drawnWidth, drawnHeight);
}

function constrainOffsets(decoded, state) {
  const scale = state.baseScale * state.zoom;
  const maxX = Math.max(0, (decoded.width * scale - VIEWPORT_SIZE) / 2);
  const maxY = Math.max(0, (decoded.height * scale - VIEWPORT_SIZE) / 2);
  state.offsetX = clamp(state.offsetX, -maxX, maxX);
  state.offsetY = clamp(state.offsetY, -maxY, maxY);
}

function exportAvatar(decoded, state) {
  for (const size of [320, 288, 256, 224, 192, 160]) {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("当前浏览器无法生成头像。");
    const outputScale = size / VIEWPORT_SIZE;
    const scale = state.baseScale * state.zoom * outputScale;
    const centerX = size / 2 + state.offsetX * outputScale;
    const centerY = size / 2 + state.offsetY * outputScale;
    const drawnWidth = decoded.width * scale;
    const drawnHeight = decoded.height * scale;
    context.fillStyle = "#eef3f7";
    context.fillRect(0, 0, size, size);
    context.drawImage(decoded.source, centerX - drawnWidth / 2, centerY - drawnHeight / 2, drawnWidth, drawnHeight);
    for (const quality of [0.9, 0.82, 0.74, 0.66, 0.58, 0.5]) {
      const webp = outputDataUrl(canvas, "image/webp", quality);
      if (webp && dataUrlBytes(webp) <= MAX_RESULT_BYTES) return webp;
      const jpeg = outputDataUrl(canvas, "image/jpeg", quality);
      if (jpeg && dataUrlBytes(jpeg) <= MAX_RESULT_BYTES) return jpeg;
    }
  }
  throw new Error("头像生成后仍然过大，请缩小照片或选择另一张图片。");
}

export async function openAvatarCropper(file, { title = "自定义头像" } = {}) {
  const decoded = await decodeImage(file);
  const wrapper = document.createElement("div");
  wrapper.innerHTML = createCropperMarkup(title);
  const overlay = wrapper.firstElementChild;
  const canvas = overlay.querySelector("[data-crop-canvas]");
  const stage = overlay.querySelector("[data-crop-stage]");
  const zoomInput = overlay.querySelector("[data-crop-zoom]");
  const confirmButton = overlay.querySelector("[data-crop-confirm]");
  const status = overlay.querySelector("[data-crop-status]");
  const state = {
    baseScale: Math.max(VIEWPORT_SIZE / decoded.width, VIEWPORT_SIZE / decoded.height),
    zoom: 1,
    offsetX: 0,
    offsetY: 0,
  };

  const redraw = () => {
    constrainOffsets(decoded, state);
    renderToCanvas(canvas, decoded, state);
  };

  document.body.append(overlay);
  document.body.classList.add("avatar-cropper-open");
  redraw();

  return new Promise((resolve) => {
    let settled = false;
    let pointerId = null;
    let previousX = 0;
    let previousY = 0;

    const cleanup = () => {
      document.removeEventListener("keydown", onKeyDown);
      decoded.close();
      overlay.remove();
      document.body.classList.remove("avatar-cropper-open");
    };

    const cancel = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(null);
    };

    const onKeyDown = (event) => {
      if (event.key === "Escape") cancel();
    };

    overlay.querySelectorAll("[data-crop-cancel]").forEach((button) => button.addEventListener("click", cancel));
    overlay.querySelector("[data-crop-reset]").addEventListener("click", () => {
      state.zoom = 1;
      state.offsetX = 0;
      state.offsetY = 0;
      zoomInput.value = "1";
      redraw();
    });

    zoomInput.addEventListener("input", () => {
      state.zoom = Number(zoomInput.value || 1);
      redraw();
    });

    stage.addEventListener("pointerdown", (event) => {
      pointerId = event.pointerId;
      previousX = event.clientX;
      previousY = event.clientY;
      stage.setPointerCapture(pointerId);
      stage.classList.add("dragging");
    });
    stage.addEventListener("pointermove", (event) => {
      if (event.pointerId !== pointerId) return;
      const rect = stage.getBoundingClientRect();
      const factor = VIEWPORT_SIZE / Math.max(1, rect.width);
      state.offsetX += (event.clientX - previousX) * factor;
      state.offsetY += (event.clientY - previousY) * factor;
      previousX = event.clientX;
      previousY = event.clientY;
      redraw();
    });
    const releasePointer = (event) => {
      if (event.pointerId !== pointerId) return;
      pointerId = null;
      stage.classList.remove("dragging");
    };
    stage.addEventListener("pointerup", releasePointer);
    stage.addEventListener("pointercancel", releasePointer);

    confirmButton.addEventListener("click", () => {
      if (settled) return;
      confirmButton.disabled = true;
      status.textContent = "正在生成头像…";
      try {
        const avatar = exportAvatar(decoded, state);
        settled = true;
        cleanup();
        resolve(avatar);
      } catch (error) {
        confirmButton.disabled = false;
        status.textContent = error instanceof Error ? error.message : "头像生成失败，请重试。";
      }
    });

    document.addEventListener("keydown", onKeyDown);
    confirmButton.focus();
  });
}
