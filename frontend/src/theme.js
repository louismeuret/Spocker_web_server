/**
 * Which of index.css's two palettes is active. The value lives on
 * <html data-theme>, because that is what the stylesheet keys off; this
 * module only keeps it in sync with localStorage and tells the one part of
 * the UI that cannot be restyled by CSS alone.
 *
 * The attribute is set before React mounts (see the inline script in
 * index.html), so there is no flash of the wrong theme on a reload.
 */

const KEY = "spocker.theme";

/** Fired on window after a change, for canvases that cached their colours. */
export const THEME_EVENT = "spocker:themechange";

export function getTheme() {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function setTheme(theme) {
  const next = theme === "light" ? "light" : "dark";
  // "dark" is the stylesheet's default, so it is the absence of the
  // attribute rather than a value of its own.
  if (next === "light") document.documentElement.dataset.theme = "light";
  else delete document.documentElement.dataset.theme;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // localStorage unavailable (private mode, quota, etc) -- the theme still
    // applies for this session, it just will not be remembered.
  }
  window.dispatchEvent(new Event(THEME_EVENT));
}
