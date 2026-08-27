import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { compareJobs, listExamples } from "../api";
import { getRecentJobs } from "../recentJobs";
import CompareViewer from "../molstar/CompareViewer";
import { BaseStyleButtons, ViewerPane } from "../components/Layout";
import { JOB_A_COLOR, JOB_B_COLOR, pairColor } from "../molstar/buildCompareScene";

/**
 * Compare mode: two finished calculations in one viewer.
 *
 * The two UUIDs live in the URL (/compare/:jobIdA/:jobIdB) so a comparison is
 * a link you can send someone, like a single job's results page. The form
 * edits them; submitting navigates, which is what triggers the fetch.
 *
 * "Align" is a display toggle only. The pocket pairing is always computed in
 * the superposed frame by the backend (see backend/app/compare.py) -- which
 * pocket corresponds to which shouldn't change with how you're looking at them.
 */
export default function ComparePage() {
  const navigate = useNavigate();
  const { jobIdA, jobIdB } = useParams();

  const [inputA, setInputA] = useState(jobIdA || "");
  const [inputB, setInputB] = useState(jobIdB || "");
  const [comparison, setComparison] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const [align, setAlign] = useState(true);
  const [showA, setShowA] = useState(true);
  const [showB, setShowB] = useState(true);
  const [baseStyle, setBaseStyle] = useState("cartoon");
  const [spin, setSpin] = useState(false);
  const [visibleIds, setVisibleIds] = useState(new Set());
  const [focusId, setFocusId] = useState(null);
  const [viewerError, setViewerError] = useState(null);

  const viewerRef = useRef(null);
  const clearFocus = useCallback(() => setFocusId(null), []);

  const suggestions = useJobSuggestions();

  // Keep the form in step with the URL (back/forward, or a link followed from
  // the examples pane).
  useEffect(() => {
    setInputA(jobIdA || "");
    setInputB(jobIdB || "");
  }, [jobIdA, jobIdB]);

  useEffect(() => {
    if (!jobIdA || !jobIdB) {
      setComparison(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setViewerError(null);
    compareJobs(jobIdA, jobIdB)
      .then((data) => {
        if (cancelled) return;
        setComparison(data);
        setVisibleIds(new Set(allEntryIds(data)));
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setComparison(null);
        setError(err.message);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [jobIdA, jobIdB]);

  const trimmedA = inputA.trim();
  const trimmedB = inputB.trim();
  const canSubmit = trimmedA && trimmedB && trimmedA !== trimmedB;

  function handleSubmit(e) {
    e.preventDefault();
    if (!canSubmit) return;
    navigate(`/compare/${trimmedA}/${trimmedB}`);
  }

  function swap() {
    setInputA(trimmedB);
    setInputB(trimmedA);
    if (jobIdA && jobIdB) navigate(`/compare/${jobIdB}/${jobIdA}`);
  }

  function toggleEntry(id) {
    setVisibleIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const entries = useMemo(() => (comparison ? buildEntries(comparison) : null), [comparison]);

  return (
    <main style={{ flex: 1, display: "flex", minHeight: 0 }}>
      <aside
        className="nb-panel nb-scroll"
        style={{ width: "23rem", flex: "none", margin: "1rem 0 1rem 1rem", overflowY: "auto" }}
      >
        <div className="nb-panel__header">
          <span>Compare</span>
          {comparison && <span className="nb-tag">RMSD {comparison.alignment.rmsd} A</span>}
        </div>
        <div className="nb-panel__body" style={{ display: "flex", flexDirection: "column", gap: "0.9rem" }}>
          <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
            <datalist id="compare-job-suggestions">
              {suggestions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </datalist>

            <UuidField label="A" swatch={JOB_A_COLOR} value={inputA} onChange={setInputA} autoFocus={!jobIdA} />
            <UuidField label="B" swatch={JOB_B_COLOR} value={inputB} onChange={setInputB} />

            <div style={{ display: "flex", gap: "0.4rem" }}>
              <button type="submit" className="nb-btn nb-btn--sm" style={{ flex: 1 }} disabled={!canSubmit}>
                {loading ? "Comparing..." : "Compare"}
              </button>
              <button
                type="button"
                className="nb-btn nb-btn--sm"
                onClick={swap}
                disabled={!trimmedA || !trimmedB}
                title="Swap A and B"
              >
                Swap
              </button>
            </div>
          </form>

          <label className="nb-toggle">
            <input type="checkbox" checked={align} onChange={(e) => setAlign(e.target.checked)} />
            Align (RMSD)
          </label>

          {error && (
            <p
              className="nb-mono"
              style={{ fontSize: "0.72rem", border: "2px solid #000", padding: "0.5em", margin: 0 }}
            >
              ERROR: {error}
            </p>
          )}

          {comparison && entries && (
            <>
              <hr className="nb-divider" />

              <div className="nb-mono" style={{ fontSize: "0.68rem", lineHeight: 1.6 }}>
                <div>
                  RMSD {comparison.alignment.rmsd} A / {comparison.alignment.matched_residues} res
                </div>
                <div>
                  A {comparison.a.filename || comparison.a.id.slice(0, 8)} - {comparison.a.pockets.length} pockets
                </div>
                <div>
                  B {comparison.b.filename || comparison.b.id.slice(0, 8)} - {comparison.b.pockets.length} pockets
                </div>
              </div>

              <div>
                <BaseStyleButtons value={baseStyle} onChange={setBaseStyle} />
                <label className="nb-toggle" style={{ marginBottom: "0.4rem" }}>
                  <input type="checkbox" checked={showA} onChange={(e) => setShowA(e.target.checked)} />
                  <span className="nb-toggle__swatch" style={{ background: JOB_A_COLOR, borderColor: JOB_A_COLOR }} />
                  Structure A
                </label>
                <label className="nb-toggle" style={{ marginBottom: "0.4rem" }}>
                  <input type="checkbox" checked={showB} onChange={(e) => setShowB(e.target.checked)} />
                  <span className="nb-toggle__swatch" style={{ background: JOB_B_COLOR, borderColor: JOB_B_COLOR }} />
                  Structure B
                </label>
                <label className="nb-toggle">
                  <input type="checkbox" checked={spin} onChange={(e) => setSpin(e.target.checked)} />
                  Spin
                </label>
              </div>

              <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                <button className="nb-btn nb-btn--sm" onClick={() => viewerRef.current?.resetView()}>
                  Reset View
                </button>
                <button
                  className="nb-btn nb-btn--sm"
                  onClick={() => setVisibleIds(new Set(allEntryIds(comparison)))}
                >
                  All
                </button>
                <button className="nb-btn nb-btn--sm" onClick={() => setVisibleIds(new Set())}>
                  None
                </button>
              </div>

              <hr className="nb-divider" />

              <EntryGroup
                title={`In both (${entries.common.length})`}
                entries={entries.common}
                visibleIds={visibleIds}
                onToggle={toggleEntry}
                onFocus={setFocusId}
              />
              <EntryGroup
                title={`Only in A (${entries.onlyA.length})`}
                entries={entries.onlyA}
                visibleIds={visibleIds}
                onToggle={toggleEntry}
                onFocus={setFocusId}
              />
              <EntryGroup
                title={`Only in B (${entries.onlyB.length})`}
                entries={entries.onlyB}
                visibleIds={visibleIds}
                onToggle={toggleEntry}
                onFocus={setFocusId}
              />
            </>
          )}
        </div>
      </aside>

      <ViewerPane error={viewerError}>
        {comparison ? (
          <CompareViewer
            ref={viewerRef}
            comparison={comparison}
            align={align}
            visibleIds={visibleIds}
            showA={showA}
            showB={showB}
            baseStyle={baseStyle}
            spin={spin}
            focusId={focusId}
            onFocusApplied={clearFocus}
            onError={setViewerError}
          />
        ) : (
          <div className="nb-viewer-overlay">
            <p className="nb-mono" style={{ margin: 0 }}>
              {loading ? "SUPERPOSING..." : "ENTER TWO JOB UUIDS"}
            </p>
          </div>
        )}
      </ViewerPane>
    </main>
  );
}

/**
 * Recent jobs from this browser plus the server's curated examples, offered as
 * a datalist on both UUID fields -- typing a 32-character hex string from
 * memory is nobody's idea of a good time.
 */
function useJobSuggestions() {
  const [examples, setExamples] = useState([]);

  useEffect(() => {
    let cancelled = false;
    listExamples()
      .then((data) => !cancelled && setExamples(data.calculations || []))
      // Suggestions are a convenience; a failure here must not disturb the page.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const job of getRecentJobs()) {
      if (seen.has(job.id)) continue;
      seen.add(job.id);
      out.push({ id: job.id, label: job.filename || "structure" });
    }
    for (const example of examples) {
      if (seen.has(example.job_id)) continue;
      seen.add(example.job_id);
      out.push({ id: example.job_id, label: `${example.title} (example)` });
    }
    return out;
  }, [examples]);
}

function UuidField({ label, swatch, value, onChange, autoFocus }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
      <span className="nb-toggle__swatch" style={{ background: swatch, borderColor: swatch, flex: "none" }} />
      <span className="nb-label" style={{ margin: 0, flex: "none" }}>
        {label}
      </span>
      <input
        className="nb-input nb-mono"
        style={{ fontSize: "0.72rem" }}
        placeholder="job uuid"
        list="compare-job-suggestions"
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function EntryGroup({ title, entries, visibleIds, onToggle, onFocus }) {
  return (
    <div style={{ marginBottom: "0.9rem" }}>
      <span className="nb-label">{title}</span>
      {entries.length === 0 ? (
        <p className="nb-mono" style={{ fontSize: "0.7rem", margin: 0 }}>
          --
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
          {entries.map((entry) => (
            <div key={entry.id} className="nb-panel" style={{ boxShadow: "none", padding: "0.5rem" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <label className="nb-toggle">
                  <input
                    type="checkbox"
                    checked={visibleIds.has(entry.id)}
                    onChange={() => onToggle(entry.id)}
                  />
                  <span
                    className="nb-toggle__swatch"
                    style={{ background: entry.color, borderColor: entry.color }}
                  />
                </label>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: "0.75rem",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={entry.title}
                >
                  {entry.title}
                </span>
                <button className="nb-btn nb-btn--sm" onClick={() => onFocus(entry.id)}>
                  Focus
                </button>
              </div>
              <div
                className="nb-mono"
                style={{ fontSize: "0.66rem", marginTop: "0.35rem", display: "flex", gap: "0.7rem", flexWrap: "wrap" }}
              >
                {entry.stats.map((stat) => (
                  <span key={stat}>{stat}</span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Ids the viewer toggles on: pair ids for shared pockets, side-prefixed
 *  pocket ids for the ones unique to one job. Must stay in step with
 *  buildCompareScene.js, which reads the same ids out of `visibleIds`. */
function allEntryIds(comparison) {
  return [
    ...comparison.pockets.common.map((pair) => pair.id),
    ...comparison.pockets.only_a.map((id) => `a:${id}`),
    ...comparison.pockets.only_b.map((id) => `b:${id}`),
  ];
}

function buildEntries(comparison) {
  const pocketsA = new Map(comparison.a.pockets.map((p) => [p.id, p]));
  const pocketsB = new Map(comparison.b.pockets.map((p) => [p.id, p]));

  const common = comparison.pockets.common.map((pair, index) => {
    const pocketA = pocketsA.get(pair.a_id);
    const pocketB = pocketsB.get(pair.b_id);
    return {
      id: pair.id,
      color: pairColor(index),
      title: `A#${pocketA?.rank ?? "?"} / B#${pocketB?.rank ?? "?"} ${pocketA?.name ?? ""}`,
      stats: [
        `${Math.round(pair.residue_overlap * 100)}% shared`,
        `${pair.center_distance}A apart`,
        `vol ${signed(pair.volume_delta)}`,
      ],
    };
  });

  const onlyA = comparison.pockets.only_a.map((pocketId) => {
    const pocket = pocketsA.get(pocketId);
    return {
      id: `a:${pocketId}`,
      color: JOB_A_COLOR,
      title: `A#${pocket?.rank ?? "?"} ${pocket?.name ?? pocketId}`,
      stats: pocketStats(pocket),
    };
  });

  const onlyB = comparison.pockets.only_b.map((pocketId) => {
    const pocket = pocketsB.get(pocketId);
    return {
      id: `b:${pocketId}`,
      color: JOB_B_COLOR,
      title: `B#${pocket?.rank ?? "?"} ${pocket?.name ?? pocketId}`,
      stats: pocketStats(pocket),
    };
  });

  return { common, onlyA, onlyB };
}

function pocketStats(pocket) {
  if (!pocket) return [];
  return [`score ${pocket.score}`, `vol ${pocket.volume}A3`];
}

function signed(value) {
  return value > 0 ? `+${value}` : `${value}`;
}
