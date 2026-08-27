import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createJob, listExamples } from "../api";
import { addRecentJob, getRecentJobs } from "../recentJobs";

const ACCEPTED = ".pdb,.ent,.cif";
const PDB_CODE_RE = /^[0-9][A-Za-z0-9]{3}$/;

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
  const canSubmit = mode === "file" ? !!file : PDB_CODE_RE.test(trimmedCode);
  const hasExamples = examples.calculations.length > 0 || examples.comparisons.length > 0;

  async function submitJob(extra) {
    setSubmitting(true);
    setError(null);
    try {
      const job =
        mode === "code"
          ? await createJob({ pdbCode: trimmedCode, ...extra })
          : await createJob({ file, ...extra });

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
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "1.5rem",
        padding: "2rem 1rem",
      }}
    >
      <div style={{ width: "min(560px, 100%)" }}>
        <div className="nb-panel">
          <div className="nb-panel__header">
            <span>New Pocket Calculation</span>
          </div>
          <div className="nb-panel__body">
            <p style={{ fontSize: "0.85rem" }}>
              Upload an RNA structure (<span className="nb-mono">.pdb</span>,{" "}
              or <span className="nb-mono">.cif</span>), or fetch one straight
              from RCSB by its PDB code. It's cleaned with PDBFixer, filtered
              down to only nucleic-acid residues. We then run the spocker
              pocket detection algorithm.
            </p>

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
                    border: "3px dashed #000",
                    padding: "2rem 1rem",
                    textAlign: "center",
                    cursor: "pointer",
                    background: dragOver ? "#000" : "transparent",
                    color: dragOver ? "#fff" : "#000",
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
                      setPdbCode(e.target.value);
                    }}
                  />
                  <p className="nb-mono" style={{ fontSize: "0.7rem", opacity: 0.7, marginTop: "0.4rem" }}>
                    Downloaded directly from files.rcsb.org.
                  </p>
                </div>
              )}

              {error && (
                <p className="nb-mono" style={{ color: "#000", background: "#fff", border: "2px solid #000", padding: "0.5em" }}>
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
