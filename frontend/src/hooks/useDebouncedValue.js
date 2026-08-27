import { useEffect, useState } from "react";

/**
 * Returns `value`, but delayed until it's stopped changing for `delayMs`.
 * Used to decouple fast-changing UI (a slider's live position/label) from
 * an expensive downstream effect (e.g. Mol* reloading a whole scene) that
 * shouldn't re-run on every intermediate tick.
 */
export function useDebouncedValue(value, delayMs) {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
