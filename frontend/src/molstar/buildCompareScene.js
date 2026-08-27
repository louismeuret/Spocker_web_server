import { pocketVolumeUrl, structureUrl } from "../api";

/**
 * Builds the MolViewSpec scene for compare mode: two structures in one
 * viewer, with their pockets colored by whether they are shared or unique.
 *
 * Superposition
 * -------------
 * The backend (see backend/app/compare.py) returns the rigid transform taking
 * job B onto job A: a 3x3 rotation flattened column-major plus a translation,
 * exactly the shape MVS's `transform` node wants. When `align` is on we attach
 * that transform to B's structure node *and* to every one of B's pocket volume
 * grids, so the whole of B moves as one rigid body.
 *
 * Transforming the volumes matters: a pocket's real geometry lives in an MRC
 * grid whose header only stores an origin, so a rotated grid cannot be
 * expressed as a file. Mol* applies the rotation to the grid-to-cartesian
 * matrix at render time instead, which means the pockets follow their
 * structure without anything being resampled or re-written on the server.
 *
 * Reading the result
 * ------------------
 * - Backbones are neutral greys, light for A and dark for B, so they never
 *   compete with the pocket colors.
 * - A shared pocket's two halves get the same palette color, with A drawn as
 *   a solid blob and B as a wireframe cage over it -- you can see at a glance
 *   both that they pair up and how their shapes differ.
 * - Pockets found in only one job get that job's identity color (blue for A,
 *   orange for B), which is the actual question being asked: which pockets are
 *   different.
 */

// Colour-blind-safe pair (Okabe-Ito blue/vermillion), used for the two jobs'
// identities everywhere in compare mode -- the sidebar legend, the "only in
// A"/"only in B" lists, and these unique-pocket isosurfaces.
export const JOB_A_COLOR = "#0072b2";
export const JOB_B_COLOR = "#d55e00";

// Backbone greys: light for A, dark for B. Both are neutral, so a colored
// pocket always reads as a pocket and never as "the other structure".
const BACKBONE_A_COLOR = "#c8c8c8";
const BACKBONE_B_COLOR = "#4d4d4d";

// One color per matched pair, shared by both halves. Same palette the
// single-job view uses for its pockets (see backend/app/spocker_bridge.py's
// POCKET_COLORS), so a pocket looks familiar across the two pages.
export const PAIR_COLORS = [
  "#e6194B", "#3cb44b", "#f58231", "#911eb4", "#42d4f4",
  "#f032e6", "#bfef45", "#fabed4", "#469990", "#9A6324",
];

export function pairColor(index) {
  return PAIR_COLORS[index % PAIR_COLORS.length];
}

const POCKET_ISOVALUE = 0.5;

/**
 * @param {object} molstarLib - the `molstar.lib` namespace from the global bundle
 * @param {object} opts
 * @param {object} opts.comparison - the payload from GET /api/compare/<a>/<b>
 * @param {boolean} opts.align - apply the RMSD superposition to job B
 * @param {Set<string>} opts.visibleIds - which entries are shown; ids are the
 *   pair ids ("pair_1") for shared pockets, and "a:<pocket_id>" / "b:<pocket_id>"
 *   for the ones unique to one job
 * @param {boolean} opts.showA - draw job A's structure at all
 * @param {boolean} opts.showB - draw job B's structure at all
 * @param {'cartoon'|'surface'} opts.baseStyle - representation for the backbones
 * @param {string|null} opts.focusId - if set, the camera focuses this entry
 */
export function buildCompareState(molstarLib, opts) {
  const { comparison, align, visibleIds, showA, showB, baseStyle, focusId } = opts;
  const { createBuilder } = molstarLib.extensions.mvs;

  const builder = createBuilder();
  builder.canvas({ background_color: "#ffffff" });

  // Only B moves: keeping A fixed means its results page and this page show
  // the same structure in the same place, which makes flipping between them
  // far less disorienting.
  const transform = align
    ? { rotation: comparison.alignment.rotation, translation: comparison.alignment.translation }
    : null;

  const structureA = showA ? loadStructure(builder, comparison.a.id, null) : null;
  const structureB = showB ? loadStructure(builder, comparison.b.id, transform) : null;

  if (structureA) {
    structureA
      .component({ selector: "polymer" })
      .representation({ type: baseStyle === "surface" ? "surface" : "cartoon" })
      .color({ color: BACKBONE_A_COLOR });
  }
  if (structureB) {
    structureB
      .component({ selector: "polymer" })
      .representation({ type: baseStyle === "surface" ? "surface" : "cartoon" })
      .color({ color: BACKBONE_B_COLOR });
  }

  const pocketsA = new Map(comparison.a.pockets.map((p) => [p.id, p]));
  const pocketsB = new Map(comparison.b.pockets.map((p) => [p.id, p]));

  let focusTarget = null;
  const claimFocus = (id, node) => {
    if (id === focusId && node) focusTarget = node;
  };

  comparison.pockets.common.forEach((pair, index) => {
    if (!visibleIds.has(pair.id)) return;
    const color = pairColor(index);
    if (showA && pocketsA.has(pair.a_id)) {
      const volume = addPocketVolume(builder, comparison.a.id, pair.a_id, color, null, {
        wireframe: false,
      });
      claimFocus(pair.id, volume);
    }
    if (showB && pocketsB.has(pair.b_id)) {
      // Wireframe so B's half of a pair reads as a cage over A's solid blob
      // rather than the two blending into one ambiguous surface.
      const volume = addPocketVolume(builder, comparison.b.id, pair.b_id, color, transform, {
        wireframe: true,
      });
      if (!focusTarget) claimFocus(pair.id, volume);
    }
  });

  if (showA) {
    for (const pocketId of comparison.pockets.only_a) {
      const id = `a:${pocketId}`;
      if (!visibleIds.has(id)) continue;
      claimFocus(
        id,
        addPocketVolume(builder, comparison.a.id, pocketId, JOB_A_COLOR, null, { wireframe: false })
      );
    }
  }

  if (showB) {
    for (const pocketId of comparison.pockets.only_b) {
      const id = `b:${pocketId}`;
      if (!visibleIds.has(id)) continue;
      claimFocus(
        id,
        addPocketVolume(builder, comparison.b.id, pocketId, JOB_B_COLOR, transform, {
          wireframe: false,
        })
      );
    }
  }

  if (focusTarget) focusTarget.focus({});

  return builder.getState();
}

function loadStructure(builder, jobId, transform) {
  const structure = builder
    .download({ url: structureUrl(jobId) })
    .parse({ format: "pdb" })
    .modelStructure();
  if (transform) structure.transform(transform);
  return structure;
}

function addPocketVolume(builder, jobId, pocketId, color, transform, { wireframe }) {
  // MRC and CCP4 are the same binary format, hence format: "map".
  const volume = builder
    .download({ url: pocketVolumeUrl(jobId, pocketId) })
    .parse({ format: "map" })
    .volume();
  if (transform) volume.transform(transform);

  const representation = volume.representation({
    type: "isosurface",
    absolute_isovalue: POCKET_ISOVALUE,
    show_faces: !wireframe,
    show_wireframe: wireframe,
  });
  representation.color({ color });
  representation.opacity({ opacity: wireframe ? 0.9 : 0.45 });

  // The camera focuses the volume node, not the representation -- `focus`
  // lives on the volume in MVS's builder.
  return volume;
}
