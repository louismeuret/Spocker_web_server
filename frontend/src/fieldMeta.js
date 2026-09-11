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
// own output -- except that APBS is charted as its two sign halves rather
// than the single magnitude bar Script8 draws. They sum to exactly that
// bar (see backend/serve_pockets.py's _sign_share), and which side the
// electrostatics come from is the whole question with a polyanion.
export const FIELD_ORDER = [
  "stacking",
  "hydrophobic",
  "hbdonors",
  "hbacceptors",
  "apbs_neg",
  "apbs_pos",
];

export const FIELD_COLORS = {
  stacking: "#55dd55",
  hydrophobic: "#88ccff",
  hbdonors: "#ff9933",
  hbacceptors: "#9933cc",
  apbs: "#2244cc",
  // The two APBS sign halves: negative potential red, positive blue -- the
  // convention every electrostatics viewer uses.
  apbs_neg: "#cc2233",
  apbs_pos: "#2244cc",
};

export const FIELD_LABELS = {
  stacking: "Stacking",
  hydrophobic: "Hydrophobic",
  hbdonors: "HB-Donors",
  hbacceptors: "HB-Acceptors",
  apbs: "APBS (magnitude)",
  apbs_neg: "APBS -",
  apbs_pos: "APBS +",
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
  // APBS is in kT/e and reaches |30| or more inside a pocket, unlike the
  // SMIF fields' 0-10 range -- 10 is low enough to show something on every
  // structure tried so far, and the slider reaches 5x that. Both halves are
  // magnitudes, so they share one scale.
  apbs: 10,
  apbs_neg: 10,
  apbs_pos: 10,
};
export const DEFAULT_FIELD_ISOVALUE = 0.1;
