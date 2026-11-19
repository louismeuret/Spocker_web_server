"""
Dev entry point: `python run.py`.

"""
import os

from app import create_app

if __name__ == "__main__":
    debug = os.environ.get("FLASK_DEBUG", "1") == "1"
    app = create_app(debug=debug)
    port = int(os.environ.get("PORT", "5001"))
    app.run(host="127.0.0.1", port=port, debug=debug, use_reloader=debug)
