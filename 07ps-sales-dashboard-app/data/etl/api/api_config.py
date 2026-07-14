"""Configuration for the ETL Flask API (data/etl/api/app.py/wsgi.py) - the api-etl.<domain> side
of the split cPanel deployment. Named api_config.py, not config.py, to avoid any confusion with
the vendored pipeline's own data/etl/config/settings.py (a different package, imported only by the
subprocess this API spawns - never by this Flask process itself).
"""
from __future__ import annotations

import os
import sys

from dotenv import load_dotenv

load_dotenv()


class Config:
    ETL_API_KEY = os.environ.get("ETL_API_KEY", "")
    LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()
    PORT = int(os.environ.get("PORT", "5001"))
    # Bare "python"/"python3" is resolved via PATH; a path containing a separator (e.g. a venv
    # interpreter) is used as-is - same convention backend/src/etl/config/etlConfig.ts used for
    # ETL_PYTHON_BIN before this Flask API took over spawning the subprocess.
    PYTHON_BIN = os.environ.get("PYTHON_BIN") or sys.executable
