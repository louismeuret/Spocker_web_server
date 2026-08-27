/**
 * Thin wrapper around the backend HTTP API. Every function here maps to
 * exactly one endpoint in backend/app/routes.py -- keep it that way, it's
 * the easiest place to look when something isn't working.
 *
 * Same-origin `/api/...` paths everywhere: the Vite dev server proxies
 * them to Flask (see vite.config.js), and in production Flask serves the
 * built frontend itself, so there's never a cross-origin call to configure.
 */

const id = encodeURIComponent;

async function request(path, options) {
  const response = await fetch(path, options);
  let body = null;
  try {
    body = await response.json();
  } catch {
    // no JSON body (e.g. plain 500 from a proxy) -- fall through
  }
  if (!response.ok) {
    throw new Error(body?.error || `Request failed with status ${response.status}`);
  }
  return body;
}

export function createJob({ file, pdbCode, model } = {}) {
  const formData = new FormData();
  if (pdbCode) formData.append("pdb_code", pdbCode);
  else formData.append("file", file);
  if (model != null) formData.append("model", String(model));
  return request("/api/jobs", { method: "POST", body: formData });
}

export function getJob(jobId) {
  return request(`/api/jobs/${id(jobId)}`);
}

export function getJobResult(jobId) {
  return request(`/api/jobs/${id(jobId)}/result`);
}

/**
 * Superposition + pocket-by-pocket diff of two finished jobs (see
 * backend/app/compare.py). The response carries the rigid transform taking
 * `jobIdB` onto `jobIdA`, which buildCompareScene.js hands straight to Mol*.
 */
export function compareJobs(jobIdA, jobIdB) {
  return request(`/api/compare/${id(jobIdA)}/${id(jobIdB)}`);
}

export function listExamples() {
  return request("/api/examples");
}

export function structureUrl(jobId) {
  return `/api/jobs/${id(jobId)}/structure`;
}

export function pocketVolumeUrl(jobId, pocketId) {
  return `/api/jobs/${id(jobId)}/pockets/${id(pocketId)}/volume`;
}

export function pocketFieldVolumeUrl(jobId, pocketId, fieldName) {
  return `/api/jobs/${id(jobId)}/pockets/${id(pocketId)}/fields/${id(fieldName)}/volume`;
}

export function downloadJobUrl(jobId) {
  return `/api/jobs/${id(jobId)}/download`;
}
