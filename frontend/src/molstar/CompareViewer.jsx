import { forwardRef, useImperativeHandle, useRef, useEffect } from "react";
import { buildCompareState } from "./buildCompareScene";
import { useMolstarViewer } from "./useMolstarViewer";
import ViewerShell from "./ViewerShell";

/**
 * Mol* viewer for compare mode: two jobs' structures in one scene, optionally
 * superposed by the RMSD alignment the backend computed.
 *
 * Sibling of MolstarViewer -- they share viewer lifecycle and scene-pushing
 * through useMolstarViewer, and differ only in what they draw (see
 * buildCompareScene.js).
 */
const CompareViewer = forwardRef(function CompareViewer(
  { comparison, align, visibleIds, showA, showB, baseStyle, spin, focusId, onFocusApplied, onError },
  ref
) {
  const containerRef = useRef(null);
  const { status, resetView, loadScene } = useMolstarViewer({ containerRef, spin, onError });

  useImperativeHandle(ref, () => ({ resetView }));

  useEffect(
    () =>
      loadScene(
        (lib) =>
          comparison &&
          buildCompareState(lib, { comparison, align, visibleIds, showA, showB, baseStyle, focusId }),
        { onLoaded: () => focusId && onFocusApplied?.() }
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [status, comparison, align, visibleIds, showA, showB, baseStyle, focusId]
  );

  return <ViewerShell containerRef={containerRef} status={status} />;
});

export default CompareViewer;
