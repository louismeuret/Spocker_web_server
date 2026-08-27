#!/usr/bin/env python3
"""
Bridge between Pocket_web_serveur's job worker and the real SPOCKER pipeline
(./new_spocker/run_pipeline_new_spocker.sh + Script*.py, both in this same
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
    instead of the whole structure.

Prints exactly one JSON object to stdout: {"structure": {...}, "pockets": [...]}.
All pipeline/tooling chatter is captured internally and never reaches real
stdout, which must stay pure JSON for the caller to parse.
"""
import csv
import json
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
RUN_PIPELINE_SH = NEW_SPOCKER_DIR / "run_pipeline_new_spocker.sh"

# Matches RNA_TRIM_CUTOFF_A in new_spocker/Script8: every voxel of a saved
# pocket mask is already guaranteed to be within this distance of some RNA
# heavy atom, so this is the natural cutoff for "which residues line this
# pocket".
RNA_LINING_CUTOFF_A = 5.0

# Matches FIELD_NAMES_CSV in new_spocker/Script8 exactly -- both the field
# grid filenames run_pipeline_new_spocker.sh writes into <out_dir>/fields/
# and the "<name>_ratio" column names in <out_dir>/<id>_field_contributions.csv
# are keyed by these.
FIELD_NAMES = ("stacking", "hydrophobic", "hbdonors", "hbacceptors", "apbs")


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


def clean_structure(raw_path: Path, dest_path: Path) -> None:
    """Mirrors 0_prepare_input.sh: PDBFixer, then strip down to nucleic-acid
    residues only. Uploaded structures routinely have the kind of gaps and
    nonstandard/heterogen residues that make PDB2PQR (invoked by `volgrids
    apbs`) give up outright, so this has to happen before any field
    generation."""
    with tempfile.TemporaryDirectory(prefix="spocker_clean_") as tmp:
        fixed_path = Path(tmp) / "fixed.pdb"
        _run([
            "pdbfixer", str(raw_path),
            "--replace-nonstandard",
            "--keep-heterogens", "none",
            "--output", str(fixed_path),
        ])
        # pdbfixer keeps amino-acid ligands (and turns their HETATM records
        # into ATOM), so a nucleic-only filter is still needed afterwards.
        _run(["molutils", "select", "nucleic", str(fixed_path), str(dest_path)])


def run_pipeline(processed_pdb: Path, out_dir: Path) -> None:
    _run(["bash", str(RUN_PIPELINE_SH), str(processed_pdb), str(out_dir)])


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

    # run_pipeline_new_spocker.sh derives its internal PDB_ID from the input
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

        csv_path = out_dir / f"{job_id}_field_contributions.csv"
        rows = []
        if csv_path.exists():
            with open(csv_path, newline="") as f:
                rows = list(csv.DictReader(f))

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
            shutil.copy(mrc_path, pockets_dir / f"{pocket_id}.mrc")

            pocket_fields_dir = pockets_dir / pocket_id / "fields"
            pocket_fields_dir.mkdir(parents=True)
            for name, (f_data, f_voxel, f_origin) in field_data.items():
                masked = field_within_pocket(mask, voxel, origin, f_data, f_voxel, f_origin)
                _write_mrc(pocket_fields_dir / f"{name}.mrc", masked, voxel, origin)

            field_contributions = {
                name: round(float(row[f"{name}_ratio"]), 4)
                for name in FIELD_NAMES if f"{name}_ratio" in row
            }
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
