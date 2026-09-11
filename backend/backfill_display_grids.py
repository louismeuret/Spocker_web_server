#!/usr/bin/env python3
"""
Add the viewer grids -- the downscaled "<name>.display.mrc" companions and
APBS's two sign halves -- plus the matching apbs_neg/apbs_pos entries in
result.json, to jobs that finished before serve_pockets.py started writing
them.

New jobs get these for free (see serve_pockets.py's _write_display_mrc and
_display_grids). This is only for the ones already sitting in storage/jobs/,
which would otherwise serve full-resolution grids to the viewer and 404 on
apbs_neg/apbs_pos. Also the way to re-do them all at a different resolution:

    SPOCKER_DISPLAY_DOWNSCALE=4 python3 backfill_display_grids.py --force

Run it under the same environment as serve_pockets.py (see
app/spocker_bridge.py for how that env is found).

Usage: python3 backfill_display_grids.py [job_id ...] [--force]
"""
import json
import sys
from pathlib import Path

import serve_pockets as sp

# Same layout as app/config.py's JOBS_DIR, spelled out rather than imported:
# app/__init__.py pulls in Flask, which the pipeline environment this script
# runs under doesn't have.
JOBS_DIR = sp.BACKEND_DIR / "storage" / "jobs"


def backfill_job(job_dir: Path, force: bool) -> int:
    written = 0
    pockets_dir = job_dir / "pockets"
    if not pockets_dir.is_dir():
        return 0

    # Pocket volumes: display copy only, the original is already correct.
    for mrc in sorted(pockets_dir.glob("pocket_*.mrc")):
        if mrc.name.endswith(".display.mrc"):
            continue
        if force or not mrc.with_suffix(".display.mrc").exists():
            mask, voxel, origin = sp._load_mrc_mask(mrc)
            sp._write_display_mrc(mrc, mask, voxel, origin)
            written += 1

    # Per-pocket field grids: display copies, plus the APBS sign split.
    for mrc in sorted(pockets_dir.glob("pocket_*/fields/*.mrc")):
        name = mrc.stem
        if mrc.name.endswith(".display.mrc") or name in ("apbs_neg", "apbs_pos"):
            continue
        data, voxel, origin = sp._load_mrc(mrc)
        for out_name, grid in sp._display_grids(name, data):
            out_path = mrc.with_name(f"{out_name}.mrc")
            if out_name != name and (force or not out_path.exists()):
                sp._write_mrc(out_path, grid, voxel, origin)
                written += 1
            if force or not out_path.with_suffix(".display.mrc").exists():
                sp._write_display_mrc(out_path, grid, voxel, origin)
                written += 1

    written += backfill_result(job_dir, force)
    return written


def backfill_result(job_dir: Path, force: bool) -> int:
    """Adds each pocket's apbs_neg/apbs_pos contribution ratios (and the two
    field names) to result.json, splitting the scored apbs ratio the same way
    serve_pockets.py now does for new jobs."""
    result_path = job_dir / "result.json"
    if not result_path.exists():
        return 0
    result = json.loads(result_path.read_text())

    changed = False
    for pocket in result.get("pockets", []):
        contributions = pocket.get("field_contributions") or {}
        if "apbs" not in contributions:
            continue
        if "apbs_neg" in contributions and not force:
            continue
        apbs = job_dir / "pockets" / pocket["id"] / "fields" / "apbs.mrc"
        if not apbs.exists():
            continue
        data, _voxel, _origin = sp._load_mrc(apbs)
        for sub, share in zip(("apbs_neg", "apbs_pos"), sp._sign_share(data)):
            contributions[sub] = round(contributions["apbs"] * share, 4)
        changed = True

    fields = result.get("fields") or []
    if "apbs" in fields and "apbs_neg" not in fields:
        result["fields"] = fields + ["apbs_neg", "apbs_pos"]
        changed = True

    if not changed:
        return 0
    result_path.write_text(json.dumps(result, indent=2))
    return 1


def main():
    args = [a for a in sys.argv[1:] if a != "--force"]
    force = "--force" in sys.argv[1:]

    jobs_root = JOBS_DIR
    job_dirs = [jobs_root / a for a in args] if args else sorted(d for d in jobs_root.iterdir() if d.is_dir())

    for job_dir in job_dirs:
        if not job_dir.is_dir():
            sys.exit(f"No such job: {job_dir}")
        written = backfill_job(job_dir, force)
        print(f"{job_dir.name}: {written} grid(s) written")


if __name__ == "__main__":
    main()
