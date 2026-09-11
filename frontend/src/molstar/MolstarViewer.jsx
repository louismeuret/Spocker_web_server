import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { loadMolstar } from "./loadMolstar";
import { buildMvsState, fieldPreviewRef } from "./buildScene";
import { useMolstarViewer } from "./useMolstarViewer";
import ViewerShell from "./ViewerShell";

/**
 * Thin React wrapper around the Mol* viewer, for a single job's results.
 *
 * Viewer lifecycle (create/dispose/busy) and scene-pushing are shared with
 * CompareViewer via useMolstarViewer; "what does the scene look like" lives
 * in buildScene.js. This component is just the glue.
 */
const MolstarViewer = forwardRef(function MolstarViewer(
  {
    structureUrl,
    format,
    jobId,
    pockets,
    visiblePocketIds,
    visibleResiduePocketIds,
    baseStyle,
    showPocketVolumes,
    fieldSelections,
    focusPocketId,
    onFocusApplied,
    onError,
  },
  ref
) {
  const containerRef = useRef(null);
  const { status, busy, viewerRef, resetView, loadScene } = useMolstarViewer({
    containerRef,
    onError,
  });

  // Which previews exist, ignoring their isovalues. Adding or removing one
  // needs a scene rebuild; moving a slider does not (see the second effect).
  const selectionKey = (fieldSelections ?? []).map((s) => `${s.pocketId}:${s.field}`).join(",");
  // ...and the isovalues on their own, so the patch effect below re-runs
  // exactly when one of them moves.
  const isovalueKey = (fieldSelections ?? []).map((s) => s.isovalue).join(",");

  // Read by the scene effect without being one of its dependencies, so a
  // slider-driven isovalue change never triggers a full rebuild -- only the
  // isosurfaces built when a preview first turns on need a value at all;
  // every value after that is patched live by the effect further down.
  const selectionsRef = useRef(fieldSelections);
  useEffect(() => {
    selectionsRef.current = fieldSelections;
  }, [fieldSelections]);

  useImperativeHandle(ref, () => ({ resetView }));

  // Push a freshly-built scene whenever the relevant inputs change. Note the
  // isovalues are deliberately not dependencies here -- once a preview's
  // isosurface node exists, changing its threshold is handled by the
  // lightweight effect below instead of a full rebuild/reload (which would
  // re-run the whole MVS diff plus re-serialize/re-parse the entire scene,
  // structure+pockets included, on every slider tick).
  useEffect(
    () =>
      loadScene(
        (lib) =>
          structureUrl &&
          pockets &&
          buildMvsState(lib, {
            structureUrl,
            format,
            jobId,
            pockets,
            visiblePocketIds,
            visibleResiduePocketIds,
            baseStyle,
            showPocketVolumes,
            fieldSelections: selectionsRef.current,
            focusPocketId,
          }),
        {
          // Only a Focus click may move the camera; every other rebuild
          // leaves the user's view exactly where it was.
          moveCamera: !!focusPocketId,
          onLoaded: () => focusPocketId && onFocusApplied?.(),
        }
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      status,
      structureUrl,
      format,
      jobId,
      pockets,
      visiblePocketIds,
      visibleResiduePocketIds,
      baseStyle,
      showPocketVolumes,
      selectionKey,
      focusPocketId,
    ]
  );

  // Live isovalue updates: patch just the field previews' thresholds on the
  // state cells mol* already built (via its public queryMVSRef/IsoValue
  // helpers), instead of rebuilding the scene. No-ops quietly for a node
  // that doesn't exist yet -- the scene effect above is what creates it
  // (with these same isovalues, via the ref).
  //
  // Only one commit is ever in flight: a slider fires far faster than mol*
  // can re-triangulate a volume, and letting every tick queue its own commit
  // builds a backlog the user then has to wait out after letting go. Ticks
  // that arrive mid-commit are dropped in favour of the newest one, which is
  // the only one whose result anybody wants to see.
  const commitRef = useRef({ running: false, pending: null });
  useEffect(() => {
    if (status !== "ready" || !viewerRef.current) return;
    if (!fieldSelections?.length) return;

    commitRef.current.pending = fieldSelections;
    if (commitRef.current.running) return;
    commitRef.current.running = true;

    // No cleanup/cancel flag here on purpose: this loop outlives the effect
    // run that started it (that's the whole point -- later ticks hand it
    // work through `pending`), and a cleanup cancelling it would kill the
    // loop just as the next tick arrived. Unmount disposes the viewer, which
    // the `plugin` check below sees.
    loadMolstar()
      .then(async (molstar) => {
        while (commitRef.current.pending) {
          const selections = commitRef.current.pending;
          commitRef.current.pending = null;

          const plugin = viewerRef.current?.plugin;
          if (!plugin) return;
          const update = plugin.build();
          let touched = false;

          for (const { pocketId, field, isovalue } of selections) {
            const cells = molstar.lib.extensions.mvs.util.queryMVSRef(
              plugin,
              fieldPreviewRef(pocketId, field)
            );
            const cell = cells?.[0];
            if (!cell) continue;
            const params = { ...cell.transform.params };
            params.type = {
              ...params.type,
              params: {
                ...params.type.params,
                isoValue: molstar.lib.volume.Volume.IsoValue.absolute(isovalue),
              },
            };
            update.to(cell.transform.ref).update(params);
            touched = true;
          }

          if (touched) await update.commit();
        }
      })
      .catch((err) => console.error("[molstar] live isovalue update failed", err))
      .finally(() => {
        commitRef.current.running = false;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, viewerRef, selectionKey, isovalueKey]);

  return <ViewerShell containerRef={containerRef} status={status} busy={busy} />;
});

export default MolstarViewer;
