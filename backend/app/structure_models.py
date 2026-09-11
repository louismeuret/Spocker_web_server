import os
import re
import tempfile
import warnings

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


# PDB chain ids are a single character in the format; a few tools emit up to
# four. Anything else is rejected rather than interpolated, since the chain
# id reaches us off an HTTP form and goes into a selection *expression*.
_CHAIN_ID_RE = re.compile(r"^[A-Za-z0-9]{1,4}$")


def extract_chain(structure_bytes: bytes, chain_id: str) -> bytes:
    if not _CHAIN_ID_RE.match(chain_id or ""):
        return b""

    # Imported here rather than at module scope: MDAnalysis is seconds of
    # import time (and pulls in RDKit), which every request would otherwise
    # pay at server start for a step only chain-restricted jobs reach.
    import MDAnalysis

    with tempfile.TemporaryDirectory(prefix="spocker_chain_") as tmp:
        src = os.path.join(tmp, "full.pdb")
        dest = os.path.join(tmp, "chain.pdb")
        with open(src, "wb") as f:
            f.write(structure_bytes)

        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            universe = MDAnalysis.Universe(src)
            selection = universe.select_atoms(f"chainID {chain_id}")
            if selection.n_atoms == 0:
                return b""
            selection.write(dest)

        with open(dest, "rb") as f:
            return f.read()
