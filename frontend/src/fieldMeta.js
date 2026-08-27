/**
 * Metadata for the raw SMIF field grids the pipeline scores pockets
 * against (apbs/stacking/hydrophobic/hbacceptors/hbdonors -- see
 * backend/new_spocker/Script8's FIELD_NAMES_CSV/FIELD_COLORS/
 * FIELD_LABELS_DISPLAY, and backend/serve_pockets.py's FIELD_NAMES, which
 * this must stay in sync with).
 *
 * Shared by FieldContributionsPlot.jsx (bar colors/labels) and
 * buildScene.js (isosurface color + isovalue when previewing a field on
 * hover).
 */

// Same order/colors Script8 uses in its own matplotlib plot, so this UI's
// chart reads as "the same plot" to someone who has seen the pipeline's
// own output.
export const FIELD_ORDER = ["stacking", "hydrophobic", "hbdonors", "hbacceptors", "apbs"];

export const FIELD_COLORS = {
  stacking: "#55dd55",
  hydrophobic: "#88ccff",
  hbdonors: "#ff9933",
  hbacceptors: "#9933cc",
  apbs: "#2244cc",
};

export const FIELD_LABELS = {
  stacking: "Stacking",
  hydrophobic: "Hydrophobic",
  hbdonors: "HB-Donors",
  hbacceptors: "HB-Acceptors",
  apbs: "APBS (magnitude)",
};

// Absolute isovalues tuned per field type, carried over from this repo's
// own vmd_volgrid/vmd_smiffer.tcl (initialize_volume_rendering) -- these
// fields' value ranges vary enough by type that a single generic threshold
// either shows nothing or shows everything.
export const FIELD_ISOVALUES = {
  hydrophobic: 0.05,
  hbacceptors: 0.15,
  hbdonors: 0.15,
  stacking: 0.12,
  apbs: 0.5,
};
export const DEFAULT_FIELD_ISOVALUE = 0.1;
