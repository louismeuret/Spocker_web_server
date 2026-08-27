/**
 * Page chrome shared by the results and compare pages, which are the same
 * shape: a sidebar of controls next to a full-height 3D viewer.
 */

/** The viewer's framed pane, plus the error banner that overlays its bottom
 *  edge when Mol* reports one. */
export function ViewerPane({ error, children }) {
  return (
    <section
      style={{ flex: 1, margin: "1rem", minWidth: 0, border: "3px solid #fff", position: "relative" }}
    >
      {children}
      {error && (
        <p
          className="nb-mono"
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            background: "#fff",
            color: "#000",
            padding: "0.5em",
            fontSize: "0.7rem",
          }}
        >
          VIEWER ERROR: {error}
        </p>
      )}
    </section>
  );
}

/** Cartoon/Surface representation picker for the structure backbone. */
export function BaseStyleButtons({ value, onChange }) {
  return (
    <div style={{ display: "flex", gap: "0.4rem", marginBottom: "0.5rem" }}>
      {["cartoon", "surface"].map((style) => (
        <button
          key={style}
          className={`nb-btn nb-btn--sm ${value === style ? "is-pressed" : ""}`}
          onClick={() => onChange(style)}
        >
          {style === "cartoon" ? "Cartoon" : "Surface"}
        </button>
      ))}
    </div>
  );
}
