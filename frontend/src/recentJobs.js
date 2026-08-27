const KEY = "spocker.recentJobs";
const MAX_ENTRIES = 12;

export function getRecentJobs() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function addRecentJob({ id, filename }) {
  try {
    const existing = getRecentJobs().filter((j) => j.id !== id);
    const next = [{ id, filename, viewedAt: new Date().toISOString() }, ...existing].slice(0, MAX_ENTRIES);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // localStorage unavailable (private mode, quota, etc.) -- non-critical
  }
}
