const MOBILE_QUERY = "(max-width: 760px)";
const body = document.body;
const menuToggle = document.querySelector("#menu-toggle");
const sidebar = document.querySelector(".sidebar");

let touchStartX = null;
let touchStartY = null;

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
  requestAnimationFrame(() => {
    globalThis.scrollTo({ top: 0, left: 0, behavior: "instant" });
    document.scrollingElement?.scrollTo?.({ top: 0, left: 0, behavior: "instant" });
  });
}

if ("scrollRestoration" in history) history.scrollRestoration = "manual";

// Clicking outside the open sidebar closes it. This also handles the CSS backdrop.
document.addEventListener("click", (event) => {
  if (!isMobile() || !body.classList.contains("nav-open")) return;
  const target = event.target;
  if (target instanceof Element && (target.closest(".sidebar") || target.closest("#menu-toggle"))) return;
  closeNavigation();
});

// Selecting a sidebar destination closes the drawer immediately.
sidebar?.addEventListener("click", (event) => {
  if (event.target instanceof Element && event.target.closest("a[data-route]")) closeNavigation();
});

// A horizontal swipe while the drawer is open closes it in either direction.
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
  resetRouteScroll();
});

window.addEventListener("popstate", () => {
  closeNavigation();
  resetRouteScroll();
});

window.addEventListener("pageshow", resetRouteScroll);
window.addEventListener("orientationchange", closeNavigation);
