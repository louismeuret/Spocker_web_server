"""
Very small file-based "database" for jobs.

Each job lives in its own folder under storage/jobs/<job_id>/:
  - meta.json     status/progress/timestamps (small, updated often)
  - input.<ext>   the uploaded structure file, kept as-is
  - result.json   pocket-detection output, written once done
  - processed.pdb the cleaned structure that was actually analyzed

No SQL, no ORM, nothing that needs a running service: you can `cat` any of
these files while debugging. Writes are atomic (write to a temp file then
rename) so a reader never sees a half-written meta.json.
"""
import json
import os
import re
import tempfile
import uuid
from datetime import datetime, timezone

from . import config

_POCKET_ID_RE = re.compile(r"^pocket_\d+$")

# Matches FIELD_NAMES in backend/serve_pockets.py -- the fixed set of raw
# field grids it may persist under <job_dir>/fields/.
_FIELD_NAMES = {"stacking", "hydrophobic", "hbdonors", "hbacceptors", "apbs"}


def new_job_id():
    return uuid.uuid4().hex


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def _valid_pocket(pocket_id):
    # pocket_id comes straight off the URL, so the *_path helpers validate
    # it rather than building a path out of whatever arrived.
    return bool(pocket_id) and bool(_POCKET_ID_RE.match(pocket_id))


def job_dir(job_id):
    return os.path.join(config.JOBS_DIR, job_id)


def _meta_path(job_id):
    return os.path.join(job_dir(job_id), "meta.json")


def _result_path(job_id):
    return os.path.join(job_dir(job_id), "result.json")


def exists(job_id):
    # job_id comes from the URL, keep this cheap and safe against path tricks
    if not job_id or "/" in job_id or ".." in job_id:
        return False
    return os.path.isdir(job_dir(job_id))


def _atomic_write_json(path, data):
    folder = os.path.dirname(path)
    fd, tmp_path = tempfile.mkstemp(dir=folder, prefix=".tmp-", suffix=".json")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp_path, path)
    except Exception:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        raise


def create_job(job_id, original_filename, input_ext):
    os.makedirs(job_dir(job_id), exist_ok=True)
    now = now_iso()
    meta = {
        "id": job_id,
        "filename": original_filename,
        "input_ext": input_ext,
        "status": "queued",  # queued -> running -> done | error
        "stage": "Waiting in queue",
        "progress": 0,
        "queue_position": None,
        "created_at": now,
        "updated_at": now,
        "started_at": None,
        "finished_at": None,
        "error": None,
    }
    _atomic_write_json(_meta_path(job_id), meta)
    return meta


def read_meta(job_id):
    try:
        with open(_meta_path(job_id)) as f:
            return json.load(f)
    except FileNotFoundError:
        return None


def update_meta(job_id, **fields):
    meta = read_meta(job_id)
    if meta is None:
        return None
    meta.update(fields)
    meta["updated_at"] = now_iso()
    _atomic_write_json(_meta_path(job_id), meta)
    return meta


def write_result(job_id, result):
    _atomic_write_json(_result_path(job_id), result)


def read_result(job_id):
    try:
        with open(_result_path(job_id)) as f:
            return json.load(f)
    except FileNotFoundError:
        return None


def input_file_path(job_id):
    meta = read_meta(job_id)
    if meta is None:
        return None
    return os.path.join(job_dir(job_id), f"input{meta['input_ext']}")


def processed_file_path(job_id):
    """The PDBFixer-cleaned, nucleic-acid-only structure that was actually
    analyzed (written by backend/serve_pockets.py). This is what the
    3D viewer should display, since pocket residue references are against
    this file, not the raw upload -- residue numbering can shift once
    non-nucleic heterogens are stripped."""
    return os.path.join(job_dir(job_id), "processed.pdb")


def pockets_dir(job_id):
    return os.path.join(job_dir(job_id), "pockets")


def fields_dir(job_id):
    return os.path.join(job_dir(job_id), "fields")


def pocket_volume_path(job_id, pocket_id):
    """Path to a single pocket's MRC volume grid (see
    backend/serve_pockets.py, which writes these)."""
    if not _valid_pocket(pocket_id):
        return None
    return os.path.join(pockets_dir(job_id), f"{pocket_id}.mrc")


def field_volume_path(job_id, field_name):
    """Path to a raw whole-structure field's MRC grid (see
    backend/serve_pockets.py, which writes these)."""
    if field_name not in _FIELD_NAMES:
        return None
    return os.path.join(fields_dir(job_id), f"{field_name}.mrc")


def pocket_field_volume_path(job_id, pocket_id, field_name):
    """Path to a single field's MRC grid, resampled and masked down to just
    one pocket's own region (see backend/serve_pockets.py's
    field_within_pocket, which writes these)."""
    if not _valid_pocket(pocket_id) or field_name not in _FIELD_NAMES:
        return None
    return os.path.join(pockets_dir(job_id), pocket_id, "fields", f"{field_name}.mrc")


def list_jobs(limit=100):
    """Newest first. Reads meta.json for every job dir -- fine for a demo /
    single-node deployment; swap for a real index if this ever needs to
    scale to thousands of jobs."""
    if not os.path.isdir(config.JOBS_DIR):
        return []
    ids = [i for i in os.listdir(config.JOBS_DIR) if os.path.isdir(os.path.join(config.JOBS_DIR, i))]
    metas = [m for m in (read_meta(i) for i in ids) if m is not None]
    metas.sort(key=lambda m: m["created_at"], reverse=True)
    return metas[:limit]
