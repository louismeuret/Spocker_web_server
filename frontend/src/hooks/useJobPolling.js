import { useEffect, useState } from "react";
import { getJob } from "../api";

const POLL_INTERVAL_MS = 800;

/**
 * Polls GET /api/jobs/:id while the job is queued/running, stops as soon
 * as it reaches a terminal state (done/error) or the request 404s.
 * Plain setTimeout loop (not setInterval) so a slow response can't cause
 * overlapping requests to pile up.
 */
export function useJobPolling(jobId) {
  const [meta, setMeta] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    let timer = null;
    setMeta(null);
    setNotFound(false);
    setError(null);

    async function poll() {
      try {
        const data = await getJob(jobId);
        if (cancelled) return;
        setMeta(data);
        if (data.status === "queued" || data.status === "running") {
          timer = setTimeout(poll, POLL_INTERVAL_MS);
        }
      } catch (err) {
        if (cancelled) return;
        if (String(err.message).includes("not found")) {
          setNotFound(true);
        } else {
          setError(err.message || "Failed to fetch job status");
          // Keep trying -- likely a transient network hiccup, not fatal.
          timer = setTimeout(poll, POLL_INTERVAL_MS * 2);
        }
      }
    }

    poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [jobId]);

  return { meta, notFound, error };
}
