"""WSGI entry point for gunicorn (cPanel Python app).

cPanel Setup Python App: application startup file = wsgi.py, application entry point = app.
Manual run: gunicorn -w 1 -b 0.0.0.0:5001 wsgi:app
(-w 1: this process tracks job state in-memory - see job_tracker.py - so exactly one worker.)
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from app import app  # noqa: E402

if __name__ == "__main__":
    app.run()
