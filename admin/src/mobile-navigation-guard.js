const MOBILE_QUERY = "(max-width: 760px)";
const body = document.body;
const menuToggle = document.querySelector("#menu-toggle");
const sidebar = document.querySelector(".sidebar");
const view = document.querySelector("#view");

let touchStartX = null;
let touchStartY = null;
let routeResetUntil = 0;

function isMobile() {
  return globalThis.matchMedia?.(MOBILE_QUERY).matches ?? false;
}

function closeNavigation() {
  if (!body.classList.contains("nav-open")) return;
  body.classList.remove("nav-open");
  menuToggle?.setAttribute("aria-expanded", "false");
}

function resetRouteScroll() {
  if (!isMobile()) return;
  globalThis.scrollTo(0, 0);
  if (document.scrollingElement) {
    document.scrollingElement.scrollTop = 0;
    document.scrollingElement.scrollLeft = 0;
  }
}

function scheduleRouteScrollReset() {
  if (!isMobile()) return;
  routeResetUntil = Date.now() + 900;
  resetRouteScroll();
  requestAnimationFrame(resetRouteScroll);
  setTimeout(resetRouteScroll, 60);
  setTimeout(resetRouteScroll, 220);
  setTimeout(resetRouteScroll, 600);
}

function clampScrollToDocument() {
  if (!isMobile()) return;
  const viewportHeight = globalThis.visualViewport?.height || globalThis.innerHeight || 0;
  const maximum = Math.max(0, document.documentElement.scrollHeight - viewportHeight);
  if (globalThis.scrollY > maximum + 2) globalThis.scrollTo(0, maximum);
}

if ("scrollRestoration" in history) history.scrollRestoration = "manual";

// Give the drawer an explicit close control on mobile.
if (sidebar && !sidebar.querySelector("[data-mobile-nav-close]")) {
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "mobile-nav-close";
  closeButton.dataset.mobileNavClose = "true";
  closeButton.setAttribute("aria-label", "关闭导航");
  closeButton.textContent = "×";
  closeButton.addEventListener("click", closeNavigation);
  sidebar.prepend(closeButton);
}

// Clicking outside the open sidebar closes it. This includes the dimmed backdrop.
document.addEventListener("click", (event) => {
  if (!isMobile() || !body.classList.contains("nav-open")) return;
  const target = event.target;
  if (target instanceof Element && (target.closest(".sidebar") || target.closest("#menu-toggle"))) return;
  closeNavigation();
});

// Selecting a destination closes the drawer immediately.
sidebar?.addEventListener("click", (event) => {
  if (event.target instanceof Element && event.target.closest("a[data-route]")) closeNavigation();
});

// A horizontal swipe while the drawer is open closes it.
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
  if (Math.abs(deltaX) >= 48 && Math.abs(deltaX) > Math.abs(deltaY)) closeNavigation();
}, { passive: true });

window.addEventListener("hashchange", () => {
  closeNavigation();
  scheduleRouteScrollReset();
});

window.addEventListener("popstate", () => {
  closeNavigation();
  scheduleRouteScrollReset();
});

window.addEventListener("pageshow", scheduleRouteScrollReset);
window.addEventListener("orientationchange", () => {
  closeNavigation();
  scheduleRouteScrollReset();
});
window.addEventListener("resize", clampScrollToDocument, { passive: true });

// Routes render asynchronously. Re-apply the reset after the new page has entered #view.
if (view) {
  new MutationObserver(() => {
    if (Date.now() < routeResetUntil) requestAnimationFrame(resetRouteScroll);
    else requestAnimationFrame(clampScrollToDocument);
  }).observe(view, { childList: true, subtree: false });
}
