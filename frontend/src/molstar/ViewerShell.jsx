/**
 * The container div Mol* mounts into, plus the loading/failed overlays.
 * Shared by MolstarViewer and CompareViewer so the two look identical while
 * the canvas is still coming up.
 */
export default function ViewerShell({ containerRef, status }) {
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
    </div>
  );
}
