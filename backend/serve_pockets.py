#!/usr/bin/env python3
"""
Bridge between Pocket_web_serveur's job worker and the real SPOCKER pipeline
(./new_spocker/run_pipeline_new_spocker.py + Script*.py, both in this same
backend/ folder -- see new_spocker/'s own docstrings for why it's fully
self-contained: no runtime dependency on demo_spocker/ at the repo root, so
this whole backend/ folder can be moved/deployed on its own).

Meant to be invoked as a subprocess, in the Python environment described by
demo_spocker/environment.yml at the repo root (numpy/scipy/mrcfile/
MDAnalysis/volgrids), with `pdbfixer` and `molutils` available on PATH --
see Pocket_web_serveur/backend/app/spocker_bridge.py, which is the only
caller.

Usage:
    python3 serve_pockets.py <raw_input_path> <job_dir> <job_id>

Side effects:
    <job_dir>/processed.pdb  -- the PDBFixer-cleaned, nucleic-acid-only
    structure that was actually analyzed. This is what should be displayed
    in the 3D viewer, since pocket residue references (chain/resi) are
    against this file, not the raw upload -- residue numbering can shift
    once non-nucleic heterogens are stripped and nonstandard residues are
    replaced.

    <job_dir>/pockets/pocket_<n>.mrc -- one MRC volume grid per pocket in
    the returned "pockets" list (1-indexed, same order/ids the web backend
    assigns), so the frontend can render the actual pocket geometry instead
    of just an approximation from lining residues.

    <job_dir>/fields/<name>.mrc -- the raw whole-structure field grids
    Script8 actually scored pockets against (apbs/hydrophobic/hbacceptors/
    hbdonors/stacking, whichever were produced), so the frontend can show
    e.g. "where is the stacking field" on demand.

    <job_dir>/pockets/<pocket_id>/fields/<name>.mrc -- the same field grids,
    resampled onto that pocket's own (smaller) grid and zeroed outside its
    mask, so the frontend can show a field clipped to just one pocket
    instead of the whole structure. APBS additionally gets apbs_neg.mrc /
    apbs_pos.mrc, its two sign halves as all-positive grids (see
    _display_grids).

    <...>.display.mrc -- a downscaled companion next to every pocket/field
    grid above (see DISPLAY_DOWNSCALE). The viewer loads these; downloads
    still get the full-resolution originals.

Prints exactly one JSON object to stdout: {"structure": {...}, "pockets": [...]}.
All pipeline/tooling chatter is captured internally and never reaches real
stdout, which must stay pure JSON for the caller to parse.
"""
import csv
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import mrcfile
import numpy as np
from scipy.spatial import cKDTree

BACKEND_DIR = Path(__file__).resolve().parent
NEW_SPOCKER_DIR = BACKEND_DIR / "new_spocker"
RUN_PIPELINE = NEW_SPOCKER_DIR / "run_pipeline_new_spocker.py"

# Matches RNA_TRIM_CUTOFF_A in new_spocker/Script8: every voxel of a saved
# pocket mask is already guaranteed to be within this distance of some RNA
# heavy atom, so this is the natural cutoff for "which residues line this
# pocket".
RNA_LINING_CUTOFF_A = 5.0

# Matches FIELD_NAMES_CSV in new_spocker/Script8 exactly -- both the field
# grid filenames run_pipeline_new_spocker.py writes into <out_dir>/fields/
# and the "<name>_ratio" column names in <out_dir>/<id>_field_contributions.csv
# are keyed by these.
FIELD_NAMES = ("stacking", "hydrophobic", "hbdonors", "hbacceptors", "apbs")

# Every grid is also written a second time, downscaled, as
# "<name>.display.mrc" next to the original. That downscaled copy is the one
# the viewer loads (see app/jobs_store.py) -- an 0.25A grid is far more
# detail than a browser isosurface needs, and 2x fewer samples per axis is
# 8x less data to parse and re-triangulate on every isovalue change. The
# full-resolution originals are untouched and are what downloads contain.
# Set by app/spocker_bridge.py from the job's own setting; 1 disables it.
DISPLAY_DOWNSCALE = max(1, int(os.environ.get("SPOCKER_DISPLAY_DOWNSCALE") or 2))

# Pocket shape: "fluid" (Script3b, the default) or "sphere" (the original
# Script3/5 volumes). Set by app/spocker_bridge.py from the job's own setting.
POCKET_MODE = os.environ.get("SPOCKER_POCKET_MODE") or "fluid"

# Marks a progress line on stderr. Must stay identical to PROGRESS_PREFIX in
# app/spocker_bridge.py, which is the only reader -- it can't import this
# module, since the two run in different Python environments.
PROGRESS_PREFIX = "@@SPOCKER_PROGRESS "

# What the pipeline's own chatter means, in the user's terms. Each entry is
# (substring to look for in a stdout line, percent, message). The percents
# span the pipeline's slice of the job; app/worker.py owns everything before
# and after. Matched in order, first hit wins, unmatched lines are ignored --
# so a wording change in run_pipeline_new_spocker.py costs a missed update,
# never a wrong one. Stages run in parallel there, so run_pipeline only ever
# moves progress forward.
PIPELINE_STAGES = (
    ("Running Prepare", 20, "Generating interaction fields"),
    ("Running Script1", 58, "Deriving per-field isovalues"),
    ("Running Script6", 60, "Trimming APBS around the RNA"),
    ("Running Script4", 62, "Detecting H-bond hotspots"),
    ("Running Script2", 64, "Detecting binding-site hotspots"),
    ("Running Script7", 66, "Trimming the hydrophobic field"),
    ("Running Script5", 68, "Building H-bond pocket volumes"),
    ("Running Script3b", 76, "Building fluid pocket volumes"),
    ("Running Script3", 70, "Building pocket volumes from hotspots"),
    ("Running Script8", 84, "Merging pockets and scoring them"),
    ("Collecting scored", 88, "Collecting the scored field grids"),
)

# "[fields] SMIF field <key> done" lines from new_spocker/_fields.py; all the
# grids are built in parallel, so each one finished just nudges progress.
FIELD_LABELS = {
    "apbs": "APBS", "hphob": "hydrophobic", "stk": "stacking",
    "hba": "H-bond acceptor", "hbd": "H-bond donor",
}


class PipelineError(RuntimeError):
    pass


def _run(cmd):
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise PipelineError(
            f"Command failed: {' '.join(str(c) for c in cmd)}\n"
            f"--- stdout ---\n{result.stdout}\n--- stderr ---\n{result.stderr}"
        )
    return result


def _progress(percent, message):
    """Report a stage to the web backend, which turns it into the job's
    `stage`/`progress` in meta.json (see app/spocker_bridge.py, which parses
    these back out, and app/worker.py, which writes them).

    On stderr because stdout is reserved for the single result JSON. Anything
    on stderr without this prefix is just diagnostics.
    """
    print(f"{PROGRESS_PREFIX}{percent} {message}", file=sys.stderr, flush=True)


def _run_streaming(cmd, on_line):
    """As _run, but hands each stdout line to `on_line` while the command is
    still running, so a pipeline that takes minutes can say what it's doing
    instead of going silent and reporting everything at the end.

    stderr goes to a temp file rather than a second pipe: draining one pipe
    while the other fills is the classic way to deadlock a subprocess, and
    the failure path wants the whole of it anyway.
    """
    output = []
    with tempfile.TemporaryFile("w+", errors="replace") as err_file:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=err_file, text=True, bufsize=1)
        for line in proc.stdout:
            line = line.rstrip("\n")
            output.append(line)
            on_line(line)
        proc.wait()
        err_file.seek(0)
        stderr = err_file.read()

    if proc.returncode != 0:
        raise PipelineError(
            f"Command failed: {' '.join(str(c) for c in cmd)}\n"
            "--- stdout ---\n" + "\n".join(output) + f"\n--- stderr ---\n{stderr}"
        )


def clean_structure(raw_path: Path, dest_path: Path) -> None:
    """Mirrors 0_prepare_input.sh: PDBFixer, then strip down to nucleic-acid
    residues only. Uploaded structures routinely have the kind of gaps and
    nonstandard/heterogen residues that make PDB2PQR (invoked by `volgrids
    apbs`) give up outright, so this has to happen before any field
    generation."""
    with tempfile.TemporaryDirectory(prefix="spocker_clean_") as tmp:
        fixed_path = Path(tmp) / "fixed.pdb"
        _progress(8, "Repairing the structure (PDBFixer)")
        _run([
            "pdbfixer", str(raw_path),
            "--replace-nonstandard",
            "--keep-heterogens", "none",
            "--output", str(fixed_path),
        ])
        # pdbfixer keeps amino-acid ligands (and turns their HETATM records
        # into ATOM), so a nucleic-only filter is still needed afterwards.
        _progress(14, "Selecting nucleic-acid residues")
        _run(["molutils", "select", "nucleic", str(fixed_path), str(dest_path)])


def run_pipeline(processed_pdb: Path, out_dir: Path) -> None:
    last = 0

    def report(percent, message):
        nonlocal last
        if percent > last:
            last = percent
            _progress(percent, message)

    def relay(line):
        if "APBS electrostatics done" in line:
            report(min(last + 4, 52), "Solved electrostatics (APBS)")
            return
        if "SMIF field " in line and line.endswith(" done"):
            key = line.split("SMIF field ", 1)[1].split()[0]
            subset = " for non-paired residues" if "H-bond subset" in line else ""
            report(min(last + 4, 52), f"Built the {FIELD_LABELS.get(key, key)} grid{subset}")
            return
        for marker, percent, message in PIPELINE_STAGES:
            if marker in line:
                report(percent, message)
                return

    _run_streaming([sys.executable, str(RUN_PIPELINE), str(processed_pdb), str(out_dir),
                    "--pocket-mode", POCKET_MODE], relay)


def _load_mrc(path: Path):
    """Reads an MRC/CCP4 grid as (data, voxel_size, origin), with the same
    axis handling as new_spocker/Script8's _load_mrc_data -- every grid read
    here was written by that script's write_mrc (mapc=1, mapr=2, maps=3), so
    this always round-trips correctly."""
    with mrcfile.open(path, mode="r", permissive=True) as mrc:
        data_raw = np.asarray(mrc.data, dtype=np.float32)
        voxel = np.array([float(mrc.voxel_size.x) or 1.0,
                          float(mrc.voxel_size.y) or 1.0,
                          float(mrc.voxel_size.z) or 1.0], dtype=float)
        origin = np.array([float(mrc.header.origin.x),
                           float(mrc.header.origin.y),
                           float(mrc.header.origin.z)], dtype=float)
        axis_of_cart = {int(mrc.header.maps): 0, int(mrc.header.mapr): 1, int(mrc.header.mapc): 2}
        try:
            perm = (axis_of_cart[1], axis_of_cart[2], axis_of_cart[3])
        except KeyError:
            perm = (2, 1, 0)
        data = np.transpose(data_raw, perm)
    return data, voxel, origin


def _load_mrc_mask(path: Path):
    """As _load_mrc, but thresholded into a boolean pocket mask."""
    data, voxel, origin = _load_mrc(path)
    return data > 0.5, voxel, origin


def _write_mrc(path: Path, data, voxel, origin) -> None:
    """Mirrors new_spocker/Script8's write_mrc exactly (mapc=1, mapr=2,
    maps=3 + the matching (2, 1, 0) transpose), so anything written here
    round-trips through _load_mrc/_load_mrc_mask and Mol*'s CCP4
    parser the same way pocket_<n>.mrc already does."""
    data_out = np.transpose(np.asarray(data, dtype=np.float32), (2, 1, 0))
    with mrcfile.new(str(path), overwrite=True) as mrc:
        mrc.set_data(data_out)
        mrc.voxel_size = (float(voxel[0]), float(voxel[1]), float(voxel[2]))
        mrc.header.mapc = 1
        mrc.header.mapr = 2
        mrc.header.maps = 3
        try:
            mrc.header.origin.x = float(origin[0])
            mrc.header.origin.y = float(origin[1])
            mrc.header.origin.z = float(origin[2])
        except Exception:
            pass
        mrc.update_header_from_data()
        mrc.update_header_stats()


def _downscale(data, factor):
    """Block-max downsample by `factor` along each axis. Max, not mean, so a
    voxel above an isovalue stays above it -- the same slider positions mean
    the same thing on the display grid as on the original. The last <factor
    voxels of each axis are dropped (at 0.25A each, invisible), which keeps
    the origin unchanged."""
    data = np.asarray(data, dtype=np.float32)
    shape = [s // factor for s in data.shape]
    if min(shape) == 0:
        return data
    cropped = data[:shape[0] * factor, :shape[1] * factor, :shape[2] * factor]
    return cropped.reshape(shape[0], factor, shape[1], factor, shape[2], factor).max(axis=(1, 3, 5))


def _write_display_mrc(original_path: Path, data, voxel, origin) -> None:
    """Writes the downscaled companion grid for `original_path` (see
    DISPLAY_DOWNSCALE). No-op when downscaling is off."""
    if DISPLAY_DOWNSCALE <= 1:
        return
    _write_mrc(
        original_path.with_suffix(".display.mrc"),
        _downscale(data, DISPLAY_DOWNSCALE),
        np.asarray(voxel, dtype=float) * DISPLAY_DOWNSCALE,
        origin,
    )


def field_within_pocket(pocket_mask, pocket_voxel, pocket_origin, field_data, field_voxel, field_origin):
    """Resample a raw field grid onto a pocket's own (usually much smaller)
    grid, keeping the field's value only where the pocket mask is set and
    zero everywhere else -- "where is this field, but only inside this
    pocket" rather than across the whole structure.

    The pocket grid and field grid come from separate volgrids/Script8
    runs and can have different shapes/origins (same situation
    new_spocker/Script8's align_masks_to_common_grid handles for
    mask-vs-mask comparisons), so this maps each pocket voxel to world
    coordinates and looks up the nearest field voxel there, rather than
    assuming the two grids line up index-for-index.
    """
    out = np.zeros_like(pocket_mask, dtype=np.float32)
    coords = np.column_stack(np.where(pocket_mask))
    if len(coords) == 0:
        return out

    world = coords * pocket_voxel[None, :] + pocket_origin[None, :]
    field_idx = np.rint((world - field_origin[None, :]) / field_voxel[None, :]).astype(int)
    field_shape = np.array(field_data.shape)
    valid = np.all((field_idx >= 0) & (field_idx < field_shape[None, :]), axis=1)

    vi = field_idx[valid]
    vc = coords[valid]
    out[vc[:, 0], vc[:, 1], vc[:, 2]] = field_data[vi[:, 0], vi[:, 1], vi[:, 2]]
    return out


def _display_grids(name, data):
    """Yields (filename_stem, grid) for one field: the field itself, plus --
    for APBS only -- its two sign halves as separate all-positive grids.

    APBS around RNA is negative almost everywhere (the backbone is
    polyanionic), so an isosurface at any positive threshold shows nothing at
    all. Splitting it gives the viewer two grids it can threshold normally:
    apbs_neg holds |V| where V < 0, apbs_pos holds V where V > 0. Scoring is
    unaffected -- it reads the original apbs grid, which is still written.
    """
    yield name, data
    if name == "apbs":
        yield "apbs_neg", np.maximum(-data, 0.0)
        yield "apbs_pos", np.maximum(data, 0.0)


def _sign_share(data):
    """How a grid's total magnitude divides between its negative and positive
    parts, as (negative_share, positive_share) summing to 1 (or to 0 for an
    empty grid). Used to split APBS's single scored contribution -- Script8
    integrates |apbs|, so the ratio it reports lumps both signs together --
    into the two halves the chart draws separately."""
    neg = float(np.abs(np.minimum(data, 0.0)).sum())
    pos = float(np.maximum(data, 0.0).sum())
    total = neg + pos
    if total <= 0.0:
        return 0.0, 0.0
    return neg / total, pos / total


def parse_rna_atoms(pdb_path: Path) -> list:
    atoms = []
    with open(pdb_path, errors="ignore") as f:
        for line in f:
            record = line[:6].strip()
            if record not in ("ATOM", "HETATM"):
                continue
            try:
                atoms.append({
                    "chain": line[21:22].strip() or "A",
                    "resi": int(line[22:26]),
                    "resn": line[17:20].strip(),
                    "xyz": (float(line[30:38]), float(line[38:46]), float(line[46:54])),
                })
            except (ValueError, IndexError):
                continue
    return atoms


def residues_lining_pocket(mask, voxel, origin, atoms, cutoff_a=RNA_LINING_CUTOFF_A) -> list:
    if not atoms:
        return []
    coords = np.column_stack(np.where(mask))
    if len(coords) == 0:
        return []
    world = coords * voxel[None, :] + origin[None, :]
    atom_xyz = np.array([a["xyz"] for a in atoms])
    tree = cKDTree(atom_xyz)
    hit_lists = tree.query_ball_point(world, r=cutoff_a, workers=-1)
    hit_idx = {i for sub in hit_lists for i in sub}
    seen = {}
    for i in hit_idx:
        a = atoms[i]
        key = (a["chain"], a["resi"])
        seen.setdefault(key, {"chain": a["chain"], "resi": a["resi"], "resn": a["resn"]})
    return sorted(seen.values(), key=lambda r: (r["chain"], r["resi"]))


def pocket_center_a(mask, voxel, origin) -> list:
    coords = np.column_stack(np.where(mask))
    world = coords * voxel[None, :] + origin[None, :]
    c = world.mean(axis=0)
    return [round(float(c[0]), 2), round(float(c[1]), 2), round(float(c[2]), 2)]


def pocket_surface_area_a2(mask, voxel) -> float:
    """Exposed-face count over the voxel grid -- a standard real-geometry
    proxy for SASA that doesn't require a marching-cubes/mesh dependency."""
    face_area = [voxel[1] * voxel[2], voxel[0] * voxel[2], voxel[0] * voxel[1]]
    total = 0.0
    for axis in range(3):
        src = [slice(None)] * 3
        dst = [slice(None)] * 3
        src[axis] = slice(0, -1)
        dst[axis] = slice(1, None)
        exposed = np.count_nonzero(mask[tuple(src)] & ~mask[tuple(dst)])
        exposed += np.count_nonzero(mask[tuple(dst)] & ~mask[tuple(src)])
        first = [slice(None)] * 3
        last = [slice(None)] * 3
        first[axis] = 0
        last[axis] = -1
        exposed += np.count_nonzero(mask[tuple(first)])
        exposed += np.count_nonzero(mask[tuple(last)])
        total += exposed * face_area[axis]
    return round(float(total), 1)


def build_result(raw_input_path: str, job_dir: str, job_id: str) -> dict:
    job_dir = Path(job_dir)
    processed_pdb = job_dir / "processed.pdb"
    clean_structure(Path(raw_input_path), processed_pdb)

    # run_pipeline_new_spocker.py derives its internal PDB_ID from the input
    # filename's stem -- job_id is a uuid4 hex, so it's already dot-free and
    # doubles as a safe, unique PDB_ID.
    pipeline_input = job_dir / f"{job_id}.pdb"
    shutil.copy(processed_pdb, pipeline_input)

    pockets_dir = job_dir / "pockets"
    shutil.rmtree(pockets_dir, ignore_errors=True)
    pockets_dir.mkdir()

    fields_dir = job_dir / "fields"
    shutil.rmtree(fields_dir, ignore_errors=True)
    fields_dir.mkdir()

    out_dir = Path(tempfile.mkdtemp(prefix="spocker_out_"))
    try:
        run_pipeline(pipeline_input, out_dir)

        _progress(90, "Reading the analyzed structure")
        atoms = parse_rna_atoms(processed_pdb)
        chains = sorted({a["chain"] for a in atoms})
        residues_seen = {(a["chain"], a["resi"]) for a in atoms}

        available_fields = []
        field_data = {}  # name -> (data, voxel, origin), for masking into each pocket below
        for name in FIELD_NAMES:
            src = out_dir / "fields" / f"{name}.mrc"
            if src.exists():
                dest = fields_dir / f"{name}.mrc"
                shutil.copy(src, dest)
                available_fields.append(name)
                field_data[name] = _load_mrc(dest)
                if name == "apbs":
                    # Derived per pocket rather than generated by the
                    # pipeline, but the frontend treats them like any other
                    # field (see _display_grids / _sign_share).
                    available_fields.extend(("apbs_neg", "apbs_pos"))

        csv_path = out_dir / f"{job_id}_field_contributions.csv"
        rows = []
        if csv_path.exists():
            with open(csv_path, newline="") as f:
                rows = list(csv.DictReader(f))

        _progress(92, f"Building viewer grids for {len(rows)} pocket(s)")
        pockets = []
        for row in rows:
            mrc_path = out_dir / f"{job_id}.{row['pocket_name']}_Volume.mrc"
            if not mrc_path.exists():
                continue
            mask, voxel, origin = _load_mrc_mask(mrc_path)
            # 1-indexed, in the same order the "pockets" list is returned --
            # Pocket_web_serveur's spocker_bridge.py assigns "pocket_<n>" ids
            # by enumerating this same list, so the ids always line up.
            pocket_id = f"pocket_{len(pockets) + 1}"
            _progress(92, f"Masking fields into pocket {len(pockets) + 1}/{len(rows)}")
            pocket_mrc = pockets_dir / f"{pocket_id}.mrc"
            shutil.copy(mrc_path, pocket_mrc)
            _write_display_mrc(pocket_mrc, mask, voxel, origin)

            pocket_fields_dir = pockets_dir / pocket_id / "fields"
            pocket_fields_dir.mkdir(parents=True)
            apbs_share = None
            for name, (f_data, f_voxel, f_origin) in field_data.items():
                masked = field_within_pocket(mask, voxel, origin, f_data, f_voxel, f_origin)
                if name == "apbs":
                    apbs_share = _sign_share(masked)
                for out_name, grid in _display_grids(name, masked):
                    out_path = pocket_fields_dir / f"{out_name}.mrc"
                    _write_mrc(out_path, grid, voxel, origin)
                    _write_display_mrc(out_path, grid, voxel, origin)

            field_contributions = {
                name: round(float(row[f"{name}_ratio"]), 4)
                for name in FIELD_NAMES if f"{name}_ratio" in row
            }
            # The two APBS halves get the scored apbs ratio divided in the
            # same proportion as this pocket's own positive/negative APBS
            # magnitude, so apbs_neg + apbs_pos == apbs and the chart can
            # show which side the electrostatics actually came from.
            if apbs_share and "apbs" in field_contributions:
                for sub, share in zip(("apbs_neg", "apbs_pos"), apbs_share):
                    field_contributions[sub] = round(field_contributions["apbs"] * share, 4)
            pockets.append({
                "score": round(float(row["pocket_score"]), 4),
                "volume": round(float(row["pocket_volume_A3"]), 1),
                "surface_area": pocket_surface_area_a2(mask, voxel),
                "center": pocket_center_a(mask, voxel, origin),
                "residues": residues_lining_pocket(mask, voxel, origin, atoms),
                "contributing_fields": row["contributing_fields"],
                "field_contributions": field_contributions,
            })
    finally:
        shutil.rmtree(out_dir, ignore_errors=True)
        pipeline_input.unlink(missing_ok=True)

    return {
        "structure": {
            "chains": chains,
            "num_atoms": len(atoms),
            "num_residues": len(residues_seen),
        },
        "fields": available_fields,
        "pockets": pockets,
    }


def main():
    if len(sys.argv) != 4:
        sys.exit(f"Usage: {sys.argv[0]} <raw_input_path> <job_dir> <job_id>")
    raw_input_path, job_dir, job_id = sys.argv[1:4]
    result = build_result(raw_input_path, job_dir, job_id)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
