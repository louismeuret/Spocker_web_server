"""
Curated example jobs, shown on the input page under the browser's own recent
history so a first-time visitor has something to open without waiting for a
pipeline run.

Curation is deliberately a server-side file rather than a hardcoded list in
the frontend: examples point at real job UUIDs in this server's storage, so
they are specific to a deployment. Copy storage/examples.json, drop in the
UUIDs of jobs worth showing off, done.

    {
      "calculations": [
        {"job_id": "<uuid>", "title": "1AJU", "description": "..."}
      ],
      "comparisons": [
        {"job_a": "<uuid>", "job_b": "<uuid>", "title": "...", "description": "..."}
      ]
    }

Entries pointing at jobs that don't exist (or haven't finished) are silently
dropped rather than erroring: storage/jobs/ is gitignored, so a fresh clone
legitimately has none of them and should just show an empty examples pane.
"""
import json
import os

from . import config, jobs_store

EXAMPLES_PATH = os.path.join(config.STORAGE_DIR, "examples.json")


def _read_file():
    try:
        with open(EXAMPLES_PATH) as f:
            data = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _finished_job(job_id):
    if not isinstance(job_id, str) or not jobs_store.exists(job_id):
        return None
    meta = jobs_store.read_meta(job_id)
    if meta is None or meta["status"] != "done":
        return None
    return meta


def _pocket_count(job_id):
    result = jobs_store.read_result(job_id)
    return len(result["pockets"]) if result else 0


def list_examples():
    data = _read_file()

    calculations = []
    for entry in data.get("calculations", []) or []:
        job_id = entry.get("job_id")
        meta = _finished_job(job_id)
        if meta is None:
            continue
        calculations.append(
            {
                "job_id": job_id,
                # Falls back to the filename so an entry only needs a UUID to
                # be useful -- the title is a nicety, not a requirement.
                "title": entry.get("title") or meta["filename"] or job_id[:8],
                "description": entry.get("description") or "",
                "filename": meta["filename"],
                "num_pockets": _pocket_count(job_id),
            }
        )

    comparisons = []
    for entry in data.get("comparisons", []) or []:
        job_a, job_b = entry.get("job_a"), entry.get("job_b")
        meta_a, meta_b = _finished_job(job_a), _finished_job(job_b)
        if meta_a is None or meta_b is None or job_a == job_b:
            continue
        comparisons.append(
            {
                "job_a": job_a,
                "job_b": job_b,
                "title": entry.get("title")
                or f"{meta_a['filename'] or job_a[:8]} vs {meta_b['filename'] or job_b[:8]}",
                "description": entry.get("description") or "",
            }
        )

    return {"calculations": calculations, "comparisons": comparisons}
