#!/usr/bin/env python3
"""Self-check for the grid post-processing in serve_pockets.py: the viewer
downscale and the APBS sign split. Both quietly change what the 3D viewer
draws, so they are worth a check that fails loudly.

Run under the same environment as serve_pockets.py itself (needs numpy and
mrcfile -- see app/spocker_bridge.py for how that env is found):

    python3 test_serve_pockets.py
"""
import tempfile
from pathlib import Path

import numpy as np

import serve_pockets as sp


def test_downscale_keeps_voxels_above_an_isovalue():
    # A single hot voxel in an otherwise empty grid: mean-pooling would dilute
    # it below any sensible threshold, block-max must not.
    data = np.zeros((8, 8, 8), dtype=np.float32)
    data[3, 5, 1] = 7.0
    small = sp._downscale(data, 2)
    assert small.shape == (4, 4, 4)
    assert small.max() == 7.0
    assert small[1, 2, 0] == 7.0  # same world position, halved indices


def test_downscale_crops_rather_than_pads_a_ragged_axis():
    data = np.ones((5, 4, 4), dtype=np.float32)
    assert sp._downscale(data, 2).shape == (2, 2, 2)
    # factor 1 is the identity, which is what DISPLAY_DOWNSCALE=1 relies on
    assert np.array_equal(sp._downscale(data, 1), data)


def test_apbs_split_is_two_all_positive_halves():
    apbs = np.array([[[-3.0, 0.0, 2.0]]], dtype=np.float32)
    grids = dict(sp._display_grids("apbs", apbs))
    assert set(grids) == {"apbs", "apbs_neg", "apbs_pos"}
    assert np.array_equal(grids["apbs"], apbs), "the original must survive untouched"
    assert np.array_equal(grids["apbs_neg"], [[[3.0, 0.0, 0.0]]])
    assert np.array_equal(grids["apbs_pos"], [[[0.0, 0.0, 2.0]]])
    for name in ("apbs_neg", "apbs_pos"):
        assert grids[name].min() >= 0, f"{name} must be renderable at a positive isovalue"


def test_other_fields_are_left_alone():
    stacking = np.ones((2, 2, 2), dtype=np.float32)
    assert [n for n, _ in sp._display_grids("stacking", stacking)] == ["stacking"]


def test_display_companion_round_trips_through_mrc():
    data = np.zeros((4, 4, 4), dtype=np.float32)
    data[2, 2, 2] = 5.0
    voxel = np.array([0.25, 0.25, 0.25])
    origin = np.array([1.0, 2.0, 3.0])

    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "stacking.mrc"
        sp._write_mrc(path, data, voxel, origin)
        sp._write_display_mrc(path, data, voxel, origin)

        display = path.with_suffix(".display.mrc")
        if sp.DISPLAY_DOWNSCALE <= 1:
            assert not display.exists()
            return

        assert path.exists(), "the full-resolution grid must still be there to download"
        read, read_voxel, read_origin = sp._load_mrc(display)
        assert read.shape == tuple(s // sp.DISPLAY_DOWNSCALE for s in data.shape)
        assert read.max() == 5.0
        # Coarser voxels, same origin -- otherwise the isosurface would land
        # somewhere other than the pocket it belongs to.
        assert np.allclose(read_voxel, voxel * sp.DISPLAY_DOWNSCALE)
        assert np.allclose(read_origin, origin)


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok  {name}")
    print("all passed")
