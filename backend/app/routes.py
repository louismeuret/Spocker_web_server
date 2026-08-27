import io
import json
import os
import zipfile

from flask import Blueprint, jsonify, request, send_file
from werkzeug.utils import secure_filename

from . import compare, config, examples, jobs_store, pdb_fetch, structure_models, worker

api = Blueprint("api", __name__, url_prefix="/api")


@api.get("/health")
def health():
    return jsonify({"status": "ok"})


def _resolve_model_selection(raw_bytes, requested_model):
    """Checks a raw structure for multiple MODEL blocks (NMR ensembles etc).

    Returns (final_bytes, None) when there's nothing to ask about (a plain
    single-model structure, or the caller already picked a model), or
    (None, models) when the frontend needs to ask the user which model to
    analyze before a job gets created at all.

    Raises ValueError if `requested_model` doesn't match any model actually
    present in the structure.
    """
    models = structure_models.detect_models(raw_bytes)
    if len(models) <= 1:
        return raw_bytes, None
    if requested_model is None:
        return None, models
    if requested_model not in models:
        raise ValueError(f"Model {requested_model} not found (available: {models})")
    return structure_models.extract_model(raw_bytes, requested_model), None


def _create_job(original_filename, ext, raw_bytes, requested_model):
    """Resolves the model choice first, so a structure that still needs one
    never leaves a job dir behind, then queues the job."""
    try:
        final_bytes, models = _resolve_model_selection(raw_bytes, requested_model)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    if models is not None:
        return jsonify({"needs_model_selection": True, "models": models}), 200

    job_id = jobs_store.new_job_id()
    jobs_store.create_job(job_id, original_filename=original_filename, input_ext=ext)
    with open(jobs_store.input_file_path(job_id), "wb") as f:
        f.write(final_bytes)
    worker.enqueue(job_id)

    return jsonify(jobs_store.read_meta(job_id)), 201


def _create_job_from_pdb_code(pdb_code, requested_model):
    """Downloads the structure from RCSB before creating any job record, so
    an invalid code or an RCSB miss never leaves behind a broken job dir --
    same immediate-feedback behaviour as the "no file selected" case below."""
    try:
        code = pdb_fetch.validate_pdb_code(pdb_code)
    except pdb_fetch.PdbFetchError as exc:
        return jsonify({"error": str(exc)}), 400

    try:
        pdb_bytes = pdb_fetch.fetch_pdb(code)
    except pdb_fetch.PdbFetchError as exc:
        return jsonify({"error": str(exc)}), 502

    return _create_job(f"{code}.pdb", ".pdb", pdb_bytes, requested_model)


@api.post("/jobs")
def create_job():
    model_param = request.form.get("model")
    try:
        requested_model = int(model_param) if model_param not in (None, "") else None
    except ValueError:
        return jsonify({"error": f"Invalid model '{model_param}'"}), 400

    pdb_code = (request.form.get("pdb_code") or "").strip()
    if pdb_code:
        return _create_job_from_pdb_code(pdb_code, requested_model)

    file = request.files.get("file")
    if file is None or file.filename == "":
        return jsonify({"error": "No file part in request (expected field 'file' or 'pdb_code')"}), 400

    original_name = secure_filename(file.filename)
    ext = os.path.splitext(original_name)[1].lower()
    if ext not in config.ALLOWED_EXTENSIONS:
        return (
            jsonify(
                {
                    "error": f"Unsupported file type '{ext}'. Allowed: "
                    + ", ".join(sorted(config.ALLOWED_EXTENSIONS))
                }
            ),
            400,
        )

    return _create_job(original_name, ext, file.read(), requested_model)


@api.get("/jobs")
def list_jobs():
    limit = request.args.get("limit", default=50, type=int)
    return jsonify(jobs_store.list_jobs(limit=limit))


@api.get("/jobs/<job_id>")
def get_job(job_id):
    if not jobs_store.exists(job_id):
        return jsonify({"error": "Job not found"}), 404
    return jsonify(jobs_store.read_meta(job_id))


@api.get("/jobs/<job_id>/result")
def get_job_result(job_id):
    if not jobs_store.exists(job_id):
        return jsonify({"error": "Job not found"}), 404
    meta = jobs_store.read_meta(job_id)
    if meta["status"] != "done":
        return jsonify({"error": f"Job is not finished yet (status: {meta['status']})"}), 409
    result = jobs_store.read_result(job_id)
    if result is None:
        return jsonify({"error": "Result missing despite job marked done"}), 500
    return jsonify(result)


@api.get("/jobs/<job_id>/structure")
def get_job_structure(job_id):
    if not jobs_store.exists(job_id):
        return jsonify({"error": "Job not found"}), 404
    meta = jobs_store.read_meta(job_id)

    # Prefer the cleaned structure that was actually analyzed -- pocket
    # residue references (chain/resi) are against this file. Fall back to
    # the raw upload if processing hasn't produced it yet (e.g. job still
    # queued/running/errored).
    processed_path = jobs_store.processed_file_path(job_id)
    if os.path.isfile(processed_path):
        return send_file(
            processed_path,
            mimetype="chemical/x-pdb",
            as_attachment=False,
            download_name=f"{job_id}.pdb",
        )

    path = jobs_store.input_file_path(job_id)
    if not os.path.isfile(path):
        return jsonify({"error": "Structure file missing"}), 404
    return send_file(
        path,
        mimetype="chemical/x-pdb",
        as_attachment=False,
        download_name=meta["filename"] or f"{job_id}{meta['input_ext']}",
    )


def _send_volume(job_id, path, download_name, missing):
    """Serves an MRC volume grid (see backend/serve_pockets.py) -- Mol* loads
    these directly as CCP4/MRC volumetric data and renders them as
    isosurfaces. `path` is None when the pocket/field name off the URL didn't
    match its expected format, which is a 404 the same as a missing file."""
    if not jobs_store.exists(job_id):
        return jsonify({"error": "Job not found"}), 404
    if not path or not os.path.isfile(path):
        return jsonify({"error": missing}), 404
    return send_file(
        path,
        mimetype="application/octet-stream",
        as_attachment=False,
        download_name=download_name,
    )


@api.get("/jobs/<job_id>/pockets/<pocket_id>/volume")
def get_pocket_volume(job_id, pocket_id):
    """One pocket's real shape, as the pipeline computed it -- rather than an
    approximation built from its lining residues."""
    return _send_volume(
        job_id,
        jobs_store.pocket_volume_path(job_id, pocket_id),
        f"{job_id}_{pocket_id}.mrc",
        "Pocket volume not found",
    )


@api.get("/jobs/<job_id>/fields/<field_name>/volume")
def get_field_volume(job_id, field_name):
    """A raw whole-structure field (apbs/stacking/hydrophobic/hbacceptors/
    hbdonors): "where is this field", independent of any single pocket."""
    return _send_volume(
        job_id,
        jobs_store.field_volume_path(job_id, field_name),
        f"{job_id}_{field_name}.mrc",
        "Field volume not found",
    )


@api.get("/jobs/<job_id>/pockets/<pocket_id>/fields/<field_name>/volume")
def get_pocket_field_volume(job_id, pocket_id, field_name):
    """The same field, resampled and masked down to one pocket's own region
    (see serve_pockets.py's field_within_pocket) -- "where is the stacking
    field, but only inside this pocket"."""
    return _send_volume(
        job_id,
        jobs_store.pocket_field_volume_path(job_id, pocket_id, field_name),
        f"{job_id}_{pocket_id}_{field_name}.mrc",
        "Pocket field volume not found",
    )


@api.get("/compare/<job_a>/<job_b>")
def compare_jobs(job_a, job_b):
    """Superposes two finished jobs and pairs up their detected pockets (see
    app/compare.py).

    The response carries the rigid transform taking B onto A, so the viewer
    can show the two superposed without anything being resampled server-side
    -- MolViewSpec applies it to B's structure and to each of B's pocket
    volume grids directly (frontend/src/molstar/buildCompareScene.js)."""
    try:
        return jsonify(compare.compare_jobs(job_a, job_b))
    except compare.CompareError as exc:
        return jsonify({"error": str(exc)}), exc.status


@api.get("/examples")
def list_examples():
    """Curated example jobs for the input page, from storage/examples.json."""
    return jsonify(examples.list_examples())


@api.get("/jobs/<job_id>/download")
def download_job(job_id):
    """Bundles this job's structure, pocket-detection result, pocket volume
    grids, and raw field grids into a single zip for the user to take
    away."""
    if not jobs_store.exists(job_id):
        return jsonify({"error": "Job not found"}), 404
    meta = jobs_store.read_meta(job_id)
    if meta["status"] != "done":
        return jsonify({"error": f"Job is not finished yet (status: {meta['status']})"}), 409

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        processed_path = jobs_store.processed_file_path(job_id)
        if os.path.isfile(processed_path):
            zf.write(processed_path, arcname="structure.pdb")

        result = jobs_store.read_result(job_id)
        if result is not None:
            zf.writestr("result.json", json.dumps(result, indent=2))

        pockets_dir = jobs_store.pockets_dir(job_id)
        if os.path.isdir(pockets_dir):
            # Walked, not a flat listdir: each pocket_<n>/ subfolder also
            # holds a fields/ directory (see field_within_pocket in
            # backend/serve_pockets.py), not just the top-level
            # pocket_<n>.mrc file.
            for root, _dirs, files in os.walk(pockets_dir):
                for name in sorted(files):
                    full_path = os.path.join(root, name)
                    arcname = os.path.join("pockets", os.path.relpath(full_path, pockets_dir))
                    zf.write(full_path, arcname=arcname)

        fields_dir = jobs_store.fields_dir(job_id)
        if os.path.isdir(fields_dir):
            for name in sorted(os.listdir(fields_dir)):
                zf.write(os.path.join(fields_dir, name), arcname=f"fields/{name}")
    buffer.seek(0)

    return send_file(
        buffer,
        mimetype="application/zip",
        as_attachment=True,
        download_name=f"spocker_{job_id}.zip",
    )
