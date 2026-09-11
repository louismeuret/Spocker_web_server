"""
Fetches a structure from RCSB by its PDB code
"""
import re
import urllib.error
import urllib.request

PDB_ID_RE = re.compile(r"^[0-9][A-Za-z0-9]{3}$")
RCSB_URL_TEMPLATE = "https://files.rcsb.org/download/{code}.pdb"

_COMPND_TOKEN_RE = re.compile(r"(MOLECULE|CHAIN):\s*([^;]*)", re.IGNORECASE)

_NUCLEIC_RESNAMES = {
    "A", "C", "G", "U", "I",
    "DA", "DC", "DG", "DT", "DI",
    "ADE", "CYT", "GUA", "URI",
}


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


def list_chains(structure_bytes: bytes) -> list:
    names = _chain_names(structure_bytes)
    chains = {}
    for line in structure_bytes.split(b"\n"):
        if not line.startswith((b"ATOM", b"HETATM")):
            continue
        try:
            chain_id = line[21:22].decode("ascii", "replace").strip() or "A"
            resname = line[17:20].decode("ascii", "replace").strip().upper()
            residue = line[22:27]  # resSeq + iCode, the whole residue key
        except IndexError:
            continue
        chain = chains.setdefault(chain_id, {"id": chain_id, "name": names.get(chain_id, ""), "seen": set(), "nucleic": set()})
        chain["seen"].add(residue)
        if resname in _NUCLEIC_RESNAMES:
            chain["nucleic"].add(residue)

    return [
        {
            "id": c["id"],
            "name": c["name"],
            "residues": len(c["seen"]),
            "nucleic_residues": len(c["nucleic"]),
        }
        for c in chains.values()
    ]


def _chain_names(structure_bytes: bytes) -> dict:
    names = {}
    molecule = ""
    for line in structure_bytes.split(b"\n"):
        if not line.startswith(b"COMPND"):
            continue
        text = line[10:].decode("ascii", "replace")
        for key, value in _COMPND_TOKEN_RE.findall(text):
            if key.upper() == "MOLECULE":
                molecule = value.strip()
            else:
                for chain_id in (c.strip() for c in value.split(",")):
                    if chain_id:
                        names[chain_id] = molecule
    return names
