"""
Tiny in-process job queue.

A single background thread pulls job ids off a `queue.Queue` and runs the
pocket-detection pipeline (see spocker_bridge.py), updating each job's
meta.json as it goes so the frontend can poll for progress
"""
import queue
import threading
import traceback

from . import config, jobs_store, spocker_bridge

_queue = queue.Queue()
_started = False
_lock = threading.Lock()


def enqueue(job_id):
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
            stage="Starting the SPOCKER pipeline",
            progress=5,
            queue_position=None,
            started_at=jobs_store.now_iso(),
        )

        def report(percent, message):
            jobs_store.update_meta(job_id, stage=message, progress=percent)

        input_path = jobs_store.input_file_path(job_id)
        result = spocker_bridge.run_pocket_detection(
            job_id,
            input_path,
            jobs_store.job_dir(job_id),
            display_downscale=meta.get("display_downscale"),
            on_progress=report,
        )

        jobs_store.update_meta(job_id, stage="Saving results", progress=95)
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
    global _started
    with _lock:
        if _started:
            return
        for _ in range(config.NUM_WORKERS):
            t = threading.Thread(target=_worker_loop, daemon=True)
            t.start()
        _started = True


def requeue_unfinished_jobs_on_startup():
    for meta in jobs_store.list_jobs(limit=1000):
        if meta["status"] in ("queued", "running"):
            jobs_store.update_meta(meta["id"], status="queued", stage="Waiting in queue", progress=0)
            _queue.put(meta["id"])
