import { useMemo } from "react";
import createPlotlyComponent from "react-plotly.js/factory";
import Plotly from "plotly.js-dist-min";
import { FIELD_ORDER, FIELD_COLORS, FIELD_LABELS, FIELD_ISOVALUES, DEFAULT_FIELD_ISOVALUE } from "../fieldMeta";

const Plot = createPlotlyComponent(Plotly);

/**
 * Bar chart of one pocket's field-contribution ratios -- the same numbers
 * backend/new_spocker/Script8 plots for itself (see
 * generate_field_contribution_plot), just for a single pocket and
 * interactive instead of a static PNG.
 *
 * Clicking a bar loads that field's raw MRC grid as an isosurface in the
 * 3D viewer (see ResultsPage's selectedField state) -- "where is the
 * stacking field", etc. Clicking the same bar again clears it. Once a
 * field is selected, a slider below the chart controls its isovalue live.
 */
export default function FieldContributionsPlot({
  fieldContributions,
  availableFields,
  selectedField,
  onSelectField,
  isovalue,
  onIsovalueChange,
}) {
  const fields = useMemo(
    () => FIELD_ORDER.filter((f) => availableFields?.includes(f)),
    [availableFields]
  );

  if (fields.length === 0) return null;

  const values = fields.map((f) => fieldContributions?.[f] ?? 0);
  const colors = fields.map((f) => FIELD_COLORS[f]);
  const labels = fields.map((f) => FIELD_LABELS[f] || f);
  const lineWidths = fields.map((f) => (f === selectedField ? 4 : 2));

  const showSlider = selectedField && fields.includes(selectedField);
  const defaultIso = FIELD_ISOVALUES[selectedField] ?? DEFAULT_FIELD_ISOVALUE;
  const sliderMax = defaultIso * 5;
  const sliderStep = defaultIso / 50;

  return (
    <div>
      <Plot
        data={[
          {
            type: "bar",
            x: labels,
            y: values,
            customdata: fields,
            marker: { color: colors, line: { color: "#000000", width: lineWidths } },
            hovertemplate: "%{x}: %{y:.3f}<extra></extra>",
          },
        ]}
        layout={{
          autosize: true,
          height: 170,
          margin: { l: 36, r: 8, t: 8, b: 40 },
          paper_bgcolor: "transparent",
          plot_bgcolor: "transparent",
          font: { family: "var(--nb-mono), monospace", color: "#000000", size: 10 },
          xaxis: { tickfont: { size: 9 }, linecolor: "#000000", linewidth: 2 },
          yaxis: {
            title: { text: "contribution ratio", font: { size: 9 } },
            gridcolor: "rgba(0,0,0,0.15)",
            zerolinecolor: "#000000",
            linecolor: "#000000",
            linewidth: 2,
          },
          bargap: 0.35,
        }}
        config={{ displayModeBar: false, responsive: true, staticPlot: false }}
        style={{ width: "100%" }}
        onClick={(event) => {
          const field = event?.points?.[0]?.customdata;
          if (!field) return;
          onSelectField?.(field === selectedField ? null : field);
        }}
      />
      {showSlider && (
        <div style={{ marginTop: "0.3rem" }}>
          <div
            className="nb-mono"
            style={{ display: "flex", justifyContent: "space-between", fontSize: "0.65rem", marginBottom: "0.2rem" }}
          >
            <span>{FIELD_LABELS[selectedField] || selectedField} isovalue</span>
            <span>{isovalue.toFixed(3)}</span>
          </div>
          <input
            className="nb-slider"
            type="range"
            min={0}
            max={sliderMax}
            step={sliderStep}
            value={isovalue}
            onChange={(e) => onIsovalueChange?.(Number(e.target.value))}
          />
        </div>
      )}
    </div>
  );
}
