"""
Rigid-body superposition of two structures, in pure Python.

Deliberately dependency-free. Unlike the pocket-detection pipeline (see
spocker_bridge.py, which shells out to a heavy Conda environment for
numpy/scipy/MDAnalysis/volgrids), putting two *already computed* jobs into a
common frame is a small geometric problem: find a residue correspondence,
solve for the optimal rotation, report an RMSD. Keeping it inside the Flask
process' own tiny venv means the compare mode works on any install, even one
where the SPOCKER environment isn't set up at all.

The optimal rotation comes from Horn's quaternion method: build the 4x4
"key matrix" from the 3x3 cross-covariance of the two centred point sets and
take the eigenvector belonging to its largest eigenvalue. The eigenproblem
is solved with a cyclic Jacobi sweep -- exact, deterministic, and unbothered
by the near-degenerate leading eigenvalues that make power iteration stall on
symmetric structures.

Everything here works on (chain, resi) residue keys parsed straight out of a
PDB file's fixed columns, matching backend/serve_pockets.py's own
parse_rna_atoms -- so residue keys line up with the ones stored in each job's
result.json pocket "residues" lists.
"""
import math

# Global-alignment cost cap. A pure-Python Needleman-Wunsch fills one cell per
# residue pair, so this bounds the worst case to well under a second. RNA
# chains are orders of magnitude shorter than this in practice; anything that
# trips the cap falls back to matching residues by numbering.
NW_MAX_CELLS = 4_000_000

# Needleman-Wunsch scoring. Linear gap cost -- affine gaps buy nothing here,
# since we only need residue *correspondence*, not a publishable alignment.
NW_MATCH = 2
NW_MISMATCH = -1
NW_GAP = -2

_BASES = "AUGCT"


class SuperpositionError(RuntimeError):
    pass


# ---------------------------------------------------------------- parsing


def parse_residues(pdb_path):
    """Reads a PDB into {(chain, resi): {chain, resi, resn, atoms}} plus the
    order residues first appear in the file.

    `atoms` maps heavy-atom name -> (x, y, z). Hydrogens are dropped: the
    structures being compared have been through PDBFixer (which adds them),
    so keeping them would make the RMSD depend on rebuilt coordinates rather
    than on experimental ones. Alternate locations collapse to whichever
    appears first, same as serve_pockets.py's parse_rna_atoms.
    """
    residues = {}
    order = []
    with open(pdb_path, errors="ignore") as f:
        for line in f:
            if line[:6].strip() not in ("ATOM", "HETATM"):
                continue
            try:
                chain = line[21:22].strip() or "A"
                resi = int(line[22:26])
                resn = line[17:20].strip()
                name = line[12:16].strip()
                xyz = (float(line[30:38]), float(line[38:46]), float(line[46:54]))
            except (ValueError, IndexError):
                continue
            if _is_hydrogen(line, name):
                continue
            key = (chain, resi)
            residue = residues.get(key)
            if residue is None:
                residue = {"chain": chain, "resi": resi, "resn": resn, "atoms": {}}
                residues[key] = residue
                order.append(key)
            residue["atoms"].setdefault(name, xyz)
    return residues, order


def _is_hydrogen(line, name):
    element = line[76:78].strip().upper()
    if element:
        return element == "H"
    # No element column (hand-edited/minimal PDBs): fall back to the PDB atom
    # naming convention, where a leading digit is a branch number.
    stripped = name.lstrip("0123456789")
    return stripped[:1] == "H"


def _chains_in_order(order):
    chains = {}
    for key in order:
        chains.setdefault(key[0], []).append(key)
    return chains


def _letter(resn):
    """One-letter base code, tolerant of RNA (A/U/G/C), DNA (DA/DT/...) and
    the three-letter spellings some tools emit. Anything unrecognised becomes
    'N', which never scores as a match."""
    resn = resn.strip().upper()
    if not resn:
        return "N"
    last = resn[-1]
    return last if last in _BASES else "N"


# ------------------------------------------------- residue correspondence


def _match_by_numbering(residues_a, residues_b):
    """Pairs residues that share a (chain, resi) key *and* a residue name.

    The common case by far: two jobs run on the same construct (a re-run, a
    different model of one NMR ensemble, a ligand-bound vs free form deposited
    with consistent numbering). Instant, and exactly right when it applies.
    """
    pairs = []
    for key, residue in residues_a.items():
        other = residues_b.get(key)
        if other is not None and other["resn"] == residue["resn"]:
            pairs.append((key, key))
    return pairs


def _needleman_wunsch(seq_a, seq_b):
    """Global alignment. Returns (score, [(i, j), ...]) index pairs for every
    aligned (non-gap) column, mismatches included -- a point mutation still
    superposes perfectly well, so dropping those pairs would only throw away
    signal."""
    n, m = len(seq_a), len(seq_b)
    score = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        score[i][0] = i * NW_GAP
    for j in range(1, m + 1):
        score[0][j] = j * NW_GAP

    for i in range(1, n + 1):
        ai = seq_a[i - 1]
        row, prev = score[i], score[i - 1]
        for j in range(1, m + 1):
            sub = NW_MATCH if (ai == seq_b[j - 1] and ai != "N") else NW_MISMATCH
            best = prev[j - 1] + sub
            up = prev[j] + NW_GAP
            if up > best:
                best = up
            left = row[j - 1] + NW_GAP
            if left > best:
                best = left
            row[j] = best

    pairs = []
    i, j = n, m
    while i > 0 and j > 0:
        ai = seq_a[i - 1]
        sub = NW_MATCH if (ai == seq_b[j - 1] and ai != "N") else NW_MISMATCH
        if score[i][j] == score[i - 1][j - 1] + sub:
            pairs.append((i - 1, j - 1))
            i -= 1
            j -= 1
        elif score[i][j] == score[i - 1][j] + NW_GAP:
            i -= 1
        else:
            j -= 1
    pairs.reverse()
    return score[n][m], pairs


def _match_by_alignment(residues_a, order_a, residues_b, order_b):
    """Sequence-based correspondence, for structures whose numbering doesn't
    line up (different constructs, renumbered depositions, truncations).

    Chains are paired greedily by alignment score rather than by chain id --
    the same molecule is routinely chain A in one entry and chain B in
    another, and a chain id is not an identity.
    """
    chains_a = _chains_in_order(order_a)
    chains_b = _chains_in_order(order_b)

    scored = []
    for chain_a, keys_a in chains_a.items():
        seq_a = "".join(_letter(residues_a[k]["resn"]) for k in keys_a)
        for chain_b, keys_b in chains_b.items():
            if len(keys_a) * len(keys_b) > NW_MAX_CELLS:
                continue
            seq_b = "".join(_letter(residues_b[k]["resn"]) for k in keys_b)
            score, index_pairs = _needleman_wunsch(seq_a, seq_b)
            scored.append((score, chain_a, chain_b, keys_a, keys_b, index_pairs))

    # Sort by score, then by chain ids so equally-scoring pairings (identical
    # chains of a symmetric assembly) resolve the same way on every request.
    scored.sort(key=lambda item: (-item[0], item[1], item[2]))

    used_a, used_b = set(), set()
    pairs = []
    for score, chain_a, chain_b, keys_a, keys_b, index_pairs in scored:
        if score <= 0 or chain_a in used_a or chain_b in used_b:
            continue
        used_a.add(chain_a)
        used_b.add(chain_b)
        pairs.extend((keys_a[i], keys_b[j]) for i, j in index_pairs)
    return pairs


def match_residues(residues_a, order_a, residues_b, order_b):
    """Returns (pairs, method). Tries numbering first and only falls back to
    sequence alignment when numbering explains less than half of the smaller
    structure -- a partial numbering overlap usually means the two files just
    happen to share a residue range, not that they describe the same thing."""
    smaller = min(len(residues_a), len(residues_b))
    if smaller == 0:
        return [], "none"

    by_numbering = _match_by_numbering(residues_a, residues_b)
    if len(by_numbering) >= 0.5 * smaller:
        return by_numbering, "residue-numbering"

    by_alignment = _match_by_alignment(residues_a, order_a, residues_b, order_b)
    if len(by_alignment) >= len(by_numbering):
        return by_alignment, "sequence-alignment"
    return by_numbering, "residue-numbering"


def paired_atom_coords(residues_a, residues_b, residue_pairs):
    """Every heavy atom that matched residues share by name, in a stable
    order. Using all shared atoms rather than one representative per residue
    (C1'/P) gives the superposition far more to work with and makes the
    reported RMSD a plain heavy-atom RMSD over the matched region."""
    coords_a, coords_b = [], []
    for key_a, key_b in residue_pairs:
        atoms_a = residues_a[key_a]["atoms"]
        atoms_b = residues_b[key_b]["atoms"]
        for name, xyz in atoms_a.items():
            other = atoms_b.get(name)
            if other is not None:
                coords_a.append(xyz)
                coords_b.append(other)
    return coords_a, coords_b


# ------------------------------------------------------------ the algebra


def _jacobi_eigen(matrix, sweeps=100, tol=1e-14):
    """Eigen-decomposition of a small real symmetric matrix by cyclic Jacobi
    rotations. Returns (eigenvalues, eigenvectors) where eigenvectors[k] is
    the vector belonging to eigenvalues[k]."""
    n = len(matrix)
    a = [row[:] for row in matrix]
    v = [[1.0 if i == j else 0.0 for j in range(n)] for i in range(n)]

    for _ in range(sweeps):
        off = 0.0
        p = q = 0
        largest = 0.0
        for i in range(n):
            for j in range(i + 1, n):
                magnitude = abs(a[i][j])
                off += magnitude * magnitude
                if magnitude > largest:
                    largest, p, q = magnitude, i, j
        if off <= tol:
            break

        app, aqq, apq = a[p][p], a[q][q], a[p][q]
        theta = (aqq - app) / (2.0 * apq)
        sign = 1.0 if theta >= 0.0 else -1.0
        t = sign / (abs(theta) + math.sqrt(theta * theta + 1.0))
        c = 1.0 / math.sqrt(t * t + 1.0)
        s = t * c

        for k in range(n):
            akp, akq = a[k][p], a[k][q]
            a[k][p] = c * akp - s * akq
            a[k][q] = s * akp + c * akq
        for k in range(n):
            apk, aqk = a[p][k], a[q][k]
            a[p][k] = c * apk - s * aqk
            a[q][k] = s * apk + c * aqk
        for k in range(n):
            vkp, vkq = v[k][p], v[k][q]
            v[k][p] = c * vkp - s * vkq
            v[k][q] = s * vkp + c * vkq

    eigenvalues = [a[i][i] for i in range(n)]
    eigenvectors = [[v[i][j] for i in range(n)] for j in range(n)]
    return eigenvalues, eigenvectors


def _centroid(coords):
    n = len(coords)
    sx = sy = sz = 0.0
    for x, y, z in coords:
        sx += x
        sy += y
        sz += z
    return (sx / n, sy / n, sz / n)


def superpose(coords_a, coords_b):
    """Optimal rigid transform taking B onto A: returns (rotation,
    translation, rmsd) with `rotation` a row-major 3x3 (list of rows) such
    that ``a_i ~= rotation @ b_i + translation``.

    Reflections are impossible by construction -- the quaternion
    parameterisation only spans proper rotations -- so unlike a bare SVD
    solution there's no determinant correction to get wrong.
    """
    n = len(coords_a)
    if n != len(coords_b):
        raise SuperpositionError("Point sets must have the same length")
    if n < 3:
        raise SuperpositionError(
            f"Need at least 3 matched atoms to superpose two structures, got {n}"
        )

    centroid_a = _centroid(coords_a)
    centroid_b = _centroid(coords_b)

    # Cross-covariance over the centred coordinates, in Horn's orientation:
    # m[i][j] = sum_k b'_k[i] * a'_k[j], with the *moving* set (B) on the row
    # index. Swapping the two here transposes the resulting rotation, which is
    # invisible on symmetric test cases (identity, a 180-degree flip) and wrong
    # on every real one -- so it is checked by the round-trip assertions in the
    # module's own test, not by inspection.
    m = [[0.0] * 3 for _ in range(3)]
    for (ax, ay, az), (bx, by, bz) in zip(coords_a, coords_b):
        a0 = ax - centroid_a[0]
        a1 = ay - centroid_a[1]
        a2 = az - centroid_a[2]
        b0 = bx - centroid_b[0]
        b1 = by - centroid_b[1]
        b2 = bz - centroid_b[2]
        m[0][0] += b0 * a0
        m[0][1] += b0 * a1
        m[0][2] += b0 * a2
        m[1][0] += b1 * a0
        m[1][1] += b1 * a1
        m[1][2] += b1 * a2
        m[2][0] += b2 * a0
        m[2][1] += b2 * a1
        m[2][2] += b2 * a2

    # Horn's key matrix. Its top eigenvector is the quaternion of the rotation
    # that maximises sum_k (R b'_k) . a'_k, i.e. minimises the RMSD.
    xx, xy, xz = m[0]
    yx, yy, yz = m[1]
    zx, zy, zz = m[2]
    key = [
        [xx + yy + zz, yz - zy, zx - xz, xy - yx],
        [yz - zy, xx - yy - zz, xy + yx, zx + xz],
        [zx - xz, xy + yx, -xx + yy - zz, yz + zy],
        [xy - yx, zx + xz, yz + zy, -xx - yy + zz],
    ]

    eigenvalues, eigenvectors = _jacobi_eigen(key)
    best = max(range(4), key=lambda i: eigenvalues[i])
    w, x, y, z = eigenvectors[best]
    norm = math.sqrt(w * w + x * x + y * y + z * z)
    if norm == 0.0:
        raise SuperpositionError("Degenerate superposition (null quaternion)")
    w, x, y, z = w / norm, x / norm, y / norm, z / norm

    rotation = [
        [w * w + x * x - y * y - z * z, 2.0 * (x * y - w * z), 2.0 * (x * z + w * y)],
        [2.0 * (x * y + w * z), w * w - x * x + y * y - z * z, 2.0 * (y * z - w * x)],
        [2.0 * (x * z - w * y), 2.0 * (y * z + w * x), w * w - x * x - y * y + z * z],
    ]

    # t = centroid_a - R @ centroid_b, so the transform maps B's centroid onto
    # A's exactly.
    rotated_centroid_b = apply_transform(rotation, (0.0, 0.0, 0.0), centroid_b)
    translation = (
        centroid_a[0] - rotated_centroid_b[0],
        centroid_a[1] - rotated_centroid_b[1],
        centroid_a[2] - rotated_centroid_b[2],
    )

    # Measured directly rather than derived from the eigenvalue: one extra
    # O(n) pass, and it can't silently disagree with the transform we return.
    total = 0.0
    for point_a, point_b in zip(coords_a, coords_b):
        px, py, pz = apply_transform(rotation, translation, point_b)
        total += (px - point_a[0]) ** 2 + (py - point_a[1]) ** 2 + (pz - point_a[2]) ** 2
    rmsd = math.sqrt(total / n)

    return rotation, translation, rmsd


def apply_transform(rotation, translation, point):
    x, y, z = point
    return (
        rotation[0][0] * x + rotation[0][1] * y + rotation[0][2] * z + translation[0],
        rotation[1][0] * x + rotation[1][1] * y + rotation[1][2] * z + translation[1],
        rotation[2][0] * x + rotation[2][1] * y + rotation[2][2] * z + translation[2],
    )


def rotation_column_major(rotation):
    """Flattens a row-major 3x3 into the column-major (j*3+i) order MolViewSpec's
    `transform` node expects for its `rotation` parameter -- see
    frontend/src/molstar/buildCompareScene.js, which feeds it straight through."""
    return [rotation[i][j] for j in range(3) for i in range(3)]
