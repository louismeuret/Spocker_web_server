"""
Fetches a structure straight from RCSB by its 4-character PDB code, so the
frontend can offer "just type a PDB code" as an alternative to uploading a
file. Uses stdlib urllib only -- this is one small HTTP GET, not worth an
extra dependency in the app's own tiny venv (see spocker_bridge.py's docstring
for why the heavy pipeline deps stay in a separate Conda env).
"""
import re
import urllib.error
import urllib.request

PDB_ID_RE = re.compile(r"^[0-9][A-Za-z0-9]{3}$")
RCSB_URL_TEMPLATE = "https://files.rcsb.org/download/{code}.pdb"


class PdbFetchError(RuntimeError):
    pass


def validate_pdb_code(code):
    code = (code or "").strip().upper()
    if not PDB_ID_RE.match(code):
        raise PdbFetchError(
            f"'{code}' doesn't look like a PDB code (expected 4 characters "
            "starting with a digit, e.g. 1EHZ)"
        )
    return code


def fetch_pdb(code, timeout=20):
    """Returns the raw .pdb file bytes for `code`, or raises PdbFetchError."""
    url = RCSB_URL_TEMPLATE.format(code=code)
    req = urllib.request.Request(url, headers={"User-Agent": "spocker-web/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read()
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            raise PdbFetchError(f"No PDB entry found for code '{code}' on RCSB") from exc
        raise PdbFetchError(f"RCSB returned HTTP {exc.code} for '{code}'") from exc
    except urllib.error.URLError as exc:
        raise PdbFetchError(f"Could not reach RCSB to download '{code}': {exc.reason}") from exc
