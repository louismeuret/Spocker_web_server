import { pocketVolumeUrl, pocketFieldVolumeUrl } from "../api";
import { FIELD_COLORS, FIELD_ISOVALUES, DEFAULT_FIELD_ISOVALUE } from "../fieldMeta";

// Stable MVS ref for each field-preview isosurface representation node, so
// MolstarViewer can look it up afterwards (via molstar's queryMVSRef) and
// patch just its isoValue directly when the slider moves, instead of
// rebuilding/reloading the whole scene on every tick. One per (pocket,
// field) pair, since several previews can be on at once.
export function fieldPreviewRef(pocketId, field) {
  return `field-preview:${pocketId}:${field}`;
}

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
 * Each entry in `fieldSelections` (one per bar clicked in some pocket's
 * field-contributions chart -- see FieldContributionsPlot.jsx) loads that
 * field's MRC grid *clipped to that entry's own pocket region* (see GET
 * /api/jobs/<id>/pockets/<pocket_id>/fields/<field_name>/volume) and shows
 * it as an isosurface, so "where is the stacking field inside this pocket"
 * is visible directly on the structure, layered on top of whatever pockets
 * are already shown. Several can be on at once, across different pockets,
 * so two fields (or the same field in two pockets) can be compared side by
 * side. Each carries its own `isovalue`, driven live by the slider under
 * its chart.
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
 * @param {Array<{pocketId: string, field: string, isovalue: number}>} [opts.fieldSelections]
 *   field previews to draw, each clipped to its own pocket
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
    fieldSelections,
    focusPocketId,
  } = opts;
  const { createBuilder } = molstarLib.extensions.mvs;

  const builder = createBuilder();
  builder.canvas({ background_color: "#000000" });

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

  for (const { pocketId, field, isovalue } of jobId ? fieldSelections ?? [] : []) {
    builder
      .download({ url: pocketFieldVolumeUrl(jobId, pocketId, field) })
      .parse({ format: "map" })
      .volume()
      // Faces only, no wireframe: the wireframe doubles the geometry mol*
      // has to rebuild on every isovalue change for no extra information.
      .representation({
        type: "isosurface",
        absolute_isovalue: isovalue ?? FIELD_ISOVALUES[field] ?? DEFAULT_FIELD_ISOVALUE,
        show_faces: true,
        ref: fieldPreviewRef(pocketId, field),
      })
      .color({ color: FIELD_COLORS[field] ?? "#ffffff" })
      .opacity({ opacity: 0.55 });
  }

  if (focusTarget) {
    focusTarget.focus({});
  }

  return builder.getState();
}
