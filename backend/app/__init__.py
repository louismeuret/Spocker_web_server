import os

from flask import Flask, send_from_directory
from flask_cors import CORS

from . import config, worker

FRONTEND_DIST = os.path.normpath(os.path.join(config.BASE_DIR, "..", "frontend", "dist"))


def create_app(debug=False):
    app = Flask(__name__)
    app.config["MAX_CONTENT_LENGTH"] = config.MAX_CONTENT_LENGTH
    app.debug = debug

    # Dev convenience: the Vite dev server runs on a different port, so it
    # needs CORS. In production the frontend build is served by this same
    # Flask app (below), so CORS doesn't even come into play there.
    CORS(app, resources={r"/api/*": {"origins": "*"}})

    os.makedirs(config.JOBS_DIR, exist_ok=True)

    from .routes import api

    app.register_blueprint(api)

    # If a frontend build exists (frontend/npm run build), serve it from
    # this same Flask process so the whole app is a single command/port in
    # production. In dev, run the Vite dev server separately instead (see
    # README) -- there's no dist/ yet, so this block is simply skipped.
    if os.path.isdir(FRONTEND_DIST):
        @app.route("/", defaults={"path": ""})
        @app.route("/<path:path>")
        def serve_frontend(path):
            candidate = os.path.join(FRONTEND_DIST, path)
            if path and os.path.isfile(candidate):
                return send_from_directory(FRONTEND_DIST, path)
            return send_from_directory(FRONTEND_DIST, "index.html")

    # Avoid starting two sets of worker threads when Flask's debug reloader
    # spawns a second process -- only the child that actually serves
    # requests (WERKZEUG_RUN_MAIN=true) should own the queue. When not in
    # debug/reloader mode this env var is simply unset, so start normally.
    if not app.debug or os.environ.get("WERKZEUG_RUN_MAIN") == "true":
        worker.start_workers()
        worker.requeue_unfinished_jobs_on_startup()

    return app
