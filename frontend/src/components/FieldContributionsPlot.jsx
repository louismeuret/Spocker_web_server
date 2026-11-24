import { useMemo } from "react";
import createPlotlyComponent from "react-plotly.js/factory";
import Plotly from "plotly.js-dist-min";
import { FIELD_ORDER, FIELD_COLORS, FIELD_LABELS, FIELD_ISOVALUES, DEFAULT_FIELD_ISOVALUE } from "../fieldMeta";

const Plot = createPlotlyComponent(Plotly);

/**
 * One pocket's field-contribution ratios -- the same numbers
 * backend/new_spocker/Script8 plots for itself (see
 * generate_field_contribution_plot), just for a single pocket and
 * interactive instead of a static PNG, with APBS split into its negative
 * and positive halves (see fieldMeta's FIELD_ORDER).
 *
 * Clicking a bar or slice loads that field's MRC grid as an isosurface in
 * the 3D viewer (see ResultsPage's fieldSelections state) -- "where is the
 * stacking field", etc. Clicking it again clears it. Any number can be on
 * at once, here and across other pockets' charts; each gets its own
 * isovalue slider below the chart.
 *
 * `chartType`, `yMax` and `showLegend` are owned by ResultsPage rather than
 * by each chart, because their whole point is that every pocket's chart
 * shows the same thing the same way -- a shared `yMax` is what makes two
 * pockets' bars directly comparable, since otherwise each chart auto-ranges
 * to its own biggest field and every pocket looks alike.
 */
export default function FieldContributionsPlot({
  fieldContributions,
  availableFields,
  selections,
  onSelectField,
  onIsovalueChange,
  chartType = "bar",
  yMax = null,
  showLegend = false,
}) {
  const fields = useMemo(
    () => FIELD_ORDER.filter((f) => availableFields?.includes(f)),
    [availableFields]
  );

  if (fields.length === 0) return null;

  const values = fields.map((f) => fieldContributions?.[f] ?? 0);
  const colors = fields.map((f) => FIELD_COLORS[f]);
  const labels = fields.map((f) => FIELD_LABELS[f] || f);
  const selected = new Set((selections ?? []).map((s) => s.field));

  // Plotly hands the clicked point back with whatever we attached as
  // customdata -- the raw field name. Bar traces give it back as-is, pie
  // traces wrap it in a one-element array, so unwrap before comparing it to
  // anything (a bare array silently fails every `fields.includes` test
  // downstream while still stringifying into a working volume URL, which is
  // a confusing way to lose the isovalue slider).
  const handleClick = (event) => {
    const raw = event?.points?.[0]?.customdata;
    const field = Array.isArray(raw) ? raw[0] : raw;
    if (field) onSelectField?.(field);
  };

  // Plotly takes plain colour strings, so pull the theme's values out of
  // the document rather than hardcoding one theme's palette here.
  const rootStyle = getComputedStyle(document.documentElement);
  const theme = (name, fallback) => rootStyle.getPropertyValue(name).trim() || fallback;
  const ink = theme("--lcars-text", "#2f3749");
  const line = theme("--lcars-frame", "#37a6d1");
  const tipBg = theme("--lcars-active", "#1c3c55");
  const tipInk = theme("--lcars-ink-active", "#f3f4f7");

  const font = { family: "var(--nb-mono), monospace", color: ink, size: 10 };

  return (
    <div>
      {chartType === "pie" ? (
        <Plot
          data={[
            {
              type: "pie",
              labels,
              values,
              customdata: fields,
              sort: false,
              direction: "clockwise",
              // Percentages inside the slices; the field name comes from
              // hovering, which is what keeps this readable in a sidebar
              // this narrow.
              textinfo: "percent",
              textfont: { size: 9 },
              // Give the legend its own half of the canvas rather than
              // letting Plotly float it over the pie.
              domain: showLegend ? { x: [0, 0.52] } : { x: [0, 1] },
              marker: {
                colors,
                line: { color: ink, width: fields.map((f) => (selected.has(f) ? 4 : 2)) },
              },
              hovertemplate: "<b>%{label}</b><br>%{value:.4f} (%{percent})<extra></extra>",
            },
          ]}
          layout={{
            autosize: true,
            height: 210,
            margin: { l: 4, r: 4, t: 4, b: 4 },
            paper_bgcolor: "transparent",
            font,
            showlegend: showLegend,
            legend: { font: { size: 9 }, orientation: "v", x: 0.55, xanchor: "left", y: 0.5, yanchor: "middle" },
            hoverlabel: { bgcolor: tipBg, bordercolor: line, font: { color: tipInk, size: 10 } },
          }}
          config={{ displayModeBar: false, responsive: true }}
          style={{ width: "100%" }}
          onClick={handleClick}
        />
      ) : (
        <Plot
          data={[
            {
              type: "bar",
              x: labels,
              y: values,
              customdata: fields,
              marker: {
                color: colors,
                line: { color: ink, width: fields.map((f) => (selected.has(f) ? 4 : 2)) },
              },
              hovertemplate: "<b>%{x}</b><br>%{y:.4f}<extra></extra>",
            },
          ]}
          layout={{
            autosize: true,
            height: 170,
            margin: { l: 36, r: 8, t: 8, b: 46 },
            paper_bgcolor: "transparent",
            plot_bgcolor: "transparent",
            font,
            xaxis: { tickfont: { size: 9 }, linecolor: line, linewidth: 2 },
            yaxis: {
              title: { text: "contribution ratio", font: { size: 9 } },
              gridcolor: "rgba(127,127,127,0.25)",
              zerolinecolor: line,
              linecolor: line,
              linewidth: 2,
              // A fixed range only when comparing across pockets; otherwise
              // let Plotly autoscale this pocket on its own.
              ...(yMax ? { range: [0, yMax], autorange: false } : {}),
            },
            bargap: 0.3,
            hoverlabel: { bgcolor: tipBg, bordercolor: line, font: { color: tipInk, size: 10 } },
          }}
          config={{ displayModeBar: false, responsive: true }}
          style={{ width: "100%" }}
          onClick={handleClick}
        />
      )}
      {(selections ?? [])
        .filter((s) => fields.includes(s.field))
        .map(({ field, isovalue }) => (
          <IsovalueSlider
            key={field}
            field={field}
            isovalue={isovalue}
            onChange={(value) => onIsovalueChange?.(field, value)}
          />
        ))}
    </div>
  );
}

/** Threshold for one selected field's isosurface, ranged around that field's
 *  own tuned default (see fieldMeta.js) since the fields' value ranges differ
 *  by two orders of magnitude. */
function IsovalueSlider({ field, isovalue, onChange }) {
  const defaultIso = FIELD_ISOVALUES[field] ?? DEFAULT_FIELD_ISOVALUE;
  return (
    <div style={{ marginTop: "0.3rem" }}>
      <div
        className="nb-mono"
        style={{ display: "flex", justifyContent: "space-between", fontSize: "0.65rem", marginBottom: "0.2rem" }}
      >
        <span>
          <span
            className="nb-toggle__swatch"
            style={{
              display: "inline-block",
              verticalAlign: "-0.1em",
              marginRight: "0.35em",
              background: FIELD_COLORS[field],
              borderColor: FIELD_COLORS[field],
            }}
          />
          {FIELD_LABELS[field] || field} isovalue
        </span>
        <span>{isovalue.toFixed(3)}</span>
      </div>
      <input
        className="nb-slider"
        type="range"
        min={0}
        max={defaultIso * 5}
        step={defaultIso / 50}
        value={isovalue}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}
