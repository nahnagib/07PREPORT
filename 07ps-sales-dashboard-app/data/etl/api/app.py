"""Flask API wrapping the REAL production ETL pipeline (data/etl/src/sales_pipeline/main.py) for
the split cPanel deployment. Node's backend/src/etl/services/pythonRunner.ts calls this over HTTP
instead of spawning the subprocess itself directly - everything above pythonRunner.ts
(runPipelineJob.ts, BullMQ, admin/etlControl.ts, the frontend etl-runs page) is unchanged.

Endpoints:
  POST /etl/run                    - start a run, 202 {jobId} (409 if one is already active)
  GET  /etl/jobs/<job_id>          - poll status + new log lines (?after=<count> for incremental
                                      fetch, matching how pythonRunner.ts's polling loop tracks
                                      how many lines it has already consumed)
  POST /etl/jobs/<job_id>/cancel   - terminate the running subprocess
  POST /etl/reset                  - admin override: clear a stuck "active job" slot on this
                                      tracker (terminates the tracked subprocess if still alive)
  GET  /health                     - unauthenticated

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

from api_config import Config
from job_tracker import tracker

app = Flask(__name__)
app.config.from_object(Config)

logging.basicConfig(
    level=getattr(logging, app.config["LOG_LEVEL"], logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("etl_api")

VALID_LOAD_MODES = {"full", "incremental"}
VALID_OUTPUT_MODES = {"sql", "excel", "both"}


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
    active = tracker.active_job()
    return jsonify({
        "status": "ok",
        "service": "etl-api",
        "activeJob": {"jobId": active.job_id, "status": active.status} if active else None,
    }), 200


@app.route("/etl/run", methods=["POST"])
@require_api_key
def etl_run():
    payload = request.get_json(silent=True) or {}
    load_mode = payload.get("loadMode")
    output_mode = payload.get("outputMode", "sql")
    fast = bool(payload.get("fast", False))
    extra_args = payload.get("extraArgs") or []
    label = payload.get("label")

    if load_mode not in VALID_LOAD_MODES:
        return jsonify({"error": f"loadMode must be one of {sorted(VALID_LOAD_MODES)}"}), 400
    if output_mode not in VALID_OUTPUT_MODES:
        return jsonify({"error": f"outputMode must be one of {sorted(VALID_OUTPUT_MODES)}"}), 400
    if not isinstance(extra_args, list) or not all(isinstance(a, str) for a in extra_args):
        return jsonify({"error": "extraArgs must be a list of strings"}), 400

    try:
        job = tracker.start(load_mode, output_mode, fast, extra_args, label, app.config["PYTHON_BIN"])
    except RuntimeError:
        active = tracker.active_job()
        return jsonify({
            "error": "A run is already active",
            "activeJobId": active.job_id if active else None,
        }), 409

    logger.info(
        "Started ETL job %s (loadMode=%s outputMode=%s fast=%s label=%s)",
        job.job_id, load_mode, output_mode, fast, label,
    )
    return jsonify({"jobId": job.job_id, "status": job.status}), 202


@app.route("/etl/jobs/<job_id>", methods=["GET"])
@require_api_key
def etl_job_status(job_id: str):
    job = tracker.get(job_id)
    if job is None:
        return jsonify({"error": "Job not found"}), 404
    after = request.args.get("after", default=0, type=int) or 0
    return jsonify(job.to_status_dict(after=after)), 200


@app.route("/etl/jobs/<job_id>/cancel", methods=["POST"])
@require_api_key
def etl_job_cancel(job_id: str):
    try:
        job = tracker.cancel(job_id)
    except KeyError:
        return jsonify({"error": "Job not found"}), 404
    except ValueError as exc:
        return jsonify({"error": "Job is not running", "currentStatus": str(exc)}), 409

    logger.info("Cancel requested for ETL job %s", job.job_id)
    return jsonify({"jobId": job.job_id, "status": job.status}), 200


@app.route("/etl/reset", methods=["POST"])
@require_api_key
def etl_reset():
    """Admin override for a stuck "active job" slot on THIS tracker -- called by Node's
    POST /admin/etl/force-reset alongside its own etl_job_runs/BullMQ reset (see
    backend/src/routes/admin/etlControl.ts). Node's reset has no visibility into this process's
    in-memory JobTracker, so without this endpoint a stuck tracker here would keep 409-ing every
    run Node enqueues after its own reset, with nothing in the Node-side state showing why.
    """
    job = tracker.force_reset()
    if job is None:
        return jsonify({"ok": True, "resetJobId": None, "message": "No active job to reset."}), 200
    logger.warning("Force-reset: cleared active ETL job %s (was status=%s)", job.job_id, job.status)
    return jsonify({"ok": True, "resetJobId": job.job_id}), 200


@app.errorhandler(404)
def not_found(_error):
    return jsonify({"error": "Endpoint not found", "path": request.path}), 404


if __name__ == "__main__":
    # Local testing only - cPanel runs this via gunicorn/WSGI (see wsgi.py).
    app.run(host="0.0.0.0", port=app.config["PORT"], debug=False)
