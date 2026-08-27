import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { loadMolstar } from "./loadMolstar";
import { buildMvsState, FIELD_PREVIEW_VOLUME_REF } from "./buildScene";
import { useMolstarViewer } from "./useMolstarViewer";
import ViewerShell from "./ViewerShell";

/**
 * Thin React wrapper around the Mol* viewer, for a single job's results.
 *
 * Viewer lifecycle (create/dispose/spin) and scene-pushing are shared with
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
    selectedField,
    selectedFieldPocketId,
    fieldIsovalue,
    spin,
    focusPocketId,
    onFocusApplied,
    onError,
  },
  ref
) {
  const containerRef = useRef(null);
  const { status, viewerRef, resetView, loadScene } = useMolstarViewer({
    containerRef,
    spin,
    onError,
  });

  // Read by the scene effect below without being one of its dependencies, so
  // a slider-driven fieldIsovalue change never triggers a full rebuild --
  // only the initial isosurface, built once when the field preview first
  // turns on, needs a value at all; every value after that is patched live by
  // the effect further down.
  const fieldIsovalueRef = useRef(fieldIsovalue);
  useEffect(() => {
    fieldIsovalueRef.current = fieldIsovalue;
  }, [fieldIsovalue]);

  useImperativeHandle(ref, () => ({ resetView }));

  // Push a freshly-built scene whenever the relevant inputs change. Note
  // fieldIsovalue is deliberately not a dependency here -- once the field
  // preview's isosurface node exists, changing its threshold is handled by
  // the lightweight effect below instead of a full rebuild/reload (which
  // would re-run the whole MVS diff plus re-serialize/re-parse the entire
  // scene, structure+pockets included, on every slider tick).
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
            selectedField,
            selectedFieldPocketId,
            fieldIsovalue: fieldIsovalueRef.current,
            focusPocketId,
          }),
        { onLoaded: () => focusPocketId && onFocusApplied?.() }
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
      selectedField,
      selectedFieldPocketId,
      focusPocketId,
    ]
  );

  // Live isovalue updates: patch just the field-preview isosurface's
  // threshold on the state cell mol* already built (via its public
  // queryMVSRef/IsoValue helpers), instead of rebuilding the scene. No-ops
  // quietly if the node doesn't exist yet -- the scene effect above is what
  // creates it (with this same fieldIsovalue, via the ref) whenever
  // selectedField/selectedFieldPocketId first turn the preview on.
  useEffect(() => {
    if (status !== "ready" || !viewerRef.current) return;
    if (!selectedField || !selectedFieldPocketId) return;

    let cancelled = false;

    loadMolstar().then((molstar) => {
      if (cancelled) return;
      try {
        const plugin = viewerRef.current.plugin;
        const cells = molstar.lib.extensions.mvs.util.queryMVSRef(plugin, FIELD_PREVIEW_VOLUME_REF);
        const cell = cells?.[0];
        if (!cell) return;
        const isoValue = molstar.lib.volume.Volume.IsoValue.absolute(fieldIsovalue);
        const params = { ...cell.transform.params };
        params.type = { ...params.type, params: { ...params.type.params, isoValue } };
        plugin.build().to(cell.transform.ref).update(params).commit();
      } catch (err) {
        console.error("[molstar] live isovalue update failed", err);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [status, viewerRef, fieldIsovalue, selectedField, selectedFieldPocketId]);

  return <ViewerShell containerRef={containerRef} status={status} />;
});

export default MolstarViewer;
