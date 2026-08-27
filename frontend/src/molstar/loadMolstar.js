/**
 * Mol* ships a huge (~5MB) prebuilt UMD bundle (copied from
 * node_modules/molstar/build/viewer/ into frontend/public/molstar/ -- see
 * README). We load it as a plain <script>/<link> pair instead of importing
 * it into the Vite/JS module graph:
 *   - it's only needed on the results page, not the upload page
 *   - it's already built/minified, there's nothing for Vite to do with it
 *   - it's the same pattern Mol*'s own docs use for embedding
 *
 * This module just makes sure that happens exactly once and gives back a
 * promise for `window.molstar`.
 */

let molstarPromise = null;

function loadStylesheet(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  document.head.appendChild(link);
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (window.molstar) return resolve();
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error(`Failed to load ${src}`)));
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.body.appendChild(script);
  });
}

export function loadMolstar() {
  if (!molstarPromise) {
    loadStylesheet("/molstar/molstar.css");
    molstarPromise = loadScript("/molstar/molstar.js").then(() => {
      if (!window.molstar) {
        throw new Error("molstar.js loaded but window.molstar is missing");
      }
      return window.molstar;
    });
  }
  return molstarPromise;
}
