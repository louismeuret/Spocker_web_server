"""
Dev entry point: `python run.py`.

For production, serve the built frontend from Flask too (see
serve_frontend.py) or run behind gunicorn -- but for a single-node demo
server, Flask's own server is fine.
"""
import os

from app import create_app

if __name__ == "__main__":
    debug = os.environ.get("FLASK_DEBUG", "1") == "1"
    app = create_app(debug=debug)
    port = int(os.environ.get("PORT", "5001"))
    app.run(host="0.0.0.0", port=port, debug=debug, use_reloader=debug)
