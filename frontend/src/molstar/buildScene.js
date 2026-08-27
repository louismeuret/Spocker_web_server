import { pocketVolumeUrl, pocketFieldVolumeUrl } from "../api";
import { FIELD_COLORS, FIELD_ISOVALUES, DEFAULT_FIELD_ISOVALUE } from "../fieldMeta";

// Stable MVS ref for the field-preview isosurface representation node, so
// MolstarViewer can look it up afterwards (via molstar's queryMVSRef) and
// patch just its isoValue directly when the slider moves, instead of
// rebuilding/reloading the whole scene on every tick.
export const FIELD_PREVIEW_VOLUME_REF = "field-preview-volume";

/**
 * Builds a MolViewSpec (MVS) scene describing: the uploaded structure, a
 * plain cartoon for the backbone, and one highlighted component per
 * detected pocket (colored, optionally focused -- no text labels, they
 * clutter the view fast once more than one or two pockets are visible).
 * When `showPocketVolumes` is on, each visible pocket's real MRC volume
 * grid (see GET /api/jobs/<id>/pockets/<pocket_id>/volume) is loaded and
 * shown as an isosurface -- the actual pocket geometry the pipeline
 * computed, rather than an approximation built from the lining residues.
 *
 * When `selectedField` is set (clicking a bar in a pocket's field-
 * contributions chart -- see FieldContributionsPlot.jsx), that field's MRC
 * grid *clipped to `selectedFieldPocketId`'s own pocket region* (see GET
 * /api/jobs/<id>/pockets/<pocket_id>/fields/<field_name>/volume) is also
 * loaded and shown as an isosurface, so "where is the stacking field
 * inside this pocket" is visible directly on the structure, layered on top
 * of whatever pockets are already shown. `fieldIsovalue` (driven by a
 * slider under the chart) controls its threshold live.
 *
 * MVS is Mol*'s declarative "state as data" format: we build a fresh state
 * object whenever pockets/toggles change and hand the whole thing to
 * `viewer.loadMvsData(...)`, rather than poking at Mol*'s internal plugin
 * state directly. Slightly more work per update, much easier to reason
 * about and debug (you can `console.log(JSON.stringify(state))` and read
 * exactly what will be drawn).
 *
 * @param {object} molstarLib - the `molstar.lib` namespace from the global bundle
 * @param {object} opts
 * @param {string} opts.structureUrl
 * @param {'pdb'|'mmcif'} opts.format
 * @param {string} opts.jobId - needed to build each pocket's/field's volume URL
 * @param {Array} opts.pockets - result.pockets from GET /api/jobs/<id>/result
 * @param {Set<string>} opts.visiblePocketIds
 * @param {Set<string>} [opts.visibleResiduePocketIds] - pockets whose lining
 *   residues should additionally be drawn as ball-and-stick -- opt-in per
 *   pocket (via the checkbox in that pocket's expanded panel), not shown
 *   automatically just because the pocket itself is visible
 * @param {'cartoon'|'surface'} opts.baseStyle - representation for the backbone
 * @param {boolean} opts.showPocketVolumes - render each pocket's real MRC isosurface
 * @param {string|null} opts.selectedField - raw field name to preview as an isosurface, if any
 * @param {string|null} opts.selectedFieldPocketId - which pocket to clip that field preview to
 * @param {number} [opts.fieldIsovalue] - isosurface threshold for the field preview (from the chart's slider)
 * @param {string|null} opts.focusPocketId - if set, camera focuses this pocket
 */
export function buildMvsState(molstarLib, opts) {
  const {
    structureUrl,
    format,
    jobId,
    pockets,
    visiblePocketIds,
    visibleResiduePocketIds,
    baseStyle,
    showPocketVolumes,
    selectedField,
    selectedFieldPocketId,
    fieldIsovalue,
    focusPocketId,
  } = opts;
  const { createBuilder } = molstarLib.extensions.mvs;

  const builder = createBuilder();
  builder.canvas({ background_color: "#ffffff" });

  const structure = builder.download({ url: structureUrl }).parse({ format }).modelStructure();

  const backbone = structure.component({ selector: "polymer" });
  backbone
    .representation({ type: baseStyle === "surface" ? "surface" : "cartoon" })
    .color({ color: "#cccccc" });

  // Anything that isn't polymer/water (crystallographic ligands etc.) --
  // shown small and neutral so it doesn't compete with pocket highlights.
  const hetero = structure.component({ selector: "ligand" });
  hetero.representation({ type: "ball_and_stick" }).color({ color: "#4d4d4d" });

  let focusTarget = null;

  for (const pocket of pockets) {
    if (!visiblePocketIds.has(pocket.id)) continue;
    const selector = pocket.residues.map((r) => ({
      auth_asym_id: r.chain,
      auth_seq_id: r.resi,
    }));
    if (selector.length === 0) continue;

    const comp = structure.component({ selector });
    if (visibleResiduePocketIds?.has(pocket.id)) {
      comp.representation({ type: "ball_and_stick" }).color({ color: pocket.color });
    }

    if (showPocketVolumes && jobId) {
      // The real pocket geometry the pipeline computed (see
      // backend/serve_pockets.py), loaded straight from its MRC grid --
      // MRC/CCP4 are the same binary format, hence format: "map" here.
      const volume = builder
        .download({ url: pocketVolumeUrl(jobId, pocket.id) })
        .parse({ format: "map" })
        .volume();
      volume
        .representation({ type: "isosurface", absolute_isovalue: 0.5, show_faces: true })
        .color({ color: pocket.color })
        .opacity({ opacity: 0.45 });
    } else {
      comp
        .representation({ type: "surface", surface_type: "molecular" })
        .color({ color: pocket.color })
        .opacity({ opacity: 0.4 });
    }

    if (pocket.id === focusPocketId) {
      focusTarget = comp;
    }
  }

  if (selectedField && selectedFieldPocketId && jobId) {
    const isovalue = fieldIsovalue ?? FIELD_ISOVALUES[selectedField] ?? DEFAULT_FIELD_ISOVALUE;
    const color = FIELD_COLORS[selectedField] ?? "#ffffff";
    const fieldVolume = builder
      .download({ url: pocketFieldVolumeUrl(jobId, selectedFieldPocketId, selectedField) })
      .parse({ format: "map" })
      .volume();
    fieldVolume
      .representation({
        type: "isosurface",
        absolute_isovalue: isovalue,
        show_faces: true,
        show_wireframe: true,
        ref: FIELD_PREVIEW_VOLUME_REF,
      })
      .color({ color })
      .opacity({ opacity: 0.55 });
  }

  if (focusTarget) {
    focusTarget.focus({});
  }

  return builder.getState();
}
