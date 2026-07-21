import "./profile-branding.js?v=20260721-2";
import "./profile-branding-status.js?v=20260721-1";

const MOBILE_QUERY = "(max-width: 760px)";
const body = document.body;
const sidebar = document.querySelector(".sidebar");
const menuToggle = document.querySelector("#menu-toggle");
const main = document.querySelector("#main-content");
const view = document.querySelector("#view");

let touchStartX = null;
let touchStartY = null;
let resetPending = false;

function isMobile() {
  return globalThis.matchMedia?.(MOBILE_QUERY).matches ?? false;
}

function syncMenuButton() {
  const open = body.classList.contains("nav-open");
  menuToggle?.setAttribute("aria-expanded", String(open));
  menuToggle?.setAttribute("aria-label", open ? "关闭导航" : "打开导航");
  if (menuToggle) menuToggle.textContent = open ? "×" : "☰";
}

function closeNavigation() {
  body.classList.remove("nav-open");
  syncMenuButton();
}

function resetMainScroll() {
  if (!isMobile()) return;
  main?.scrollTo(0, 0);
  if (main) main.scrollTop = 0;
}

function scheduleRouteReset() {
  if (!isMobile()) return;
  resetPending = true;
  resetMainScroll();
  requestAnimationFrame(resetMainScroll);
  setTimeout(resetMainScroll, 80);
  setTimeout(() => {
    resetMainScroll();
    resetPending = false;
  }, 320);
}

if ("scrollRestoration" in history) history.scrollRestoration = "manual";

let backdrop = document.querySelector(".mobile-nav-backdrop");
if (!backdrop) {
  backdrop = document.createElement("button");
  backdrop.type = "button";
  backdrop.className = "mobile-nav-backdrop";
  backdrop.setAttribute("aria-label", "关闭导航");
  backdrop.addEventListener("click", closeNavigation);
  document.body.append(backdrop);
}

menuToggle?.addEventListener("click", () => {
  requestAnimationFrame(syncMenuButton);
});

sidebar?.addEventListener("click", (event) => {
  if (event.target instanceof Element && event.target.closest("a[data-route]")) {
    closeNavigation();
  }
});

document.addEventListener("touchstart", (event) => {
  if (!isMobile() || !body.classList.contains("nav-open") || event.touches.length !== 1) return;
  touchStartX = event.touches[0].clientX;
  touchStartY = event.touches[0].clientY;
}, { passive: true });

document.addEventListener("touchend", (event) => {
  if (touchStartX === null || touchStartY === null || event.changedTouches.length !== 1) return;
  const deltaX = event.changedTouches[0].clientX - touchStartX;
  const deltaY = event.changedTouches[0].clientY - touchStartY;
  touchStartX = null;
  touchStartY = null;
  if (deltaX < -45 && Math.abs(deltaX) > Math.abs(deltaY)) closeNavigation();
}, { passive: true });

window.addEventListener("hashchange", () => {
  closeNavigation();
  scheduleRouteReset();
});

window.addEventListener("popstate", () => {
  closeNavigation();
  scheduleRouteReset();
});

window.addEventListener("pageshow", () => {
  closeNavigation();
  scheduleRouteReset();
});

window.addEventListener("orientationchange", () => {
  closeNavigation();
  scheduleRouteReset();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeNavigation();
});

if (view) {
  new MutationObserver(() => {
    if (resetPending) requestAnimationFrame(resetMainScroll);
  }).observe(view, { childList: true });
}

syncMenuButton();