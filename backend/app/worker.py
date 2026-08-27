"""
Tiny in-process job queue.

A single background thread pulls job ids off a `queue.Queue` and runs the
real pocket-detection pipeline (see spocker_bridge.py), updating each job's
meta.json as it goes so the frontend can poll for progress. This is
intentionally not Celery/RQ/etc: there's no broker to install or debug, the
whole thing is ~100 lines you can step through, and it's plenty fast for a
single-node demo server. If this ever needs multi-machine workers, swap
this module out for a real task queue -- the HTTP API and job storage
format don't need to change.

NUM_WORKERS must stay at 1: the underlying pipeline (see
new_spocker/run_pipeline_new_spocker.sh) uses a single shared scratch
directory rather than a per-job one, so two pipeline runs at once would
clobber each other's intermediate files.
"""
import queue
import threading
import traceback

from . import config, jobs_store, spocker_bridge

_queue = queue.Queue()
_started = False
_lock = threading.Lock()


def enqueue(job_id):
    # Best-effort position hint for the UI ("queued, position 3"). Not load
    # bearing for correctness, just nicer UX than a bare "queued". The job's
    # own meta.json is already written with status "queued" by the time this
    # runs, so it's already included in this count -- that count *is* its
    # 1-indexed position in line.
    queued = sum(1 for j in jobs_store.list_jobs() if j["status"] == "queued")
    jobs_store.update_meta(job_id, queue_position=queued)
    _queue.put(job_id)


def _process_job(job_id):
    try:
        meta = jobs_store.read_meta(job_id)
        if meta is None:
            return

        jobs_store.update_meta(
            job_id,
            status="running",
            stage="Cleaning structure (PDBFixer + nucleic-acid filter) and "
                  "running the SPOCKER pocket-detection pipeline",
            progress=10,
            queue_position=None,
            started_at=jobs_store.now_iso(),
        )

        input_path = jobs_store.input_file_path(job_id)
        result = spocker_bridge.run_pocket_detection(job_id, input_path, jobs_store.job_dir(job_id))

        jobs_store.update_meta(job_id, stage="Finalizing results", progress=95)
        jobs_store.write_result(job_id, result)

        jobs_store.update_meta(
            job_id,
            status="done",
            stage="Done",
            progress=100,
            finished_at=jobs_store.now_iso(),
        )
    except Exception as exc:  # noqa: BLE001 - a job failure must not kill the worker
        traceback.print_exc()
        jobs_store.update_meta(
            job_id,
            status="error",
            stage="Failed",
            error=str(exc),
            finished_at=jobs_store.now_iso(),
        )


def _worker_loop():
    while True:
        job_id = _queue.get()
        try:
            _process_job(job_id)
        finally:
            _queue.task_done()


def start_workers():
    """Idempotent: safe to call more than once (e.g. Flask's reloader
    importing the app module twice), only ever spins up NUM_WORKERS threads."""
    global _started
    with _lock:
        if _started:
            return
        for _ in range(config.NUM_WORKERS):
            t = threading.Thread(target=_worker_loop, daemon=True)
            t.start()
        _started = True


def requeue_unfinished_jobs_on_startup():
    """If the server restarted while jobs were queued/running, put them
    back on the queue instead of leaving them stuck forever. Simple crash
    recovery, no external broker required."""
    for meta in jobs_store.list_jobs(limit=1000):
        if meta["status"] in ("queued", "running"):
            jobs_store.update_meta(meta["id"], status="queued", stage="Waiting in queue", progress=0)
            _queue.put(meta["id"])
