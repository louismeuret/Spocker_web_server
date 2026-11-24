import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createJob, listExamples, listPdbChains } from "../api";
import { addRecentJob, getRecentJobs } from "../recentJobs";
import { getTheme, setTheme } from "../theme";

const ACCEPTED = ".pdb,.ent,.cif";
const PDB_CODE_RE = /^[0-9][A-Za-z0-9]{3}$/;

// How much coarser the grids handed to the 3D viewer are than the ones the
// pipeline computes and stores. The full-resolution grids are always what
// gets saved and downloaded -- this only trades viewer detail for speed, and
// a 0.25A grid is far finer than a browser isosurface needs. Must stay within
// backend/app/config.py's MAX_DISPLAY_DOWNSCALE.
const DOWNSCALE_OPTIONS = [1, 2, 4, 8];
const DEFAULT_DOWNSCALE = 2;
const PIPELINE_GRID_A = 0.25;

// Pocket volume shape; must match backend/app/config.py's POCKET_MODES.
const POCKET_MODES = [
  { value: "fluid", label: "Fluid" },
  { value: "sphere", label: "Sphere" },
];

// The two palettes in index.css.
const THEMES = [
  { value: "dark", label: "Classic" },
  { value: "light", label: "Starlight" },
];

export default function InputPage() {
  const navigate = useNavigate();
  const fileInputRef = useRef(null);
  const [mode, setMode] = useState("file"); // "file" | "code"
  const [file, setFile] = useState(null);
  const [pdbCode, setPdbCode] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [recent] = useState(() => getRecentJobs());
  const examples = useExamples();
  // Set once the backend reports a structure with multiple MODEL blocks
  // (NMR ensembles etc) -- the user then picks one and we re-submit the
  // exact same file/code, this time with that model number attached.
  const [pendingModels, setPendingModels] = useState(null);
  const [selectedModel, setSelectedModel] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [displayDownscale, setDisplayDownscale] = useState(DEFAULT_DOWNSCALE);
  const [pocketMode, setPocketMode] = useState("fluid");
  // Mirrors <html data-theme>, which is the actual source of truth.
  const [theme, setThemeState] = useState(getTheme);
  // "" means every chain, which is both the default and what an uploaded
  // file always gets (the picker is only offered for PDB codes).
  const [chain, setChain] = useState("");

  function pickFile(f) {
    if (!f) return;
    setError(null);
    setPendingModels(null);
    setFile(f);
  }

  const onDrop = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    pickFile(f);
  }, []);

  function switchMode(next) {
    if (next === mode || submitting) return;
    setMode(next);
    setError(null);
    setPendingModels(null);
  }

  const trimmedCode = pdbCode.trim();
  const chains = usePdbChains(mode === "code" ? trimmedCode : "");
  const canSubmit = mode === "file" ? !!file : PDB_CODE_RE.test(trimmedCode);
  const hasExamples = examples.calculations.length > 0 || examples.comparisons.length > 0;

  async function submitJob(extra) {
    setSubmitting(true);
    setError(null);
    try {
      const job =
        mode === "code"
          ? await createJob({ pdbCode: trimmedCode, displayDownscale, pocketMode, chain, ...extra })
          : await createJob({ file, displayDownscale, pocketMode, ...extra });

      if (job.needs_model_selection) {
        setPendingModels(job.models);
        setSelectedModel(job.models[0]);
        setSubmitting(false);
        return;
      }

      addRecentJob({ id: job.id, filename: job.filename });
      navigate(`/results/${job.id}`);
    } catch (err) {
      setError(err.message || (mode === "code" ? "Download failed" : "Upload failed"));
      setSubmitting(false);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (submitting) return;
    if (pendingModels) {
      if (selectedModel == null) return;
      submitJob({ model: selectedModel });
      return;
    }
    if (!canSubmit) return;
    submitJob({});
  }

  return (
    <main
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "safe center",
        gap: "1.5rem",
        padding: "2rem 1rem",
      }}
    >
      <div style={{ width: "min(560px, 100%)" }}>
        <div className="nb-panel">
          <div className="nb-panel__header">
            <span>Pocket Calculation</span>
            <button
              type="button"
              className="nb-btn nb-btn--sm nb-btn--invert"
              aria-expanded={showSettings}
              title="Settings"
              onClick={() => setShowSettings((v) => !v)}
            >
              &#9881;
            </button>
          </div>
          <div className="nb-panel__body">
            <p style={{ fontSize: "0.85rem" }}>
              Upload an RNA structure (<span className="nb-mono">.pdb</span>,{" "}
              or <span className="nb-mono">.cif</span>), or fetch one
              from RCSB by its PDB code. It's cleaned with PDBFixer, filtered
              down to only nucleic-acid residues. We then run the spocker
              pocket detection algorithm.
            </p>

            {showSettings && (
              <div style={{ border: "2px solid var(--lcars-b6)", borderRadius: "0.35rem", padding: "0.75rem", marginTop: "1rem" }}>
                <label className="nb-label" htmlFor="downscale-input">
                  Viewer grid resolution
                </label>
                <div style={{ display: "flex", gap: "0.4rem" }}>
                  {DOWNSCALE_OPTIONS.map((factor) => (
                    <button
                      key={factor}
                      type="button"
                      id={factor === DOWNSCALE_OPTIONS[0] ? "downscale-input" : undefined}
                      className={`nb-btn nb-btn--sm ${displayDownscale === factor ? "is-pressed" : ""}`}
                      style={{ flex: 1 }}
                      onClick={() => setDisplayDownscale(factor)}
                    >
                      {(PIPELINE_GRID_A * factor).toFixed(2)}A
                    </button>
                  ))}
                </div>
                <p className="nb-mono" style={{ fontSize: "0.7rem", opacity: 0.7, marginTop: "0.4rem", marginBottom: 0 }}>
                  Grid spacing used for the 3D viewer only. Coarser is faster
                  to load and to move the isovalue slider on. The pipeline
                  always computes, stores and lets you download the full grids.
                </p>

                <label className="nb-label" htmlFor="pocket-mode-input" style={{ marginTop: "0.9rem" }}>
                  Pocket shape
                </label>
                <div style={{ display: "flex", gap: "0.4rem" }}>
                  {POCKET_MODES.map((m, i) => (
                    <button
                      key={m.value}
                      type="button"
                      id={i === 0 ? "pocket-mode-input" : undefined}
                      className={`nb-btn nb-btn--sm ${pocketMode === m.value ? "is-pressed" : ""}`}
                      style={{ flex: 1 }}
                      onClick={() => setPocketMode(m.value)}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
                <p className="nb-mono" style={{ fontSize: "0.7rem", opacity: 0.7, marginTop: "0.4rem", marginBottom: 0 }}>
                  Fluid pockets follow the shape of the hotspots; sphere
                  pockets are built from spheres around them.
                </p>

                <label className="nb-label" htmlFor="theme-input" style={{ marginTop: "0.9rem" }}>
                  Theme
                </label>
                <div style={{ display: "flex", gap: "0.4rem" }}>
                  {THEMES.map((t, i) => (
                    <button
                      key={t.value}
                      type="button"
                      id={i === 0 ? "theme-input" : undefined}
                      className={`nb-btn nb-btn--sm ${theme === t.value ? "is-pressed" : ""}`}
                      style={{ flex: 1 }}
                      onClick={() => {
                        setTheme(t.value);
                        setThemeState(t.value);
                      }}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
                <p className="nb-mono" style={{ fontSize: "0.7rem", opacity: 0.7, marginTop: "0.4rem", marginBottom: 0 }}>
                  Starlight is the Picard-era light palette; Classic is the
                  TNG black-and-orange one. Remembered on this browser.
                </p>
              </div>
            )}

            <div style={{ display: "flex", gap: "0.4rem", marginTop: "1rem" }}>
              <button
                type="button"
                className={`nb-btn nb-btn--sm ${mode === "file" ? "is-pressed" : ""}`}
                style={{ flex: 1 }}
                onClick={() => switchMode("file")}
              >
                Upload File
              </button>
              <button
                type="button"
                className={`nb-btn nb-btn--sm ${mode === "code" ? "is-pressed" : ""}`}
                style={{ flex: 1 }}
                onClick={() => switchMode("code")}
              >
                PDB Code
              </button>
            </div>

            <form onSubmit={handleSubmit}>
              {mode === "file" ? (
                <div
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOver(true);
                  }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={onDrop}
                  onClick={() => fileInputRef.current?.click()}
                  style={{
                    border: "3px dashed var(--lcars-frame)",
                    padding: "2rem 1rem",
                    textAlign: "center",
                    cursor: "pointer",
                    background: dragOver ? "var(--lcars-frame)" : "transparent",
                    color: dragOver ? "var(--lcars-ink)" : "var(--lcars-text-accent)",
                    marginTop: "1rem",
                    marginBottom: "1rem",
                  }}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept={ACCEPTED}
                    hidden
                    onChange={(e) => pickFile(e.target.files?.[0])}
                  />
                  {file ? (
                    <p className="nb-mono" style={{ margin: 0, wordBreak: "break-all" }}>
                      {file.name}
                    </p>
                  ) : (
                    <p style={{ margin: 0, fontWeight: 800, textTransform: "uppercase", fontSize: "0.8rem" }}>
                      Drop structure file here, or click to browse
                    </p>
                  )}
                </div>
              ) : (
                <div style={{ marginTop: "1rem", marginBottom: "1rem" }}>
                  <label className="nb-label" htmlFor="pdb-code-input">
                    PDB Code
                  </label>
                  <input
                    id="pdb-code-input"
                    className="nb-input nb-mono"
                    style={{ textTransform: "uppercase" }}
                    placeholder="e.g. 1EHZ"
                    maxLength={4}
                    autoFocus
                    value={pdbCode}
                    onChange={(e) => {
                      setError(null);
                      setChain("");
                      setPdbCode(e.target.value);
                    }}
                  />
                  <ChainPicker
                    status={chains.status}
                    chains={chains.chains}
                    error={chains.error}
                    value={chain}
                    onChange={setChain}
                  />
                </div>
              )}

              {error && (
                <p className="nb-mono" style={{ color: "var(--lcars-ink)", background: "var(--lcars-red)", borderRadius: "0.35rem", padding: "0.5em" }}>
                  ERROR: {error}
                </p>
              )}

              <button type="submit" className="nb-btn nb-btn--block" disabled={!canSubmit || submitting}>
                {submitting
                  ? mode === "code"
                    ? "Downloading..."
                    : "Submitting..."
                  : "Run Calculation"}
              </button>
            </form>
          </div>
        </div>

        {recent.length > 0 && (
          <div className="nb-panel--dark nb-panel" style={{ marginTop: "1.25rem" }}>
            <div className="nb-panel__header">Recent Calculations</div>
            <div className="nb-panel__body" style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
              {recent.map((job) => (
                <button
                  key={job.id}
                  className="nb-btn nb-btn--invert nb-btn--sm"
                  style={{ justifyContent: "space-between" }}
                  onClick={() => navigate(`/results/${job.id}`)}
                >
                  <span className="nb-mono" style={{ textTransform: "none" }}>
                    {job.filename || "structure"}
                  </span>
                  <span className="nb-mono" style={{ opacity: 0.7, textTransform: "none" }}>
                    {job.id.slice(0, 8)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {hasExamples && (
          <div className="nb-panel" style={{ marginTop: "1.25rem" }}>
            <div className="nb-panel__header">
              <span>Examples</span>
            </div>
            <div className="nb-panel__body" style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
              <p style={{ fontSize: "0.8rem", margin: 0 }}>
                Finished calculations kept on this server :)
              </p>

              {examples.calculations.map((example) => (
                <button
                  key={example.job_id}
                  className="nb-btn nb-btn--sm"
                  style={{ flexDirection: "column", alignItems: "stretch", gap: "0.25rem", textAlign: "left" }}
                  onClick={() => navigate(`/results/${example.job_id}`)}
                >
                  <span style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem" }}>
                    <span>{example.title}</span>
                    <span className="nb-mono" style={{ opacity: 0.7, textTransform: "none" }}>
                      {example.num_pockets} pockets
                    </span>
                  </span>
                  {example.description && (
                    <span
                      style={{
                        textTransform: "none",
                        letterSpacing: 0,
                        fontWeight: 600,
                        fontSize: "0.7rem",
                        lineHeight: 1.4,
                      }}
                    >
                      {example.description}
                    </span>
                  )}
                </button>
              ))}

              {examples.comparisons.length > 0 && (
                <>
                  <hr className="nb-divider" style={{ margin: "0.3rem 0" }} />
                  <span className="nb-label" style={{ marginBottom: 0 }}>
                    Example comparisons
                  </span>
                  {examples.comparisons.map((example) => (
                    <button
                      key={`${example.job_a}:${example.job_b}`}
                      className="nb-btn nb-btn--sm"
                      style={{ flexDirection: "column", alignItems: "stretch", gap: "0.25rem", textAlign: "left" }}
                      onClick={() => navigate(`/compare/${example.job_a}/${example.job_b}`)}
                    >
                      <span>{example.title}</span>
                      {example.description && (
                        <span
                          style={{
                            textTransform: "none",
                            letterSpacing: 0,
                            fontWeight: 600,
                            fontSize: "0.7rem",
                            lineHeight: 1.4,
                          }}
                        >
                          {example.description}
                        </span>
                      )}
                    </button>
                  ))}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

/**
 * Chains in the entry the typed PDB code names, looked up as soon as the
 * code is complete (see GET /api/pdb/<code>/chains). A code that isn't four
 * characters yet, an entry RCSB doesn't have, or a failed request all
 * resolve to "no chains", which just hides the picker -- submitting without
 * a chain analyzes the whole structure, which is the sensible default
 * anyway.
 */
function usePdbChains(code) {
  const [state, setState] = useState({ status: "idle", chains: [], error: null });

  useEffect(() => {
    if (!PDB_CODE_RE.test(code)) {
      setState({ status: "idle", chains: [], error: null });
      return undefined;
    }
    setState({ status: "loading", chains: [], error: null });
    // The code is only ever four characters, so this fires roughly once per
    // entry; the delay is just to skip the intermediate states while
    // someone corrects a typo.
    let cancelled = false;
    const timer = setTimeout(() => {
      listPdbChains(code)
        .then((data) => !cancelled && setState({ status: "done", chains: data.chains || [], error: null }))
        // Reported rather than swallowed: a silent no-op here is
        // indistinguishable from "this entry has no chains", and the most
        // likely cause -- a backend too old to have this endpoint -- is
        // exactly the one worth saying out loud.
        .catch((err) => !cancelled && setState({ status: "error", chains: [], error: err.message }));
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code]);

  return state;
}

/** Which chain of a fetched entry to analyze. A single-chain entry has
 *  nothing to choose, so it just reports what it found -- silence there
 *  would read as "the lookup didn't work". */
function ChainPicker({ status, chains, error, value, onChange }) {
  if (status === "idle") return null;

  if (status === "loading" || status === "error" || chains.length === 0) {
    return (
      <p className="nb-mono" style={{ fontSize: "0.7rem", marginTop: "0.6rem" }}>
        {status === "loading" ? "Looking up chains..." : `Chains unavailable: ${error || "none found"}`}
      </p>
    );
  }

  if (chains.length === 1) {
    const only = chains[0];
    return (
      <p className="nb-mono" style={{ fontSize: "0.7rem", marginTop: "0.6rem" }}>
        1 chain: {only.id}
        {only.name ? ` - ${only.name}` : ""}{" "}
        ({only.nucleic_residues > 0 ? `${only.nucleic_residues} nt` : "no nucleic acid"})
      </p>
    );
  }

  return (
    <div style={{ marginTop: "0.8rem" }}>
      <span className="nb-label">Chain ({chains.length} available)</span>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
        <button
          type="button"
          className={`nb-btn nb-btn--sm ${value === "" ? "is-pressed" : ""}`}
          onClick={() => onChange("")}
        >
          All chains
        </button>
        {chains.map((c) => (
          <button
            key={c.id}
            type="button"
            className={`nb-btn nb-btn--sm ${value === c.id ? "is-pressed" : ""}`}
            style={{ flexDirection: "column", alignItems: "stretch", gap: "0.2rem", textAlign: "left" }}
            onClick={() => onChange(c.id)}
          >
            <span style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem" }}>
              <span>Chain {c.id}</span>
              <span className="nb-mono" style={{ opacity: 0.7, textTransform: "none" }}>
                {/* The pipeline analyzes nucleic acid only, so a chain with
                    none of it would come back empty -- say so up front. */}
                {c.nucleic_residues > 0 ? `${c.nucleic_residues} nt` : "no nucleic acid"}
              </span>
            </span>
            {c.name && (
              <span
                style={{
                  textTransform: "none",
                  letterSpacing: 0,
                  fontWeight: 600,
                  fontSize: "0.68rem",
                  lineHeight: 1.4,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {c.name}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * example jobs from the server (see backend/app/examples.py). The
 * pane hides itself when there are none, storage/jobs/ is gitignored, so a
 * fresh install has nothing to show, and an empty box would just
 * look broken. A failed request is treated the same way.
 */
function useExamples() {
  const [examples, setExamples] = useState({ calculations: [], comparisons: [] });

  useEffect(() => {
    let cancelled = false;
    listExamples()
      .then((data) => {
        if (cancelled) return;
        setExamples({
          calculations: data.calculations || [],
          comparisons: data.comparisons || [],
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return examples;
}
