"""
Tests for app/superpose.py's rigid-body superposition.

Stdlib only (no numpy, no pytest) so this runs anywhere the Flask app does:

    cd backend && python3 -m unittest discover tests

The round-trip tests matter more than they look. A transposed rotation is
invisible on the obvious hand-checkable cases -- identity and a 180-degree
flip are both symmetric matrices -- and wrong on every real superposition, so
the only honest check is to generate random rotations, apply them, and assert
the solver recovers exactly what was applied.
"""
import importlib.util
import math
import os
import random
import unittest

# Loaded straight off disk rather than as `from app import superpose`: that
# would run app/__init__.py, which imports Flask, and superpose.py's whole
# point is that it needs nothing but the standard library.
_MODULE_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "app", "superpose.py"
)
_spec = importlib.util.spec_from_file_location("superpose", _MODULE_PATH)
superpose = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(superpose)


def _rotation_from_quaternion(w, x, y, z):
    norm = math.sqrt(w * w + x * x + y * y + z * z)
    w, x, y, z = w / norm, x / norm, y / norm, z / norm
    return [
        [w * w + x * x - y * y - z * z, 2 * (x * y - w * z), 2 * (x * z + w * y)],
        [2 * (x * y + w * z), w * w - x * x + y * y - z * z, 2 * (y * z - w * x)],
        [2 * (x * z - w * y), 2 * (y * z + w * x), w * w - x * x - y * y + z * z],
    ]


def _random_rotation(rng):
    return _rotation_from_quaternion(*[rng.gauss(0, 1) for _ in range(4)])


def _random_points(rng, count, spread=30.0):
    return [tuple(rng.uniform(-spread, spread) for _ in range(3)) for _ in range(count)]


def _determinant(m):
    return (
        m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
    )


class SuperposeTest(unittest.TestCase):
    def test_recovers_a_known_transform(self):
        """The whole contract: given B and A = R*B + t, solve back to R and t."""
        rng = random.Random(20240824)
        for _ in range(200):
            rotation = _random_rotation(rng)
            translation = tuple(rng.uniform(-50, 50) for _ in range(3))
            points_b = _random_points(rng, rng.randint(3, 80))
            points_a = [superpose.apply_transform(rotation, translation, p) for p in points_b]

            got_rotation, got_translation, rmsd = superpose.superpose(points_a, points_b)

            self.assertAlmostEqual(rmsd, 0.0, places=6)
            for i in range(3):
                self.assertAlmostEqual(got_translation[i], translation[i], places=5)
                for j in range(3):
                    self.assertAlmostEqual(got_rotation[i][j], rotation[i][j], places=6)

    def test_rmsd_matches_injected_noise(self):
        """Isotropic noise of sigma per axis gives an RMSD of sigma*sqrt(3)."""
        rng = random.Random(11)
        sigma = 0.5
        rotation = _random_rotation(rng)
        translation = (3.0, -4.0, 5.0)
        points_b = _random_points(rng, 2000, spread=20.0)
        points_a = [
            tuple(c + rng.gauss(0, sigma) for c in superpose.apply_transform(rotation, translation, p))
            for p in points_b
        ]

        _, _, rmsd = superpose.superpose(points_a, points_b)
        self.assertAlmostEqual(rmsd, sigma * math.sqrt(3), delta=0.05)

    def test_never_returns_a_reflection(self):
        """A mirrored point set has no rigid solution -- the answer must be a
        poor-but-proper rotation, never a determinant -1 reflection that would
        turn the structure inside out in the viewer."""
        rng = random.Random(3)
        points_b = _random_points(rng, 60, spread=20.0)
        points_a = [(x, y, -z) for x, y, z in points_b]

        rotation, _, rmsd = superpose.superpose(points_a, points_b)

        self.assertAlmostEqual(_determinant(rotation), 1.0, places=6)
        self.assertGreater(rmsd, 1.0)

    def test_identical_point_sets_give_identity(self):
        rng = random.Random(5)
        points = _random_points(rng, 40)

        rotation, translation, rmsd = superpose.superpose(points, points)

        self.assertAlmostEqual(rmsd, 0.0, places=9)
        for i in range(3):
            self.assertAlmostEqual(translation[i], 0.0, places=6)
            for j in range(3):
                self.assertAlmostEqual(rotation[i][j], 1.0 if i == j else 0.0, places=9)

    def test_requires_at_least_three_points(self):
        with self.assertRaises(superpose.SuperpositionError):
            superpose.superpose([(0, 0, 0), (1, 1, 1)], [(0, 0, 0), (1, 1, 1)])

    def test_rejects_mismatched_lengths(self):
        with self.assertRaises(superpose.SuperpositionError):
            superpose.superpose([(0, 0, 0)] * 4, [(0, 0, 0)] * 3)

    def test_rotation_column_major_matches_molviewspec_order(self):
        """MVS wants j*3+i (Fortran) order -- see buildCompareScene.js."""
        self.assertEqual(
            superpose.rotation_column_major([[1, 2, 3], [4, 5, 6], [7, 8, 9]]),
            [1, 4, 7, 2, 5, 8, 3, 6, 9],
        )


class NeedlemanWunschTest(unittest.TestCase):
    def test_aligns_around_an_insertion(self):
        score, pairs = superpose._needleman_wunsch("GAUC", "GAXUC")
        self.assertEqual([p[0] for p in pairs], [0, 1, 2, 3])
        self.assertEqual([p[1] for p in pairs], [0, 1, 3, 4])
        self.assertGreater(score, 0)

    def test_keeps_mismatched_columns(self):
        """A point mutation still superposes -- dropping the column would throw
        away a perfectly good pair of coordinates."""
        _, pairs = superpose._needleman_wunsch("GAUC", "GAGC")
        self.assertEqual(pairs, [(0, 0), (1, 1), (2, 2), (3, 3)])

    def test_unknown_residues_never_score_as_matches(self):
        score_known, _ = superpose._needleman_wunsch("AAAA", "AAAA")
        score_unknown, _ = superpose._needleman_wunsch("NNNN", "NNNN")
        self.assertGreater(score_known, score_unknown)


class ResidueMatchingTest(unittest.TestCase):
    def _residues(self, chain, start, sequence):
        residues, order = {}, []
        for offset, base in enumerate(sequence):
            key = (chain, start + offset)
            residues[key] = {"chain": chain, "resi": start + offset, "resn": base, "atoms": {}}
            order.append(key)
        return residues, order

    def test_prefers_numbering_when_it_lines_up(self):
        residues_a, order_a = self._residues("A", 1, "GAUCGAUCGA")
        residues_b, order_b = self._residues("A", 1, "GAUCGAUCGA")

        pairs, method = superpose.match_residues(residues_a, order_a, residues_b, order_b)

        self.assertEqual(method, "residue-numbering")
        self.assertEqual(len(pairs), 10)

    def test_falls_back_to_sequence_when_numbering_is_offset(self):
        residues_a, order_a = self._residues("A", 1, "GAUCGAUCGA")
        residues_b, order_b = self._residues("B", 501, "GAUCGAUCGA")

        pairs, method = superpose.match_residues(residues_a, order_a, residues_b, order_b)

        self.assertEqual(method, "sequence-alignment")
        self.assertEqual(len(pairs), 10)
        self.assertEqual(pairs[0], (("A", 1), ("B", 501)))

    def test_no_residues_yields_no_match(self):
        pairs, method = superpose.match_residues({}, [], {}, [])
        self.assertEqual(pairs, [])
        self.assertEqual(method, "none")


if __name__ == "__main__":
    unittest.main()
