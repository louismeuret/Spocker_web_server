import { useEffect, useRef, useState } from "react";
import { loadMolstar } from "./loadMolstar";

/**
 * Mol* viewer lifecycle, shared by MolstarViewer (one job) and CompareViewer
 * (two superposed jobs).
 *
 * The boring, identical-either-way parts live here: create the viewer once
 * into a container, tear it down on unmount, expose a ready/error status,
 * report whether a scene is currently loading, and push a built scene. What
 * each viewer actually *draws* stays in its own component -- that's the part
 * that differs, and each keeps its own effect so its dependency list stays
 * explicit.
 *
 * Every Mol*-facing call is wrapped in try/catch and logged -- Mol*'s API is
 * large and this is the part of the app most likely to need debugging against
 * a specific installed bundle version.
 */
export function useMolstarViewer({ containerRef, onError }) {
  const viewerRef = useRef(null);
  // Once this is set, there is a user camera worth protecting, so every
  // later scene load leaves it alone unless asked otherwise (see loadScene).
  const hasLoadedOnceRef = useRef(false);
  const [status, setStatus] = useState("loading"); // loading | ready | error
  // Scene loads in flight. MRC volume grids are megabytes each and are
  // downloaded + parsed + triangulated before anything appears, which is
  // long enough that without a spinner the viewer just looks frozen.
  const [busy, setBusy] = useState(false);
  const inFlightRef = useRef(0);

  useEffect(() => {
    let disposed = false;

    loadMolstar()
      .then((molstar) =>
        molstar.Viewer.create(containerRef.current, {
          layoutIsExpanded: false,
          layoutShowControls: false,
          layoutShowRemoteState: false,
          layoutShowSequence: true,
          layoutShowLog: false,
          layoutShowLeftPanel: false,
          viewportShowExpand: true,
          viewportShowSelectionMode: false,
          viewportShowAnimation: false,
        })
      )
      .then((viewer) => {
        if (disposed) {
          viewer.dispose();
          return;
        }
        viewerRef.current = viewer;
        setStatus("ready");
      })
      .catch((err) => {
        console.error("[molstar] failed to initialize viewer", err);
        setStatus("error");
        onError?.(err.message || String(err));
      });

    return () => {
      disposed = true;
      try {
        viewerRef.current?.dispose();
      } catch (err) {
        console.error("[molstar] dispose failed", err);
      }
      viewerRef.current = null;
      hasLoadedOnceRef.current = false;
    };
    // Created once per mount; scene updates go through loadMvsData instead of
    // re-creating the viewer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function resetView() {
    try {
      viewerRef.current?.plugin?.canvas3d?.requestCameraReset();
    } catch (err) {
      console.error("[molstar] resetView failed", err);
    }
  }

  /**
   * Build a scene with `buildState(molstarLib)` and push it to the viewer.
   * Returns the cleanup a caller's effect should return -- a scene still in
   * flight when the deps change is abandoned rather than loaded late.
   *
   * The camera belongs to the user. Every toggle here rebuilds and reloads
   * the whole MVS scene, and by default Mol* derives a camera from it, so
   * ticking a checkbox would otherwise yank the view back to a fit-all of
   * the new scene and throw away wherever they had navigated to. Passing
   * `keepCamera` makes Mol* ignore the scene's camera entirely (as opposed
   * to `keepCameraOrientation`, which keeps the angle but still recomputes
   * the target and zoom -- still a jump).
   *
   * Two cases legitimately move it, and both are explicit requests:
   * `moveCamera` (a Focus button, whose scene carries an MVS focus node),
   * and the very first load, which has no user camera to preserve and must
   * frame the structure.
   */
  function loadScene(buildState, { onLoaded, moveCamera = false } = {}) {
    if (status !== "ready" || !viewerRef.current) return undefined;

    let cancelled = false;
    loadMolstar()
      .then(async (molstar) => {
        const state = buildState(molstar.lib);
        if (cancelled || !state) return;
        inFlightRef.current += 1;
        setBusy(true);
        try {
          await viewerRef.current.loadMvsData(JSON.stringify(state), "mvsj", {
            keepCamera: hasLoadedOnceRef.current && !moveCamera,
          });
        } finally {
          inFlightRef.current -= 1;
          if (inFlightRef.current === 0) setBusy(false);
        }
        hasLoadedOnceRef.current = true;
        onLoaded?.();
      })
      .catch((err) => {
        console.error("[molstar] failed to load scene", err);
        onError?.(err.message || String(err));
      });

    return () => {
      cancelled = true;
    };
  }

  return { status, busy, viewerRef, resetView, loadScene };
}
