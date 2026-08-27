import os

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STORAGE_DIR = os.path.join(BASE_DIR, "storage")
JOBS_DIR = os.path.join(STORAGE_DIR, "jobs")

# Max upload size: 64 MB. PDB files are text and rarely bigger than a few MB,
# this is just a generous safety cap.
MAX_CONTENT_LENGTH = 64 * 1024 * 1024

ALLOWED_EXTENSIONS = {".pdb", ".ent", ".cif"}

# Number of worker threads pulling jobs off the queue. Keep at 1 so jobs
# process strictly in submission order (simpler to reason about / debug).
# Bump this up if you want real parallelism once the backend does real work.
NUM_WORKERS = 1
