import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { getJobResult, structureUrl, downloadJobUrl } from "../api";
import { useJobPolling } from "../hooks/useJobPolling";
import { addRecentJob } from "../recentJobs";
import ProgressBar from "../components/ProgressBar";
import HandProgress from "../components/HandProgress";
import { BaseStyleButtons, ViewerPane } from "../components/Layout";
import MolstarViewer from "../molstar/MolstarViewer";
import { FIELD_ORDER, FIELD_ISOVALUES, DEFAULT_FIELD_ISOVALUE } from "../fieldMeta";

// Plotly is ~1MB+ minified -- most jobs never expand a pocket's chart, so
// it's only fetched once one actually does.
const FieldContributionsPlot = lazy(() => import("../components/FieldContributionsPlot"));

const STAGE_TARGETS = { queued: 0, running: 50, done: 100, error: 100 };

export default function ResultsPage() {
  const { jobId } = useParams();
  const { meta, notFound, error: pollError } = useJobPolling(jobId);

  const [result, setResult] = useState(null);
  const [resultError, setResultError] = useState(null);
  const [visiblePocketIds, setVisiblePocketIds] = useState(new Set());
  const [baseStyle, setBaseStyle] = useState("cartoon");
  const [showPocketVolumes, setShowPocketVolumes] = useState(true);
  const [focusPocketId, setFocusPocketId] = useState(null);
  const [viewerError, setViewerError] = useState(null);
  // Any number of pockets can be expanded at once, so their field-
  // contribution charts can be read side by side.
  const [expandedPocketIds, setExpandedPocketIds] = useState(new Set());
  const [residueVisiblePocketIds, setResidueVisiblePocketIds] = useState(new Set());
  // Every field preview currently drawn, each with its own isovalue:
  // [{ pocketId, field, isovalue }]. Several can be on together (two fields
  // in one pocket, or the same field across two pockets) -- that comparison
  // is the whole point of showing them on the structure at all.
  const [fieldSelections, setFieldSelections] = useState([]);
  // Both belong to the page, not to any one chart: they only mean anything
  // when every pocket's chart obeys them at once (see FieldContributionsPlot).
  const [chartType, setChartType] = useState("bar"); // bar | pie
  const [sameScale, setSameScale] = useState(false);
  // Off by default: in a sidebar this narrow the legend costs half the pie,
  // and hovering a slice already names it.
  const [showLegend, setShowLegend] = useState(false);
  const viewerRef = useRef(null);
  const clearFocus = useCallback(() => setFocusPocketId(null), []);

  // Pocket toggles (visibility, lining residues, expanded) flip one id in a Set.
  function toggleIn(setIds, id) {
    setIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Clicking a bar in pocket `pocketId`'s chart adds that field's preview,
  // scoped to that pocket; clicking the same bar again removes it. New
  // previews start at the field's tuned default isovalue (see fieldMeta.js).
  function toggleField(pocketId, field) {
    setFieldSelections((prev) => {
      const isSelected = (s) => s.pocketId === pocketId && s.field === field;
      if (prev.some(isSelected)) return prev.filter((s) => !isSelected(s));
      return [...prev, { pocketId, field, isovalue: FIELD_ISOVALUES[field] ?? DEFAULT_FIELD_ISOVALUE }];
    });
  }

  function setFieldIsovalue(pocketId, field, isovalue) {
    setFieldSelections((prev) =>
      prev.map((s) => (s.pocketId === pocketId && s.field === field ? { ...s, isovalue } : s))
    );
  }

  // The biggest contribution any pocket has, which every chart's y-axis is
  // pinned to while "same scale" is on. Without it each chart autoscales to
  // its own biggest field, so a weak pocket and a strong one draw identical
  // bars and nothing can be compared across pockets.
  const chartYMax = useMemo(() => {
    if (!sameScale || !result) return null;
    const all = result.pockets.flatMap((p) =>
      FIELD_ORDER.map((f) => p.field_contributions?.[f] ?? 0)
    );
    const max = Math.max(0, ...all);
    return max > 0 ? max * 1.05 : null;
  }, [sameScale, result]);

  // Once the job is done, fetch the pocket-detection results.
  useEffect(() => {
    if (meta?.status !== "done") return;
    let cancelled = false;
    getJobResult(jobId)
      .then((data) => {
        if (cancelled) return;
        setResult(data);
        setVisiblePocketIds(new Set(data.pockets.map((p) => p.id)));
      })
      .catch((err) => !cancelled && setResultError(err.message));
    return () => {
      cancelled = true;
    };
  }, [jobId, meta?.status]);

  // Remember this job locally so it shows up on the input page's history.
  useEffect(() => {
    if (meta?.filename) addRecentJob({ id: jobId, filename: meta.filename });
  }, [jobId, meta?.filename]);

  // The viewer is only ever mounted once the job is "done" (see below), by
  // which point the backend has always converted the structure to a
  // cleaned PDB file (see /api/jobs/<id>/structure) regardless of the
  // original upload format.
  const format = "pdb";

  function showAll() {
    if (result) setVisiblePocketIds(new Set(result.pockets.map((p) => p.id)));
  }

  function hideAll() {
    setVisiblePocketIds(new Set());
  }

  function downloadResultJson() {
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${jobId}_pockets.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (notFound) {
    return (
      <CenteredMessage title="404">
        No job found for <span className="nb-mono">{jobId}</span>. Check the UUID and try again.
      </CenteredMessage>
    );
  }

  if (!meta) {
    return <CenteredMessage title="Loading...">Fetching job status.</CenteredMessage>;
  }

  const isRunning = meta.status === "queued" || meta.status === "running";
  const isError = meta.status === "error";

  return (
    <main style={{ flex: 1, display: "flex", minHeight: 0 }}>
      {/* Left column: job info + pocket toggles + view controls */}
      <aside
        className="nb-panel nb-scroll nb-resize-x"
        style={{ width: "22rem", flex: "none", margin: "1rem 0 1rem 1rem", overflowY: "auto" }}
      >
        <div className="nb-panel__header">
          <span>Job</span>
          <span className="nb-tag">{meta.status}</span>
        </div>
        <div className="nb-panel__body" style={{ display: "flex", flexDirection: "column", gap: "0.9rem" }}>
          <div>
            <span className="nb-label">UUID</span>
            <div style={{ display: "flex", gap: "0.4rem" }}>
              <span className="nb-mono" style={{ fontSize: "0.72rem", wordBreak: "break-all" }}>
                {jobId}
              </span>
              <button
                className="nb-btn nb-btn--sm"
                onClick={() => navigator.clipboard?.writeText(jobId)}
                title="Copy UUID"
              >
                Copy
              </button>
            </div>
          </div>

          {meta.filename && (
            <div>
              <span className="nb-label">File</span>
              <span className="nb-mono" style={{ fontSize: "0.8rem" }}>
                {meta.filename}
              </span>
            </div>
          )}

          {(isRunning || isError) && (
            <div>
              <ProgressBar progress={meta.progress ?? STAGE_TARGETS[meta.status] ?? 0} label={meta.stage} />
              {meta.status === "queued" && meta.queue_position != null && (
                <p className="nb-mono" style={{ fontSize: "0.72rem", marginTop: "0.4rem" }}>
                  Queue position: {meta.queue_position}
                </p>
              )}
              {isError && (
                <p className="nb-mono" style={{ fontSize: "0.75rem", marginTop: "0.4rem" }}>
                  ERROR: {meta.error}
                </p>
              )}
            </div>
          )}

          {pollError && (
            <p className="nb-mono" style={{ fontSize: "0.7rem" }}>
              (retrying status check: {pollError})
            </p>
          )}

          {result && (
            <>
              <hr className="nb-divider" />

              <div>
                <span className="nb-label">Structure</span>
                <p className="nb-mono" style={{ fontSize: "0.72rem", margin: 0 }}>
                  {result.structure.num_atoms} atoms · {result.structure.num_residues} residues · chains{" "}
                  {result.structure.chains.join(", ") || "-"}
                </p>
              </div>

              <div>
                <span className="nb-label">Display</span>
                <BaseStyleButtons value={baseStyle} onChange={setBaseStyle} />
                <label className="nb-toggle">
                  <input
                    type="checkbox"
                    checked={showPocketVolumes}
                    onChange={(e) => setShowPocketVolumes(e.target.checked)}
                  />
                  Pocket volumes (MRC)
                </label>
              </div>

              <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                <button className="nb-btn nb-btn--sm" onClick={() => viewerRef.current?.resetView()}>
                  Reset View
                </button>
                <button className="nb-btn nb-btn--sm" onClick={downloadResultJson}>
                  Export JSON
                </button>
                <a className="nb-btn nb-btn--sm" href={downloadJobUrl(jobId)} download>
                  Download Results
                </a>
              </div>

              <hr className="nb-divider" />

              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span className="nb-label" style={{ marginBottom: 0 }}>
                    Pockets ({result.pockets.length})
                  </span>
                  <div style={{ display: "flex", gap: "0.3rem" }}>
                    <button className="nb-btn nb-btn--sm" onClick={showAll}>
                      All
                    </button>
                    <button className="nb-btn nb-btn--sm" onClick={hideAll}>
                      None
                    </button>
                  </div>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", marginTop: "0.5rem" }}>
                  <span className="nb-label" style={{ marginBottom: 0 }}>
                    Chart
                  </span>
                  {["bar", "pie"].map((type) => (
                    <button
                      key={type}
                      className={`nb-btn nb-btn--sm ${chartType === type ? "is-pressed" : ""}`}
                      onClick={() => setChartType(type)}
                    >
                      {type}
                    </button>
                  ))}
                  {chartType === "bar" ? (
                    <button
                      className={`nb-btn nb-btn--sm ${sameScale ? "is-pressed" : ""}`}
                      style={{ marginLeft: "auto" }}
                      onClick={() => setSameScale((v) => !v)}
                      title="Pin every pocket's chart to one y-axis so their bars are comparable"
                    >
                      Same scale
                    </button>
                  ) : (
                    <button
                      className={`nb-btn nb-btn--sm ${showLegend ? "is-pressed" : ""}`}
                      style={{ marginLeft: "auto" }}
                      onClick={() => setShowLegend((v) => !v)}
                      title="Show the field legend for the pies"
                    >
                      Legend
                    </button>
                  )}
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginTop: "0.6rem" }}>
                  {result.pockets.map((pocket) => (
                    <PocketRow
                      key={pocket.id}
                      pocket={pocket}
                      visible={visiblePocketIds.has(pocket.id)}
                      onToggle={() => toggleIn(setVisiblePocketIds, pocket.id)}
                      onFocus={() => setFocusPocketId(pocket.id)}
                      expanded={expandedPocketIds.has(pocket.id)}
                      onToggleExpanded={() => toggleIn(setExpandedPocketIds, pocket.id)}
                      availableFields={result.fields}
                      selections={fieldSelections.filter((s) => s.pocketId === pocket.id)}
                      onSelectField={(field) => toggleField(pocket.id, field)}
                      onIsovalueChange={(field, value) => setFieldIsovalue(pocket.id, field, value)}
                      chartType={chartType}
                      chartYMax={chartYMax}
                      showLegend={showLegend}
                      showResidues={residueVisiblePocketIds.has(pocket.id)}
                      onToggleResidues={() => toggleIn(setResidueVisiblePocketIds, pocket.id)}
                    />
                  ))}
                </div>
              </div>
            </>
          )}

          {resultError && (
            <p className="nb-mono" style={{ fontSize: "0.75rem" }}>
              ERROR loading result: {resultError}
            </p>
          )}
        </div>
      </aside>

      {}
      <ViewerPane error={viewerError}>
        {isRunning && (
          <CenteredOverlay>
            <HandProgress progress={meta.progress ?? 0} label={`${meta.stage}...`} />
          </CenteredOverlay>
        )}
        {isError && (
          <CenteredOverlay>
            <p>Calculation failed.</p>
            <p className="nb-mono" style={{ fontSize: "0.8rem" }}>
              {meta.error}
            </p>
          </CenteredOverlay>
        )}
        {meta.status === "done" && result && (
          <MolstarViewer
            ref={viewerRef}
            structureUrl={structureUrl(jobId)}
            format={format}
            jobId={jobId}
            pockets={result.pockets}
            visiblePocketIds={visiblePocketIds}
            visibleResiduePocketIds={residueVisiblePocketIds}
            baseStyle={baseStyle}
            showPocketVolumes={showPocketVolumes}
            fieldSelections={fieldSelections}
            focusPocketId={focusPocketId}
            onFocusApplied={clearFocus}
            onError={setViewerError}
          />
        )}
      </ViewerPane>
    </main>
  );
}

function PocketRow({
  pocket,
  visible,
  onToggle,
  onFocus,
  expanded,
  onToggleExpanded,
  availableFields,
  selections,
  onSelectField,
  onIsovalueChange,
  chartType,
  chartYMax,
  showLegend,
  showResidues,
  onToggleResidues,
}) {
  const hasFields = availableFields?.length > 0;
  return (
    <div className="nb-panel" style={{ boxShadow: "none", padding: "0.5rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <label className="nb-toggle">
          <input type="checkbox" checked={visible} onChange={onToggle} />
          <span className="nb-toggle__swatch" style={{ background: pocket.color, borderColor: pocket.color }} />
        </label>
        <button
          className="nb-btn nb-btn--sm"
          style={{ flex: 1, minWidth: 0, display: "flex", justifyContent: "flex-start", overflow: "hidden" }}
          onClick={onToggleExpanded}
          title="Pocket details"
        >
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            #{pocket.rank} {pocket.name}
          </span>
          <span style={{ marginLeft: "auto" }}>{expanded ? "▾" : "▸"}</span>
        </button>
        <button className="nb-btn nb-btn--sm" onClick={onFocus}>
          Focus
        </button>
      </div>
      <div className="nb-mono" style={{ fontSize: "0.68rem", marginTop: "0.35rem", display: "flex", gap: "0.7rem" }}>
        <span>score {pocket.score}</span>
        <span>vol {pocket.volume}A3</span>
        <span>SA {pocket.surface_area}A2</span>
      </div>
      {expanded && (
        <div style={{ marginTop: "0.5rem", borderTop: "2px solid var(--lcars-lilac)", paddingTop: "0.35rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <label className="nb-toggle">
            <input type="checkbox" checked={showResidues} onChange={onToggleResidues} />
            <span className="nb-mono" style={{ fontSize: "0.7rem" }}>
              Show lining residues ({pocket.residues.length})
            </span>
          </label>
          {hasFields && (
            <Suspense fallback={<p className="nb-mono" style={{ fontSize: "0.68rem" }}>Loading chart...</p>}>
              <FieldContributionsPlot
                fieldContributions={pocket.field_contributions}
                availableFields={availableFields}
                selections={selections}
                onSelectField={onSelectField}
                onIsovalueChange={onIsovalueChange}
                chartType={chartType}
                yMax={chartYMax}
                showLegend={showLegend}
              />
            </Suspense>
          )}
        </div>
      )}
    </div>
  );
}

function CenteredOverlay({ children }) {
  return (
    <div className="nb-viewer-overlay" style={{ flexDirection: "column", gap: "0.5rem", textAlign: "center", padding: "1rem" }}>
      {children}
    </div>
  );
}

function CenteredMessage({ title, children }) {
  return (
    <main style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "2rem" }}>
      <div className="nb-panel" style={{ padding: "1.5rem 2rem", textAlign: "center", maxWidth: "26rem" }}>
        <h2>{title}</h2>
        <p style={{ marginBottom: 0 }}>{children}</p>
      </div>
    </main>
  );
}
