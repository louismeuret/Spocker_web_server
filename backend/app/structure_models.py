"""
Multi-model (NMR ensemble, etc.) support for legacy-PDB-format uploads.

A structure with several MODEL/ENDMDL blocks can't be handed to the SPOCKER
pipeline as-is -- it needs exactly one conformation. Rather than silently
picking one (pdbfixer's own behaviour here isn't something we want to rely
on), routes.py asks the frontend which model to analyze whenever more than
one is found, then re-submits with that choice.
"""
import re

_MODEL_RE = re.compile(rb"^MODEL\s+(\d+)", re.MULTILINE)


def detect_models(structure_bytes: bytes) -> list:
    """Model numbers found, in file order, de-duplicated. A structure with
    zero or one MODEL records (the overwhelming majority -- single-frame
    X-ray/cryo-EM depositions, and any non-PDB format this regex simply
    won't match) returns a list of length <= 1, meaning "nothing to ask"."""
    seen = []
    for m in _MODEL_RE.finditer(structure_bytes):
        n = int(m.group(1))
        if n not in seen:
            seen.append(n)
    return seen


def extract_model(structure_bytes: bytes, model_num: int) -> bytes:
    """Returns just `model_num`'s MODEL/ENDMDL block, with the wrapper
    records themselves dropped and every other line (HEADER/SEQRES/END/...)
    kept as-is -- the result is a plain single-model PDB file, exactly like
    a structure that never had multiple models to begin with."""
    out = []
    in_model = False
    keep_current = False
    for line in structure_bytes.split(b"\n"):
        if line.startswith(b"MODEL"):
            m = _MODEL_RE.match(line)
            in_model = True
            keep_current = bool(m) and int(m.group(1)) == model_num
            continue
        if line.startswith(b"ENDMDL"):
            in_model = False
            keep_current = False
            continue
        if in_model and not keep_current:
            continue
        out.append(line)
    return b"\n".join(out)
