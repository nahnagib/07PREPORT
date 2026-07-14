"""WSGI entry point for gunicorn (cPanel Python app).

cPanel Setup Python App: application startup file = wsgi.py, application entry point = app.
Manual run: gunicorn -w 2 -b 0.0.0.0:5000 wsgi:app
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from app import app  # noqa: E402

if __name__ == "__main__":
    app.run()
