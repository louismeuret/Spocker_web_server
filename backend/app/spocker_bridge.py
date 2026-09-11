"""
Bridge to the real SPOCKER pocket-detection pipeline (backend/new_spocker/,
driven via backend/serve_pockets.py -- both live alongside this app/
package, so the whole backend/ folder is self-contained and can be moved or
deployed on its own).

The pipeline needs its own heavy Conda environment (numpy/scipy/
MDAnalysis/mrcfile/volgrids) plus the pdbfixer/molutils CLIs -- see
demo_spocker/environment.yml at the repo root for how to build it. Rather
than pulling all of that into this app's own tiny venv, we shell out to
backend/serve_pockets.py running under that environment's interpreter, and
only consume the single JSON object it prints on stdout. serve_pockets.py
in turn drives the single-PDB CLI scripts in backend/new_spocker/.
"""
import json
import os
import shutil
import subprocess
import tempfile
import traceback
from pathlib import Path

from . import config

SERVE_SCRIPT = Path(config.BASE_DIR) / "serve_pockets.py"

# Progress lines serve_pockets.py writes to stderr. Must stay identical to
# PROGRESS_PREFIX there; it can't be imported, since that script runs under a
# different Python environment entirely (see this module's docstring).
PROGRESS_PREFIX = "@@SPOCKER_PROGRESS "

# demo_spocker's tooling (pdbfixer, molutils, volgrids, and the python3 that
# has numpy/scipy/mrcfile/MDAnalysis -- see environment.yml) lives outside
# this app's own venv, typically in a dedicated Conda env. We can't assume
# where that env lives (it varies per machine/install), so:
#   1. SPOCKER_ENV_BIN, if set, wins outright -- the escape hatch for any
#      setup the auto-detection below doesn't cover.
#   2. Otherwise, search common Conda roots for an env named "spocker"
#      (environment.yml's `name:`), then fall back to each root's base env,
#      picking the first bin/ directory that actually has `volgrids` in it.
_ENV_NAME = "spocker"
_CONDA_ROOT_CANDIDATES = [
    os.environ.get("CONDA_PREFIX_1"),  # base env prefix, if a Conda env is active
    os.environ.get("CONDA_PREFIX"),
    "~/miniconda3", "~/anaconda3", "~/miniforge3", "~/mambaforge",
    "/opt/miniconda3", "/opt/anaconda3", "/opt/conda",
]


def _find_spocker_bin_dir():
    override = os.environ.get("SPOCKER_ENV_BIN")
    if override:
        return override

    conda_exe = os.environ.get("CONDA_EXE")
    roots = list(_CONDA_ROOT_CANDIDATES)
    if conda_exe:
        roots.insert(0, str(Path(conda_exe).resolve().parent.parent))

    seen = set()
    candidate_dirs = []
    for root in roots:
        if not root:
            continue
        root = Path(os.path.expanduser(root)).resolve() if os.path.isdir(os.path.expanduser(root)) else None
        if root is None or root in seen:
            continue
        seen.add(root)
        candidate_dirs.append(root / "envs" / _ENV_NAME / "bin")
        candidate_dirs.append(root / "bin")

    for bin_dir in candidate_dirs:
        if (bin_dir / "volgrids").exists():
            return str(bin_dir)
    return None

# Distinct, colour-blind-friendlyish palette used to tell pockets apart in
# the Mol* viewer. The website chrome around it stays strict black & white;
# this is scientific payload, not UI, so it gets colour.
POCKET_COLORS = [
    "#e6194B", "#3cb44b", "#4363d8", "#f58231", "#911eb4",
    "#42d4f4", "#f032e6", "#bfef45", "#fabed4", "#469990",
]


class PocketDetectionError(RuntimeError):
    pass


def _subprocess_env():
    env = os.environ.copy()
    extra_dirs = []
    spocker_bin = _find_spocker_bin_dir()
    if spocker_bin:
        extra_dirs.append(spocker_bin)
    # pdbfixer is sometimes a separate pip/pipx install outside the Conda
    # env (e.g. `pip install --user pdbfixer`) rather than the one from
    # environment.yml -- keep this on PATH too so that setup still works.
    extra_dirs.append(os.path.expanduser("~/.local/bin"))
    existing_dirs = env.get("PATH", "").split(os.pathsep)
    merged = extra_dirs + [d for d in existing_dirs if d not in extra_dirs]
    env["PATH"] = os.pathsep.join(merged)
    # The pipeline's stage announcements are only useful if they arrive while
    # it is still running; Python block-buffers stdout when it isn't a tty,
    # which would hold them all back until each script exits.
    env["PYTHONUNBUFFERED"] = "1"
    return env


def _spocker_python(env):
    python = shutil.which("python3", path=env["PATH"])
    if python is None or shutil.which("volgrids", path=env["PATH"]) is None:
        raise PocketDetectionError(
            "Cannot find demo_spocker's Conda environment (needs `volgrids`, "
            "`pdbfixer`, `molutils` and a python3 with numpy/scipy/mrcfile/"
            "MDAnalysis -- see demo_spocker/environment.yml). Searched "
            f"PATH={env['PATH']}. If it's installed somewhere non-standard, "
            "set SPOCKER_ENV_BIN to that env's bin/ directory."
        )
    return python


def _run_reporting_progress(cmd, env, on_progress):
    """Runs the bridge script, calling `on_progress(percent, message)` for
    each progress line it writes to stderr as it goes, and returning
    (stdout, stderr, returncode) once it finishes.

    stdout is collected into a temp file rather than a second pipe: it
    carries the whole result JSON, and draining only the stderr pipe while
    stdout's fills would deadlock the moment the result outgrew the pipe
    buffer. Progress lines are stripped out of the returned stderr so a
    failure message isn't padded with them.
    """
    diagnostics = []
    with tempfile.TemporaryFile("w+", errors="replace") as out_file:
        proc = subprocess.Popen(cmd, stdout=out_file, stderr=subprocess.PIPE, text=True, env=env, bufsize=1)
        for line in proc.stderr:
            line = line.rstrip("\n")
            if not line.startswith(PROGRESS_PREFIX):
                diagnostics.append(line)
                continue
            percent, _, message = line[len(PROGRESS_PREFIX):].partition(" ")
            try:
                percent = int(percent)
            except ValueError:
                diagnostics.append(line)
                continue
            if on_progress:
                try:
                    on_progress(percent, message)
                except Exception:  # noqa: BLE001
                    # A cosmetic status update is never worth losing a
                    # pipeline run that has been going for minutes -- and
                    # bailing here would also leave the subprocess writing
                    # into a closed stdout file.
                    traceback.print_exc()
        proc.wait()
        out_file.seek(0)
        stdout = out_file.read()
    return stdout, "\n".join(diagnostics), proc.returncode


def run_pocket_detection(job_id: str, input_path: str, job_dir: str, display_downscale=None,
                         on_progress=None) -> dict:
    if not SERVE_SCRIPT.exists():
        raise PocketDetectionError(f"Bridge script not found: {SERVE_SCRIPT}")

    env = _subprocess_env()
    python = _spocker_python(env)
    # Viewer-only grid resolution, chosen per job on the upload page (see
    # serve_pockets.py's DISPLAY_DOWNSCALE). The pipeline's own grids are
    # unaffected.
    env["SPOCKER_DISPLAY_DOWNSCALE"] = str(display_downscale or config.DEFAULT_DISPLAY_DOWNSCALE)

    stdout, stderr, returncode = _run_reporting_progress(
        [python, str(SERVE_SCRIPT), str(input_path), str(job_dir), job_id], env, on_progress
    )
    if returncode != 0:
        tail = (stdout + stderr).strip()[-4000:]
        raise PocketDetectionError(f"Pocket-detection pipeline failed:\n{tail}")

    try:
        data = json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise PocketDetectionError(
            f"Pipeline produced non-JSON output ({exc}):\n{stdout[-2000:]}"
        ) from exc

    pockets = []
    for i, p in enumerate(data.get("pockets", [])):
        pockets.append({
            "id": f"pocket_{i + 1}",
            "rank": i + 1,
            "name": p["contributing_fields"],
            "score": p["score"],
            "volume": p["volume"],
            "surface_area": p["surface_area"],
            "color": POCKET_COLORS[i % len(POCKET_COLORS)],
            "center": p["center"],
            "residues": p["residues"],
            "field_contributions": p.get("field_contributions", {}),
        })

    return {
        "job_id": job_id,
        "structure": data["structure"],
        "fields": data.get("fields", []),
        "pockets": pockets,
    }
