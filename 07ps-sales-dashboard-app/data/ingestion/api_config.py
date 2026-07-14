"""Configuration for the ETL Flask API (app.py/wsgi.py). Loads .env for local dev via
python-dotenv; on cPanel the Python app sets real environment variables directly and this file's
load_dotenv() call is a no-op (no .env file present there).

Named api_config.py rather than config.py to avoid colliding with the vendored pipeline's own
config_src/ package (see orchestrator.py's sys.path/sys.modules setup) if anything ever imports
this alongside it.
"""
from __future__ import annotations

import os

from dotenv import load_dotenv

load_dotenv()


class Config:
    ETL_API_KEY = os.environ.get("ETL_API_KEY", "")
    LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()
    PORT = int(os.environ.get("PORT", "5000"))
