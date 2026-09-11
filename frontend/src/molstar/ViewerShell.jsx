/**
 * The container div Mol* mounts into, plus the loading/failed overlays.
 * Shared by MolstarViewer and CompareViewer so the two look identical while
 * the canvas is still coming up.
 *
 * `busy` is the *scene* loading (MRC grids being downloaded and
 * triangulated) rather than the viewer itself: its spinner sits over the
 * canvas without hiding it, so the structure stays visible while a volume
 * is still on its way.
 */
export default function ViewerShell({ containerRef, status, busy }) {
  return (
    <div style={{ position: "relative", width: "100%", height: "100%", background: "#fff" }}>
      <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />
      {status === "loading" && (
        <div className="nb-viewer-overlay">
          <p className="nb-mono">LOADING VIEWER...</p>
        </div>
      )}
      {status === "error" && (
        <div className="nb-viewer-overlay">
          <p className="nb-mono">MOLSTAR FAILED TO LOAD. SEE CONSOLE.</p>
        </div>
      )}
      {status === "ready" && busy && (
        <div className="nb-busy">
          <img className="nb-spinner" src="/spinner.webp" alt="" />
          <p className="nb-mono" style={{ margin: 0, fontSize: "0.7rem" }}>
            LOADING DATA...
          </p>
        </div>
      )}
    </div>
  );
}
