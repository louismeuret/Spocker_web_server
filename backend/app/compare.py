"""
Comparison of two finished jobs: superpose the structures, then work out
which detected pockets correspond to each other and which are unique to one
side.

The geometry lives in superpose.py (pure Python, no numpy -- see its
docstring). This module is the part that knows about *jobs*: reading two
result.json files, putting B's pockets into A's frame, and pairing them up.

The returned transform maps job B onto job A. The frontend applies it in the
viewer (see frontend/src/molstar/buildCompareScene.js) via MolViewSpec
`transform` nodes on both B's structure and each of B's pocket volume grids,
so nothing has to be resampled or re-written on disk to show the two
structures superposed.

Note the pocket pairing is always computed in the superposed frame, whether
or not the user has the "align" toggle on in the viewer -- that toggle is a
display choice, and "which pocket is which" shouldn't change with it.
"""
import os

from . import jobs_store, superpose

# Two pockets are considered candidates for the same site if their lining
# residues overlap at all worth speaking of, OR if their centres land close
# together once superposed. Either alone is enough: a pocket can shift along a
# groove (keeping its residues, moving its centre) or change lining residues
# while staying put, and both still describe "the same site, changed".
MIN_RESIDUE_OVERLAP = 0.10
MAX_CENTER_DISTANCE_A = 8.0


class CompareError(RuntimeError):
    """Carries the HTTP status the route should answer with."""

    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def _load_job(job_id, label):
    if not jobs_store.exists(job_id):
        raise CompareError(f"Job {label} not found: {job_id}", status=404)

    meta = jobs_store.read_meta(job_id)
    if meta is None:
        raise CompareError(f"Job {label} has no metadata: {job_id}", status=404)
    if meta["status"] != "done":
        raise CompareError(
            f"Job {label} ({job_id}) is not finished yet (status: {meta['status']})",
            status=409,
        )

    result = jobs_store.read_result(job_id)
    if result is None:
        raise CompareError(f"Job {label} ({job_id}) has no result to compare", status=500)

    structure_path = jobs_store.processed_file_path(job_id)
    if not os.path.isfile(structure_path):
        raise CompareError(
            f"Job {label} ({job_id}) has no processed structure to superpose", status=500
        )

    return meta, result, structure_path


def _residue_key(residue):
    return (residue["chain"], residue["resi"])


def _pocket_residue_sets(pockets, residue_map=None):
    """Lining residues per pocket as a set of (chain, resi) keys.

    `residue_map` translates B's residue keys into A's namespace, so the two
    sides' sets are directly comparable even when the structures use different
    chain ids or numbering. B residues with no counterpart in A simply drop
    out -- they can't contribute to an overlap either way.
    """
    sets = {}
    for pocket in pockets:
        keys = set()
        for residue in pocket["residues"]:
            key = _residue_key(residue)
            if residue_map is None:
                keys.add(key)
            elif key in residue_map:
                keys.add(residue_map[key])
        sets[pocket["id"]] = keys
    return sets


def _jaccard(left, right):
    if not left or not right:
        return 0.0
    union = len(left | right)
    if union == 0:
        return 0.0
    return len(left & right) / union


def _distance(point_a, point_b):
    dx = point_a[0] - point_b[0]
    dy = point_a[1] - point_b[1]
    dz = point_a[2] - point_b[2]
    return (dx * dx + dy * dy + dz * dz) ** 0.5


def _pair_pockets(pockets_a, pockets_b, sets_a, sets_b, centers_b_in_a):
    """Greedy best-first pairing.

    Greedy rather than a full assignment solve (Hungarian etc.): pocket counts
    are single digits, candidates are already filtered to plausible pairs, and
    a greedy pass over a score this decisive gives the same answer while
    staying readable. Ties break on pocket rank so the same two jobs always
    compare identically.
    """
    candidates = []
    for pocket_a in pockets_a:
        for pocket_b in pockets_b:
            overlap = _jaccard(sets_a[pocket_a["id"]], sets_b[pocket_b["id"]])
            distance = _distance(pocket_a["center"], centers_b_in_a[pocket_b["id"]])
            if overlap < MIN_RESIDUE_OVERLAP and distance > MAX_CENTER_DISTANCE_A:
                continue
            candidates.append((overlap, distance, pocket_a, pocket_b))

    candidates.sort(key=lambda c: (-c[0], c[1], c[2]["rank"], c[3]["rank"]))

    used_a, used_b = set(), set()
    matches = []
    for overlap, distance, pocket_a, pocket_b in candidates:
        if pocket_a["id"] in used_a or pocket_b["id"] in used_b:
            continue
        used_a.add(pocket_a["id"])
        used_b.add(pocket_b["id"])
        matches.append((overlap, distance, pocket_a, pocket_b))

    # Assignment order is "best pair first"; presentation order is A's own
    # ranking, so the compare sidebar reads down in the same order as job A's
    # pocket list on its results page.
    matches.sort(key=lambda m: m[2]["rank"])
    common = [
        {
            "id": f"pair_{index + 1}",
            "a_id": pocket_a["id"],
            "b_id": pocket_b["id"],
            "residue_overlap": round(overlap, 3),
            "center_distance": round(distance, 2),
            "volume_delta": round(pocket_b["volume"] - pocket_a["volume"], 1),
            "score_delta": round(pocket_b["score"] - pocket_a["score"], 4),
        }
        for index, (overlap, distance, pocket_a, pocket_b) in enumerate(matches)
    ]

    only_a = [p["id"] for p in pockets_a if p["id"] not in used_a]
    only_b = [p["id"] for p in pockets_b if p["id"] not in used_b]
    return common, only_a, only_b


def compare_jobs(job_id_a, job_id_b):
    """Full comparison payload for two finished jobs. Raises CompareError
    (which carries an HTTP status) for anything the caller got wrong."""
    if job_id_a == job_id_b:
        raise CompareError("Pick two different jobs to compare", status=400)

    meta_a, result_a, structure_path_a = _load_job(job_id_a, "A")
    meta_b, result_b, structure_path_b = _load_job(job_id_b, "B")

    residues_a, order_a = superpose.parse_residues(structure_path_a)
    residues_b, order_b = superpose.parse_residues(structure_path_b)

    residue_pairs, method = superpose.match_residues(residues_a, order_a, residues_b, order_b)
    if not residue_pairs:
        raise CompareError(
            "These two structures have no residues in common -- nothing to "
            "superpose. Comparison only makes sense for related structures.",
            status=422,
        )

    coords_a, coords_b = superpose.paired_atom_coords(residues_a, residues_b, residue_pairs)
    try:
        rotation, translation, rmsd = superpose.superpose(coords_a, coords_b)
    except superpose.SuperpositionError as exc:
        raise CompareError(str(exc), status=422) from exc

    residue_map = {key_b: key_a for key_a, key_b in residue_pairs}

    sets_a = _pocket_residue_sets(result_a["pockets"])
    sets_b = _pocket_residue_sets(result_b["pockets"], residue_map=residue_map)
    centers_b_in_a = {
        pocket["id"]: superpose.apply_transform(rotation, translation, pocket["center"])
        for pocket in result_b["pockets"]
    }

    common, only_a, only_b = _pair_pockets(
        result_a["pockets"], result_b["pockets"], sets_a, sets_b, centers_b_in_a
    )

    return {
        "a": _side(meta_a, result_a),
        "b": _side(meta_b, result_b),
        "alignment": {
            "method": method,
            "matched_residues": len(residue_pairs),
            "matched_atoms": len(coords_a),
            "rmsd": round(rmsd, 3),
            # Column-major (j*3+i), which is what MolViewSpec's `transform`
            # node wants -- the frontend passes it straight through.
            "rotation": [round(v, 8) for v in superpose.rotation_column_major(rotation)],
            "translation": [round(v, 6) for v in translation],
        },
        "pockets": {"common": common, "only_a": only_a, "only_b": only_b},
    }


def _side(meta, result):
    return {
        "id": meta["id"],
        "filename": meta["filename"],
        "structure": result["structure"],
        "fields": result.get("fields", []),
        "pockets": result["pockets"],
    }
