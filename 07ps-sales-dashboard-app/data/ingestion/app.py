"""Flask API for the ETL microservice (the api-etl.<domain> side of the split cPanel deployment -
see docs/DEPLOYMENT*.md). Exposes the two real pipeline entry points via etl_executor.py:

  POST /etl/run          - orchestrator.run_refresh(): full Odoo-extract-transform-load refresh
  POST /etl/load-export  - load_real_export.load_export(): load one existing .xlsx export directly
  GET  /health           - DB connectivity check, no auth (for monitoring)

Local dev: `python app.py`. Production (cPanel/gunicorn): gunicorn against wsgi:app (see wsgi.py).
"""
from __future__ import annotations

import hmac
import logging
import sys
from functools import wraps
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from flask import Flask, jsonify, request

import etl_executor
from api_config import Config

app = Flask(__name__)
app.config.from_object(Config)

logging.basicConfig(
    level=getattr(logging, app.config["LOG_LEVEL"], logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("etl_api")


def require_api_key(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        expected = app.config.get("ETL_API_KEY")
        if not expected:
            logger.error("ETL_API_KEY is not configured on the server")
            return jsonify({"error": "Server misconfiguration: ETL_API_KEY not set"}), 500

        auth_header = request.headers.get("Authorization", "")
        token = auth_header[len("Bearer "):] if auth_header.startswith("Bearer ") else None
        if not token or not hmac.compare_digest(token, expected):
            logger.warning("Rejected request with invalid/missing API key from %s", request.remote_addr)
            return jsonify({"error": "Unauthorized"}), 401
        return view(*args, **kwargs)

    return wrapped


@app.route("/health", methods=["GET"])
def health():
    db_ok = etl_executor.check_db_connection()
    body = {
        "status": "ok" if db_ok else "degraded",
        "service": "etl-api",
        "database": "connected" if db_ok else "disconnected",
    }
    return jsonify(body), (200 if db_ok else 503)


@app.route("/etl/run", methods=["POST"])
@require_api_key
def etl_run():
    try:
        result = etl_executor.run_full_refresh()
        return jsonify({"status": "success", **result}), 200
    except Exception as exc:
        logger.exception("Full ETL refresh failed")
        return jsonify({"status": "error", "error": str(exc)}), 500


@app.route("/etl/load-export", methods=["POST"])
@require_api_key
def etl_load_export():
    payload = request.get_json(silent=True) or {}
    xlsx_path = payload.get("xlsx_path")
    if not xlsx_path:
        return jsonify({"error": "xlsx_path is required in the JSON body"}), 400

    try:
        result = etl_executor.load_export(xlsx_path)
        status = "success" if result["clean"] else "success_with_row_errors"
        return jsonify({"status": status, **result}), 200
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.exception("load-export failed")
        return jsonify({"status": "error", "error": str(exc)}), 500


@app.errorhandler(404)
def not_found(_error):
    return jsonify({"error": "Endpoint not found", "path": request.path}), 404


if __name__ == "__main__":
    # Local testing only - cPanel runs this via gunicorn/WSGI (see wsgi.py).
    app.run(host="0.0.0.0", port=app.config["PORT"], debug=False)
