import { useEffect, useRef, useState } from "react";
import { loadMolstar } from "./loadMolstar";

/**
 * Mol* viewer lifecycle, shared by MolstarViewer (one job) and CompareViewer
 * (two superposed jobs).
 *
 * The boring, identical-either-way parts live here: create the viewer once
 * into a container, tear it down on unmount, expose a ready/error status,
 * handle the spin toggle, and push a built scene. What each viewer actually
 * *draws* stays in its own component -- that's the part that differs, and
 * each keeps its own effect so its dependency list stays explicit.
 *
 * Every Mol*-facing call is wrapped in try/catch and logged -- Mol*'s API is
 * large and this is the part of the app most likely to need debugging against
 * a specific installed bundle version.
 */
export function useMolstarViewer({ containerRef, spin, onError }) {
  const viewerRef = useRef(null);
  // Lets each caller's scene effect ask for "keep the camera where the user
  // left it" on every load but the first one.
  const hasLoadedOnceRef = useRef(false);
  const [status, setStatus] = useState("loading"); // loading | ready | error

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

  useEffect(() => {
    if (status !== "ready" || !viewerRef.current) return;
    try {
      viewerRef.current.plugin.canvas3d?.setProps({
        trackball: {
          animate: spin ? { name: "spin", params: { speed: 1 } } : { name: "off", params: {} },
        },
      });
    } catch (err) {
      console.error("[molstar] spin toggle failed", err);
    }
  }, [status, spin]);

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
   * The camera is kept where the user left it on every load but the first.
   */
  function loadScene(buildState, { onLoaded } = {}) {
    if (status !== "ready" || !viewerRef.current) return undefined;

    let cancelled = false;
    loadMolstar()
      .then(async (molstar) => {
        const state = buildState(molstar.lib);
        if (cancelled || !state) return;
        await viewerRef.current.loadMvsData(JSON.stringify(state), "mvsj", {
          keepCameraOrientation: hasLoadedOnceRef.current,
        });
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

  return { status, viewerRef, resetView, loadScene };
}
