/**
 * Minimal, dependency-free renderer for the near-orb toast. Reads the message
 * from the URL query and paints a small pill. No React / glazeAPI needed — the
 * backend controls the window lifecycle (position, show, auto-dismiss).
 */
const WARN_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
const INFO_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';

function render(): void {
  const params = new URLSearchParams(window.location.search);
  const title = params.get("title") ?? "";
  const body = params.get("body") ?? "";
  const tone = params.get("tone") === "warn" ? "warn" : "info";

  const root = document.getElementById("root");
  if (!root) return;

  const toast = document.createElement("div");
  toast.className = `toast toast--${tone}`;

  const icon = document.createElement("div");
  icon.className = "toast__icon";
  icon.innerHTML = tone === "warn" ? WARN_ICON : INFO_ICON;

  const text = document.createElement("div");
  text.className = "toast__text";

  const titleEl = document.createElement("div");
  titleEl.className = "toast__title";
  titleEl.textContent = title;

  const bodyEl = document.createElement("div");
  bodyEl.className = "toast__body";
  bodyEl.textContent = body;

  text.append(titleEl, bodyEl);
  toast.append(icon, text);
  root.replaceChildren(toast);
}

render();
