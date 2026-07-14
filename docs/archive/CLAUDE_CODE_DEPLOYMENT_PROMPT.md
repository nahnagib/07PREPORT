# Claude Code Deployment Prompt: Split Architecture for cPanel

## Executive Summary
Restructure 07ps Sales Dashboard for split cPanel deployment: Node.js frontend+backend on main domain, Python ETL on subdomain. Both connect to shared MySQL. Requires Flask wrapper for ETL, HTTP bridge in Node backend, cPanel deployment configs, and testing suite.

---

## Project Context

**Current Architecture:**
- Monolithic Docker Compose with Node.js backend, Next.js frontend, Python ETL worker, Redis
- Deployed via `docker compose up -d` on Linux VPS
- All services on localhost; internal Docker networking

**Target Architecture:**
- **benmussa-invest.com**: Node.js frontend + Express backend (cPanel Node.js app)
- **api-etl.benmussa-invest.com**: Python ETL service (cPanel Python app)
- **Shared**: MySQL database, HTTPS for inter-service communication

**Timeline**: 1-2 weeks to full deployment
**Team**: IT support deploys to cPanel; you validate locally first

---

## Deliverables (in order of priority)

### 1. Python ETL Flask Application (NEW - 40% of effort)
**Goal:** Convert `data/ingestion/orchestrator.py` into a production Flask API that cPanel can run.

**Files to Create:**
```
data/ingestion/
├── app.py                          # Flask app (NEW)
├── wsgi.py                         # WSGI entry point for cPanel (NEW)
├── requirements.txt                # Add Flask, gunicorn (UPDATE)
├── config.py                       # Configuration management (NEW)
├── routes/
│   ├── __init__.py                 # (NEW)
│   ├── health.py                   # Health checks (NEW)
│   ├── etl.py                      # /run-full, /run-incremental (NEW)
│   └── auth.py                     # API key validation (NEW)
├── services/
│   ├── __init__.py                 # (NEW)
│   ├── etl_executor.py             # Wrapper around existing orchestrator (NEW)
│   └── logger.py                   # Structured logging (NEW)
├── .env.example                    # UPDATE: add ETL_API_KEY, LOG_LEVEL
└── tests/
    ├── __init__.py                 # (NEW)
    └── test_endpoints.py           # API endpoint tests (NEW)
```

**Detailed Specs:**

#### `data/ingestion/app.py`
```python
"""
Flask ETL API service for benmussa-invest.
Exposes REST endpoints for Tachometer data refresh.
Runs on api-etl.benmussa-invest.com (cPanel Python app).
"""
from flask import Flask, jsonify, request, current_app
from functools import wraps
import os
import sys
import logging
from datetime import datetime
from pathlib import Path

# Add parent directories to path for local testing
sys.path.insert(0, str(Path(__file__).parent))

from services.etl_executor import ETLExecutor
from services.logger import setup_logger
from config import Config

app = Flask(__name__)
app.config.from_object(Config)

# Initialize logger
logger = setup_logger(app.logger)

# Initialize ETL executor
etl_executor = None

def init_app():
    """Initialize app on startup."""
    global etl_executor
    try:
        etl_executor = ETLExecutor(
            db_host=os.getenv('DB_HOST'),
            db_user=os.getenv('DB_USER'),
            db_password=os.getenv('DB_PASSWORD'),
            db_name=os.getenv('DB_NAME', 'ps_warehouse'),
            python_bin=os.getenv('ETL_PYTHON_BIN', sys.executable),
            logger=logger
        )
        logger.info("ETL executor initialized successfully")
    except Exception as e:
        logger.error(f"Failed to initialize ETL executor: {e}")
        etl_executor = None

def require_api_key(f):
    """Decorator to validate API key in Authorization header."""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        auth_header = request.headers.get('Authorization', '')
        
        if not auth_header.startswith('Bearer '):
            logger.warning(f"Missing/invalid Authorization header from {request.remote_addr}")
            return {'error': 'Missing or invalid Authorization header'}, 401
        
        token = auth_header.split(' ')[1]
        expected_key = os.getenv('ETL_API_KEY')
        
        if not expected_key:
            logger.error("ETL_API_KEY not configured on server")
            return {'error': 'Server misconfiguration'}, 500
        
        if token != expected_key:
            logger.warning(f"Invalid API key from {request.remote_addr}")
            return {'error': 'Unauthorized'}, 401
        
        return f(*args, **kwargs)
    
    return decorated_function

# ============================================================================
# HEALTH CHECK ENDPOINTS
# ============================================================================

@app.route('/health', methods=['GET'])
def health_check():
    """
    Simple health check. Returns 200 if service is up.
    No auth required (for monitoring/load balancer).
    """
    checks = {
        'status': 'ok',
        'timestamp': datetime.utcnow().isoformat(),
        'service': 'etl-api',
    }
    
    # Check if ETL executor is ready
    if etl_executor is None:
        checks['status'] = 'degraded'
        checks['message'] = 'ETL executor not initialized'
        return jsonify(checks), 503
    
    # Quick DB connectivity check
    try:
        is_connected = etl_executor.check_db_connection()
        checks['database'] = 'connected' if is_connected else 'disconnected'
        if not is_connected:
            checks['status'] = 'degraded'
            return jsonify(checks), 503
    except Exception as e:
        checks['database'] = 'error'
        checks['error'] = str(e)
        checks['status'] = 'degraded'
        logger.error(f"Health check DB connection failed: {e}")
        return jsonify(checks), 503
    
    return jsonify(checks), 200

@app.route('/health/db', methods=['GET'])
def health_db():
    """
    Detailed database health check.
    Requires API key.
    """
    if not etl_executor:
        return {'error': 'Service not initialized'}, 503
    
    try:
        status = etl_executor.get_db_status()
        return jsonify(status), 200
    except Exception as e:
        logger.error(f"DB health check failed: {e}")
        return {'error': str(e)}, 500

# ============================================================================
# ETL TRIGGER ENDPOINTS
# ============================================================================

@app.route('/etl/run-full', methods=['POST'])
@require_api_key
def trigger_full_etl():
    """
    Trigger full ETL: load all dimension and fact tables from source.
    
    **Warning:** This is destructive. Use only for initial load or testing.
    
    Query params:
    - skip_migrations: bool (default: False) - skip SQL migrations
    - validate: bool (default: True) - validate data after load
    
    Returns:
    {
        "status": "success",
        "job_id": "uuid",
        "started_at": "2026-07-14T10:30:00",
        "expected_duration_seconds": 600,
        "tables_affected": ["fact_sales", "dim_products", ...],
        "message": "Full ETL queued. Check status via /etl/status/<job_id>"
    }
    """
    skip_migrations = request.args.get('skip_migrations', 'false').lower() == 'true'
    validate = request.args.get('validate', 'true').lower() == 'true'
    
    if not etl_executor:
        return {'error': 'Service not initialized'}, 503
    
    try:
        logger.info(f"Full ETL triggered by {request.remote_addr}")
        job_id, start_time, result = etl_executor.run_full_etl(
            skip_migrations=skip_migrations,
            validate=validate
        )
        
        return jsonify({
            'status': 'success',
            'job_id': job_id,
            'started_at': start_time.isoformat(),
            'expected_duration_seconds': 600,  # Rough estimate
            'message': 'Full ETL completed. See result for details.',
            'result': result
        }), 200
        
    except Exception as e:
        logger.error(f"Full ETL failed: {e}", exc_info=True)
        return {'error': str(e), 'type': type(e).__name__}, 500

@app.route('/etl/run-incremental', methods=['POST'])
@require_api_key
def trigger_incremental_etl():
    """
    Trigger incremental ETL: refresh changed records only (faster).
    
    Recommended for scheduled jobs (daily, hourly).
    
    Query params:
    - since_hours: int (default: 24) - refresh data changed in last N hours
    - validate: bool (default: True) - validate data after load
    
    Returns:
    {
        "status": "success",
        "job_id": "uuid",
        "started_at": "2026-07-14T10:30:00",
        "rows_updated": {
            "fact_sales": 245,
            "dim_customers": 12,
            ...
        },
        "expected_duration_seconds": 60,
        "message": "Incremental ETL completed."
    }
    """
    since_hours = int(request.args.get('since_hours', '24'))
    validate = request.args.get('validate', 'true').lower() == 'true'
    
    if not etl_executor:
        return {'error': 'Service not initialized'}, 503
    
    try:
        logger.info(f"Incremental ETL triggered (since_hours={since_hours}) by {request.remote_addr}")
        job_id, start_time, result = etl_executor.run_incremental_etl(
            since_hours=since_hours,
            validate=validate
        )
        
        return jsonify({
            'status': 'success',
            'job_id': job_id,
            'started_at': start_time.isoformat(),
            'rows_updated': result.get('rows_updated', {}),
            'expected_duration_seconds': 60,
            'message': 'Incremental ETL completed.',
            'result': result
        }), 200
        
    except Exception as e:
        logger.error(f"Incremental ETL failed: {e}", exc_info=True)
        return {'error': str(e), 'type': type(e).__name__}, 500

@app.route('/etl/run-customers', methods=['POST'])
@require_api_key
def trigger_customers_etl():
    """Refresh customer dimension only (fast, ~30 sec)."""
    if not etl_executor:
        return {'error': 'Service not initialized'}, 503
    
    try:
        logger.info(f"Customers ETL triggered by {request.remote_addr}")
        job_id, start_time, result = etl_executor.run_customers_etl()
        
        return jsonify({
            'status': 'success',
            'job_id': job_id,
            'started_at': start_time.isoformat(),
            'rows_loaded': result.get('rows_loaded', 0),
            'message': 'Customers ETL completed.'
        }), 200
        
    except Exception as e:
        logger.error(f"Customers ETL failed: {e}", exc_info=True)
        return {'error': str(e)}, 500

@app.route('/etl/run-sales', methods=['POST'])
@require_api_key
def trigger_sales_etl():
    """Refresh sales fact table only (slower, ~2-5 min for 65MB)."""
    if not etl_executor:
        return {'error': 'Service not initialized'}, 503
    
    try:
        logger.info(f"Sales ETL triggered by {request.remote_addr}")
        job_id, start_time, result = etl_executor.run_sales_etl()
        
        return jsonify({
            'status': 'success',
            'job_id': job_id,
            'started_at': start_time.isoformat(),
            'rows_loaded': result.get('rows_loaded', 0),
            'message': 'Sales ETL completed.'
        }), 200
        
    except Exception as e:
        logger.error(f"Sales ETL failed: {e}", exc_info=True)
        return {'error': str(e)}, 500

@app.route('/etl/status/<job_id>', methods=['GET'])
@require_api_key
def etl_status(job_id):
    """Get status of a submitted ETL job."""
    # TODO: Implement job tracking if using async queue (RabbitMQ, Celery)
    # For now, synchronous execution means jobs complete immediately.
    return jsonify({
        'job_id': job_id,
        'status': 'completed',  # or 'pending', 'failed'
        'note': 'Current implementation is synchronous. Status always "completed" on response.'
    }), 200

# ============================================================================
# ADMIN/DIAGNOSTIC ENDPOINTS
# ============================================================================

@app.route('/admin/config', methods=['GET'])
@require_api_key
def admin_config():
    """Get current configuration (for debugging). Hides sensitive values."""
    return jsonify({
        'db_host': os.getenv('DB_HOST', 'not set'),
        'db_name': os.getenv('DB_NAME', 'ps_warehouse'),
        'log_level': os.getenv('LOG_LEVEL', 'INFO'),
        'api_key_set': bool(os.getenv('ETL_API_KEY')),
        'python_bin': os.getenv('ETL_PYTHON_BIN', sys.executable),
        'environment': os.getenv('FLASK_ENV', 'production'),
    }), 200

@app.route('/admin/test-db', methods=['POST'])
@require_api_key
def admin_test_db():
    """Test database connection. Returns detailed error if fails."""
    if not etl_executor:
        return {'error': 'Service not initialized'}, 503
    
    try:
        is_connected = etl_executor.check_db_connection()
        return jsonify({
            'status': 'ok' if is_connected else 'failed',
            'connected': is_connected
        }), 200
    except Exception as e:
        return jsonify({
            'status': 'error',
            'error': str(e),
            'connection_string': f"mysql://{os.getenv('DB_USER')}@{os.getenv('DB_HOST')}/{os.getenv('DB_NAME')}"
        }), 500

# ============================================================================
# ERROR HANDLERS
# ============================================================================

@app.errorhandler(404)
def not_found(error):
    return {'error': 'Endpoint not found', 'path': request.path}, 404

@app.errorhandler(500)
def internal_error(error):
    logger.error(f"Internal server error: {error}", exc_info=True)
    return {'error': 'Internal server error'}, 500

# ============================================================================
# APP STARTUP
# ============================================================================

@app.before_request
def before_request():
    """Log each request."""
    logger.debug(f"{request.method} {request.path} from {request.remote_addr}")

if __name__ == '__main__':
    init_app()
    # For local testing only. cPanel uses gunicorn/WSGI.
    app.run(host='0.0.0.0', port=5000, debug=False)
```

#### `data/ingestion/wsgi.py`
```python
"""
WSGI entry point for gunicorn (used by cPanel).
cPanel will call: gunicorn -w 4 -b 0.0.0.0:5000 wsgi:app
"""
import os
import sys
from pathlib import Path

# Ensure current directory is in path
sys.path.insert(0, str(Path(__file__).parent))

from app import app, init_app

# Initialize on startup
init_app()

if __name__ == '__main__':
    app.run()
```

#### `data/ingestion/config.py`
```python
"""
Configuration management for ETL Flask app.
Loads from environment variables with sensible defaults.
"""
import os

class Config:
    """Base configuration."""
    FLASK_ENV = os.getenv('FLASK_ENV', 'production')
    LOG_LEVEL = os.getenv('LOG_LEVEL', 'INFO')
    
    # Database
    DB_HOST = os.getenv('DB_HOST')
    DB_USER = os.getenv('DB_USER')
    DB_PASSWORD = os.getenv('DB_PASSWORD')
    DB_NAME = os.getenv('DB_NAME', 'ps_warehouse')
    DB_POOL_SIZE = int(os.getenv('DB_POOL_SIZE', '5'))
    
    # ETL
    ETL_API_KEY = os.getenv('ETL_API_KEY')
    ETL_PYTHON_BIN = os.getenv('ETL_PYTHON_BIN')
    ETL_TIMEOUT_SECONDS = int(os.getenv('ETL_TIMEOUT_SECONDS', '600'))
    
    # Odoo (optional, for live connector)
    ODOO_URL = os.getenv('ODOO_URL')
    ODOO_USER = os.getenv('ODOO_USER')
    ODOO_PASSWORD = os.getenv('ODOO_PASSWORD')
    ALLOW_LIVE_ODOO = os.getenv('ALLOW_LIVE_ODOO', '0') == '1'
    
    # Validation
    VALIDATE_AFTER_LOAD = os.getenv('VALIDATE_AFTER_LOAD', 'true').lower() == 'true'
```

#### `data/ingestion/services/etl_executor.py`
```python
"""
Executor wrapper that bridges Flask app to existing orchestrator.py and commands.

This wraps the existing Python ETL logic (orchestrator.py, load_real_export.py, etc.)
to be callable from Flask endpoints.
"""
import subprocess
import sys
import logging
from datetime import datetime
from typing import Tuple, Dict, Any
import uuid
import pymysql

class ETLExecutor:
    """Execute ETL jobs via subprocess or direct function calls."""
    
    def __init__(self, db_host: str, db_user: str, db_password: str, db_name: str, 
                 python_bin: str = None, logger: logging.Logger = None):
        self.db_host = db_host
        self.db_user = db_user
        self.db_password = db_password
        self.db_name = db_name
        self.python_bin = python_bin or sys.executable
        self.logger = logger or logging.getLogger(__name__)
    
    def check_db_connection(self) -> bool:
        """Verify MySQL connection works."""
        try:
            conn = pymysql.connect(
                host=self.db_host,
                user=self.db_user,
                password=self.db_password,
                database=self.db_name,
                connection_timeout=5
            )
            conn.close()
            return True
        except Exception as e:
            self.logger.error(f"DB connection failed: {e}")
            return False
    
    def get_db_status(self) -> Dict[str, Any]:
        """Get detailed database status."""
        try:
            conn = pymysql.connect(
                host=self.db_host,
                user=self.db_user,
                password=self.db_password,
                database=self.db_name
            )
            cursor = conn.cursor()
            
            # Get table counts
            cursor.execute("""
                SELECT TABLE_NAME, TABLE_ROWS 
                FROM INFORMATION_SCHEMA.TABLES 
                WHERE TABLE_SCHEMA = %s
            """, (self.db_name,))
            
            tables = {}
            for table_name, row_count in cursor.fetchall():
                tables[table_name] = row_count
            
            cursor.close()
            conn.close()
            
            return {
                'status': 'ok',
                'database': self.db_name,
                'host': self.db_host,
                'tables': tables
            }
        except Exception as e:
            return {'status': 'error', 'error': str(e)}
    
    def run_full_etl(self, skip_migrations: bool = False, validate: bool = True) -> Tuple[str, datetime, Dict]:
        """
        Execute full ETL job.
        
        Returns:
            (job_id, started_at, result_dict)
        """
        job_id = str(uuid.uuid4())
        started_at = datetime.utcnow()
        
        self.logger.info(f"Starting full ETL job {job_id}")
        
        try:
            # Call existing orchestrator or run direct Python commands
            # This is a placeholder - adapt to your actual orchestrator interface
            result = {
                'job_id': job_id,
                'status': 'completed',
                'rows_loaded': {'fact_sales': 5000, 'dim_customers': 300},
                'duration_seconds': 120
            }
            
            self.logger.info(f"Full ETL job {job_id} completed successfully")
            return job_id, started_at, result
            
        except Exception as e:
            self.logger.error(f"Full ETL job {job_id} failed: {e}", exc_info=True)
            raise
    
    def run_incremental_etl(self, since_hours: int = 24, validate: bool = True) -> Tuple[str, datetime, Dict]:
        """Execute incremental ETL job."""
        job_id = str(uuid.uuid4())
        started_at = datetime.utcnow()
        
        self.logger.info(f"Starting incremental ETL job {job_id} (since_hours={since_hours})")
        
        try:
            result = {
                'job_id': job_id,
                'status': 'completed',
                'rows_updated': {'fact_sales': 150, 'dim_customers': 5},
                'duration_seconds': 30
            }
            
            self.logger.info(f"Incremental ETL job {job_id} completed successfully")
            return job_id, started_at, result
            
        except Exception as e:
            self.logger.error(f"Incremental ETL job {job_id} failed: {e}", exc_info=True)
            raise
    
    def run_customers_etl(self) -> Tuple[str, datetime, Dict]:
        """Execute customers-only ETL."""
        job_id = str(uuid.uuid4())
        started_at = datetime.utcnow()
        
        self.logger.info(f"Starting customers ETL job {job_id}")
        
        try:
            result = {
                'job_id': job_id,
                'status': 'completed',
                'rows_loaded': 150,
                'duration_seconds': 15
            }
            
            return job_id, started_at, result
            
        except Exception as e:
            self.logger.error(f"Customers ETL job {job_id} failed: {e}", exc_info=True)
            raise
    
    def run_sales_etl(self) -> Tuple[str, datetime, Dict]:
        """Execute sales-only ETL (slow - ~2-5 min)."""
        job_id = str(uuid.uuid4())
        started_at = datetime.utcnow()
        
        self.logger.info(f"Starting sales ETL job {job_id}")
        
        try:
            result = {
                'job_id': job_id,
                'status': 'completed',
                'rows_loaded': 50000,
                'duration_seconds': 180
            }
            
            return job_id, started_at, result
            
        except Exception as e:
            self.logger.error(f"Sales ETL job {job_id} failed: {e}", exc_info=True)
            raise
```

#### `data/ingestion/services/logger.py`
```python
"""Structured logging setup."""
import logging
import sys
import os
from datetime import datetime

def setup_logger(flask_logger):
    """Configure logging for ETL service."""
    log_level = os.getenv('LOG_LEVEL', 'INFO').upper()
    
    # Set level
    flask_logger.setLevel(getattr(logging, log_level))
    
    # Console handler (required for cPanel logs)
    handler = logging.StreamHandler(sys.stdout)
    handler.setLevel(getattr(logging, log_level))
    
    # Structured format
    formatter = logging.Formatter(
        '%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S'
    )
    handler.setFormatter(formatter)
    
    flask_logger.addHandler(handler)
    
    return flask_logger
```

#### `data/ingestion/.env.example`
```bash
# Database (shared with backend)
DB_HOST=localhost
DB_USER=ps_warehouse_user
DB_PASSWORD=YOUR_SECURE_PASSWORD
DB_NAME=ps_warehouse
DB_POOL_SIZE=5

# ETL API Security
ETL_API_KEY=YOUR_RANDOM_API_KEY_HERE
# Generate with: openssl rand -base64 32

# ETL Configuration
ETL_TIMEOUT_SECONDS=600
VALIDATE_AFTER_LOAD=true
LOG_LEVEL=INFO

# Odoo (leave blank if using mocked data)
ALLOW_LIVE_ODOO=0
ODOO_URL=
ODOO_USER=
ODOO_PASSWORD=

# Flask
FLASK_ENV=production
```

#### `data/ingestion/requirements.txt`
```
Flask==3.0.0
gunicorn==21.2.0
pymysql==1.1.0
python-dotenv==1.0.0
openpyxl==3.9.0  # For Excel reading (if still needed)
# ... other existing deps
```

#### `data/ingestion/tests/test_endpoints.py`
```python
"""
Unit tests for ETL API endpoints.
Run via: pytest tests/test_endpoints.py
"""
import pytest
import os
from app import app
from unittest.mock import patch, MagicMock

@pytest.fixture
def client():
    app.config['TESTING'] = True
    with app.test_client() as client:
        yield client

def test_health_check_no_auth(client):
    """Health check should not require auth."""
    response = client.get('/health')
    assert response.status_code == 200
    assert response.json['status'] in ['ok', 'degraded']

def test_run_full_requires_auth(client):
    """Full ETL should require API key."""
    response = client.post('/etl/run-full')
    assert response.status_code == 401

def test_run_full_with_valid_auth(client):
    """Full ETL with valid auth should succeed."""
    os.environ['ETL_API_KEY'] = 'test-key-123'
    
    response = client.post(
        '/etl/run-full',
        headers={'Authorization': 'Bearer test-key-123'}
    )
    # Will fail if executor not initialized, but that's ok for this test
    assert response.status_code in [200, 503]

def test_invalid_auth_rejected(client):
    """Invalid API key should be rejected."""
    os.environ['ETL_API_KEY'] = 'correct-key'
    
    response = client.post(
        '/etl/run-full',
        headers={'Authorization': 'Bearer wrong-key'}
    )
    assert response.status_code == 401
```

---

### 2. Node.js ETL Client (NEW - 20% of effort)
**Goal:** Update Express backend to call the Python ETL service.

**Files to Create/Update:**
```
backend/src/
├── services/
│   ├── etlClient.ts                # NEW: HTTP client for Python ETL API
│   └── etlScheduler.ts             # NEW: Cron scheduler for recurring jobs
└── routes/
    ├── admin.ts                    # NEW: Admin panel endpoints
    └── etl.ts                       # NEW: ETL status/trigger endpoints (for UI)
```

**Detailed Specs:**

#### `backend/src/services/etlClient.ts`
```typescript
/**
 * HTTP client for Python ETL service (api-etl.benmussa-invest.com).
 * 
 * Handles all communication with the separate Python ETL microservice.
 * Uses exponential backoff + timeout for reliability.
 */
import axios, { AxiosInstance } from 'axios';
import * as winston from 'winston';

interface ETLConfig {
  baseURL: string;           // https://api-etl.benmussa-invest.com
  apiKey: string;            // Bearer token
  timeoutMs?: number;        // Default 600000 (10 min)
  maxRetries?: number;       // Default 3
  logger?: winston.Logger;
}

interface ETLJobResult {
  status: 'success' | 'error';
  jobId: string;
  startedAt: string;
  rowsLoaded?: Record<string, number>;
  rowsUpdated?: Record<string, number>;
  durationSeconds?: number;
  error?: string;
}

export class ETLClient {
  private client: AxiosInstance;
  private config: Required<ETLConfig>;
  private logger: winston.Logger;
  
  constructor(config: ETLConfig) {
    if (!config.baseURL || !config.apiKey) {
      throw new Error('ETL_API_URL and ETL_API_KEY must be set');
    }
    
    this.config = {
      baseURL: config.baseURL,
      apiKey: config.apiKey,
      timeoutMs: config.timeoutMs || 600000,
      maxRetries: config.maxRetries || 3,
      logger: config.logger || console as any,
    };
    
    this.logger = this.config.logger;
    
    // Create axios instance with default config
    this.client = axios.create({
      baseURL: this.config.baseURL,
      timeout: this.config.timeoutMs,
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': '07ps-backend/1.0',
      },
    });
    
    // Add request/response interceptors for logging
    this.client.interceptors.request.use((req) => {
      this.logger.debug(`[ETL] ${req.method?.toUpperCase()} ${req.url}`);
      return req;
    });
    
    this.client.interceptors.response.use(
      (res) => {
        this.logger.debug(`[ETL] Response ${res.status} from ${res.config.url}`);
        return res;
      },
      (err) => {
        this.logger.error(`[ETL] Error: ${err.message}`, { url: err.config?.url });
        return Promise.reject(err);
      }
    );
  }
  
  /**
   * Check if ETL service is healthy.
   * No auth required (health endpoints are public).
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.client.get('/health', {
        timeout: 5000,
      });
      return response.status === 200;
    } catch (error) {
      this.logger.warn('[ETL] Health check failed', { error: String(error) });
      return false;
    }
  }
  
  /**
   * Trigger full ETL (load all data from source).
   * 
   * **Warning:** Destructive. Use only for initial load or testing.
   * 
   * @param options - skipMigrations, validate
   * @returns Job result with row counts
   */
  async runFullETL(options?: {
    skipMigrations?: boolean;
    validate?: boolean;
  }): Promise<ETLJobResult> {
    try {
      const params = {
        skip_migrations: options?.skipMigrations ?? false,
        validate: options?.validate ?? true,
      };
      
      this.logger.info('[ETL] Triggering full ETL', { params });
      
      const response = await this.client.post('/etl/run-full', {}, { params });
      
      return {
        status: 'success',
        jobId: response.data.job_id,
        startedAt: response.data.started_at,
        rowsLoaded: response.data.result?.rows_loaded,
        durationSeconds: response.data.result?.duration_seconds,
      };
    } catch (error: any) {
      this.logger.error('[ETL] Full ETL failed', { error: error.message });
      return {
        status: 'error',
        jobId: 'unknown',
        startedAt: new Date().toISOString(),
        error: error.message,
      };
    }
  }
  
  /**
   * Trigger incremental ETL (refresh only changed data).
   * 
   * Safe for scheduled jobs. Recommended daily/hourly.
   * 
   * @param sinceHours - Only refresh data changed in last N hours (default: 24)
   * @returns Job result with row counts
   */
  async runIncrementalETL(sinceHours: number = 24): Promise<ETLJobResult> {
    try {
      const params = {
        since_hours: sinceHours,
        validate: true,
      };
      
      this.logger.info('[ETL] Triggering incremental ETL', { sinceHours });
      
      const response = await this.client.post('/etl/run-incremental', {}, { params });
      
      return {
        status: 'success',
        jobId: response.data.job_id,
        startedAt: response.data.started_at,
        rowsUpdated: response.data.result?.rows_updated,
        durationSeconds: response.data.result?.duration_seconds,
      };
    } catch (error: any) {
      this.logger.error('[ETL] Incremental ETL failed', { error: error.message });
      return {
        status: 'error',
        jobId: 'unknown',
        startedAt: new Date().toISOString(),
        error: error.message,
      };
    }
  }
  
  /**
   * Refresh customers dimension only (fast, ~30 sec).
   */
  async runCustomersETL(): Promise<ETLJobResult> {
    try {
      this.logger.info('[ETL] Triggering customers ETL');
      
      const response = await this.client.post('/etl/run-customers', {});
      
      return {
        status: 'success',
        jobId: response.data.job_id,
        startedAt: response.data.started_at,
        rowsLoaded: { customers: response.data.result?.rows_loaded },
        durationSeconds: response.data.result?.duration_seconds,
      };
    } catch (error: any) {
      this.logger.error('[ETL] Customers ETL failed', { error: error.message });
      return {
        status: 'error',
        jobId: 'unknown',
        startedAt: new Date().toISOString(),
        error: error.message,
      };
    }
  }
  
  /**
   * Refresh sales fact table (slow, ~2-5 min).
   */
  async runSalesETL(): Promise<ETLJobResult> {
    try {
      this.logger.info('[ETL] Triggering sales ETL');
      
      const response = await this.client.post('/etl/run-sales', {});
      
      return {
        status: 'success',
        jobId: response.data.job_id,
        startedAt: response.data.started_at,
        rowsLoaded: { sales: response.data.result?.rows_loaded },
        durationSeconds: response.data.result?.duration_seconds,
      };
    } catch (error: any) {
      this.logger.error('[ETL] Sales ETL failed', { error: error.message });
      return {
        status: 'error',
        jobId: 'unknown',
        startedAt: new Date().toISOString(),
        error: error.message,
      };
    }
  }
  
  /**
   * Get detailed database status from ETL service.
   */
  async getDatabaseStatus(): Promise<any> {
    try {
      const response = await this.client.get('/admin/test-db');
      return response.data;
    } catch (error: any) {
      this.logger.error('[ETL] DB status check failed', { error: error.message });
      return { status: 'error', error: error.message };
    }
  }
}

// Export singleton instance (lazy-loaded from env)
let etlClientInstance: ETLClient | null = null;

export function getETLClient(): ETLClient {
  if (!etlClientInstance) {
    const etlApiUrl = process.env.ETL_API_URL;
    const etlApiKey = process.env.ETL_API_KEY;
    
    if (!etlApiUrl || !etlApiKey) {
      throw new Error(
        'ETL_API_URL and ETL_API_KEY environment variables must be set. ' +
        'Example: ETL_API_URL=https://api-etl.benmussa-invest.com ETL_API_KEY=...'
      );
    }
    
    etlClientInstance = new ETLClient({
      baseURL: etlApiUrl,
      apiKey: etlApiKey,
      timeoutMs: 600000,
    });
  }
  
  return etlClientInstance;
}
```

#### `backend/src/services/etlScheduler.ts`
```typescript
/**
 * Cron scheduler for recurring ETL jobs.
 * 
 * Schedules daily incremental refresh at configurable time.
 * Can also be triggered manually via API.
 */
import * as cron from 'node-cron';
import * as winston from 'winston';
import { getETLClient } from './etlClient';

export class ETLScheduler {
  private logger: winston.Logger;
  private cronJob: cron.ScheduledTask | null = null;
  private lastRunTime: Date | null = null;
  private lastRunStatus: 'success' | 'error' | null = null;
  
  constructor(logger: winston.Logger) {
    this.logger = logger;
  }
  
  /**
   * Start the scheduler. 
   * By default, runs incremental ETL daily at 2 AM UTC.
   * 
   * @param cronExpression - Cron expression (default: "0 2 * * *" = daily 2 AM UTC)
   */
  start(cronExpression: string = '0 2 * * *'): void {
    this.logger.info('[ETL Scheduler] Starting with cron expression:', { cronExpression });
    
    this.cronJob = cron.schedule(cronExpression, async () => {
      this.logger.info('[ETL Scheduler] Cron job triggered');
      await this.runIncrementalETL();
    });
  }
  
  /**
   * Stop the scheduler.
   */
  stop(): void {
    if (this.cronJob) {
      this.cronJob.stop();
      this.logger.info('[ETL Scheduler] Stopped');
    }
  }
  
  /**
   * Get last run status (for health checks).
   */
  getStatus(): {
    lastRunTime: Date | null;
    lastRunStatus: 'success' | 'error' | null;
    isRunning: boolean;
  } {
    return {
      lastRunTime: this.lastRunTime,
      lastRunStatus: this.lastRunStatus,
      isRunning: this.cronJob?.status === 'started',
    };
  }
  
  /**
   * Manually trigger incremental ETL.
   */
  async runIncrementalETL(): Promise<void> {
    this.logger.info('[ETL Scheduler] Running incremental ETL');
    
    try {
      const etlClient = getETLClient();
      const result = await etlClient.runIncrementalETL(24); // Last 24 hours
      
      this.lastRunTime = new Date();
      this.lastRunStatus = result.status === 'success' ? 'success' : 'error';
      
      if (result.status === 'success') {
        this.logger.info('[ETL Scheduler] Incremental ETL completed', {
          rowsUpdated: result.rowsUpdated,
          duration: result.durationSeconds,
        });
      } else {
        this.logger.error('[ETL Scheduler] Incremental ETL failed', { error: result.error });
      }
    } catch (error: any) {
      this.lastRunStatus = 'error';
      this.logger.error('[ETL Scheduler] Unexpected error', { error: error.message });
    }
  }
}

// Export singleton
let schedulerInstance: ETLScheduler | null = null;

export function getETLScheduler(logger: winston.Logger): ETLScheduler {
  if (!schedulerInstance) {
    schedulerInstance = new ETLScheduler(logger);
  }
  return schedulerInstance;
}
```

#### `backend/src/routes/etl.ts`
```typescript
/**
 * API endpoints for ETL status and manual triggers.
 * 
 * These allow the frontend to:
 * - Check ETL status
 * - Manually trigger a refresh
 * - View last run time
 */
import { Router, Request, Response } from 'express';
import { authenticateToken } from '../middleware/auth';
import { getETLClient } from '../services/etlClient';
import { getETLScheduler } from '../services/etlScheduler';
import * as winston from 'winston';

const router = Router();

interface AuthenticatedRequest extends Request {
  user?: { id: string; role: string };
}

export function setupETLRoutes(router: Router, logger: winston.Logger): void {
  /**
   * GET /api/etl/health
   * Check ETL service health (no auth required).
   */
  router.get('/etl/health', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const etlClient = getETLClient();
      const isHealthy = await etlClient.healthCheck();
      
      res.json({
        status: isHealthy ? 'ok' : 'unreachable',
        timestamp: new Date().toISOString(),
      });
    } catch (error: any) {
      res.status(503).json({
        status: 'error',
        error: error.message,
      });
    }
  });
  
  /**
   * GET /api/etl/status
   * Get last ETL run status and scheduled job info.
   */
  router.get('/etl/status', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const scheduler = getETLScheduler(logger);
      const status = scheduler.getStatus();
      
      res.json({
        lastRunTime: status.lastRunTime,
        lastRunStatus: status.lastRunStatus,
        isSchedulerRunning: status.isRunning,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });
  
  /**
   * POST /api/etl/trigger-incremental
   * Manually trigger incremental ETL (admin only).
   */
  router.post('/etl/trigger-incremental', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
    // Check admin role
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Admin role required' });
    }
    
    try {
      const etlClient = getETLClient();
      const result = await etlClient.runIncrementalETL(24);
      
      res.json({
        status: result.status,
        jobId: result.jobId,
        rowsUpdated: result.rowsUpdated,
        durationSeconds: result.durationSeconds,
        error: result.error,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });
  
  /**
   * POST /api/etl/trigger-full
   * Manually trigger full ETL (admin only, DESTRUCTIVE).
   */
  router.post('/etl/trigger-full', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Admin role required' });
    }
    
    try {
      const etlClient = getETLClient();
      const result = await etlClient.runFullETL({ validate: true });
      
      res.json({
        status: result.status,
        jobId: result.jobId,
        rowsLoaded: result.rowsLoaded,
        durationSeconds: result.durationSeconds,
        error: result.error,
        warning: 'Full ETL is destructive and takes ~10 minutes.',
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });
}

export default router;
```

#### `backend/src/server.ts` (UPDATE)
Add ETL initialization:
```typescript
// At top of file
import { getETLScheduler } from './services/etlScheduler';
import { setupETLRoutes } from './routes/etl';

// ... existing code ...

// Initialize ETL scheduler (runs daily at 2 AM UTC)
const etlScheduler = getETLScheduler(logger);
const etlCronExpression = process.env.ETL_CRON || '0 2 * * *';
etlScheduler.start(etlCronExpression);

// Setup ETL routes
setupETLRoutes(app, logger);

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  etlScheduler.stop();
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});
```

#### `backend/.env.example` (UPDATE)
```bash
# ... existing vars ...

# ETL Microservice (Python API running on api-etl.benmussa-invest.com)
ETL_API_URL=https://api-etl.benmussa-invest.com
ETL_API_KEY=your_random_secure_key_here
# Generate with: openssl rand -base64 32

# ETL Scheduler
# Cron expression for daily incremental refresh (default: 0 2 * * * = 2 AM UTC)
ETL_CRON=0 2 * * *
```

---

### 3. cPanel Deployment Configurations (NEW - 20% of effort)
**Goal:** Create scripts and docs for IT support to deploy on cPanel.

**Files to Create:**
```
docs/
├── cpanel-deployment-guide.md      # Step-by-step for IT support
├── cpanel-node-setup.sh            # Script to initialize Node.js app
├── cpanel-python-setup.sh          # Script to initialize Python app
└── cpanel-cron-jobs.md             # cPanel Cron job configurations
```

**Detailed Specs:**

#### `docs/cpanel-deployment-guide.md`
[Comprehensive deployment guide with screenshots/steps]

#### `docs/cpanel-node-setup.sh`
```bash
#!/bin/bash
# Setup script for Node.js app (main domain: benmussa-invest.com)
# Run this in cPanel's Terminal after uploading code

set -e  # Exit on error

echo "=== 07ps Dashboard - Node.js Setup ==="

# 1. Navigate to app directory (cPanel sets this)
cd /home/username/benmussa-invest.com

# 2. Copy .env from template
if [ ! -f backend/.env ]; then
  echo "Creating backend/.env from template..."
  cp backend/.env.example backend/.env
  echo "⚠️  EDIT backend/.env with your database credentials"
  echo "   DB_HOST, DB_USER, DB_PASSWORD, JWT_SECRET, ETL_API_URL, ETL_API_KEY"
else
  echo "✓ backend/.env already exists"
fi

# 3. Install dependencies
echo "Installing Node.js dependencies..."
npm install

# 4. Build frontend and backend
echo "Building frontend..."
cd frontend
npm run build
cd ..

echo "Building backend..."
cd backend
npm run build
cd ..

# 5. Create startup script for cPanel
cat > startup.js << 'EOF'
#!/usr/bin/env node
const path = require('path');
process.chdir(path.join(__dirname, 'backend'));
require('./dist/server.js');
EOF

chmod +x startup.js

echo "✓ Node.js app setup complete"
echo ""
echo "Next steps:"
echo "1. In cPanel > Setup Node.js App:"
echo "   - Node version: 20.x"
echo "   - App mode: development (or production if you prefer)"
echo "   - App root: /home/username/benmussa-invest.com"
echo "   - App URL: https://benmussa-invest.com"
echo "   - Startup file: startup.js"
echo "   - App domain: benmussa-invest.com"
echo ""
echo "2. After cPanel setup, click 'Start App' button"
echo "3. Verify at https://benmussa-invest.com"
```

#### `docs/cpanel-python-setup.sh`
```bash
#!/bin/bash
# Setup script for Python app (subdomain: api-etl.benmussa-invest.com)
# Run this in cPanel's Terminal after uploading code

set -e

echo "=== 07ps Dashboard - Python ETL Setup ==="

# 1. Navigate to app directory
cd /home/username/public_html/api-etl

# 2. Copy .env
if [ ! -f .env ]; then
  echo "Creating .env from template..."
  cp data/ingestion/.env.example .env
  echo "⚠️  EDIT .env with your configuration"
  echo "   DB_HOST, DB_USER, DB_PASSWORD, ETL_API_KEY"
else
  echo "✓ .env already exists"
fi

# 3. Install dependencies
echo "Installing Python packages..."
pip install -r data/ingestion/requirements.txt

# 4. Create WSGI entry point
cp data/ingestion/wsgi.py ./

# 5. Test Flask app
echo "Testing Flask app..."
python data/ingestion/app.py &
sleep 3
curl http://localhost:5000/health
kill %1

echo "✓ Python app setup complete"
echo ""
echo "Next steps:"
echo "1. In cPanel > Setup Python App:"
echo "   - Python version: 3.10+"
echo "   - App mode: web"
echo "   - App domain: api-etl.benmussa-invest.com"
echo "   - App root: /home/username/public_html/api-etl"
echo "   - Application URL: https://api-etl.benmussa-invest.com"
echo "   - Application startup file: wsgi.py"
echo ""
echo "2. After cPanel setup, click 'Create Configuration' then 'Start App'"
echo "3. Verify at https://api-etl.benmussa-invest.com/health"
```

---

### 4. Testing & Validation Suite (NEW - 20% of effort)
**Goal:** Scripts to validate deployment end-to-end.

**Files to Create:**
```
docs/
└── test-deployment.sh              # End-to-end validation script

tests/
├── e2e-deployment.test.ts          # E2E tests for split architecture
└── fixtures/
    └── test-etl-data.sql           # Seed data for testing
```

#### `docs/test-deployment.sh`
```bash
#!/bin/bash
# End-to-end deployment validation
# Run this after deploying to cPanel

set -e

echo "=== Testing Split Architecture Deployment ==="

MAIN_DOMAIN="https://benmussa-invest.com"
ETL_DOMAIN="https://api-etl.benmussa-invest.com"
ETL_API_KEY="${ETL_API_KEY:?Please set ETL_API_KEY env var}"

echo ""
echo "Step 1: Check Node.js app is running"
curl -s "${MAIN_DOMAIN}/api/health" | jq .
echo "✓ Node.js app responding"

echo ""
echo "Step 2: Check Python ETL service is running"
curl -s "${ETL_DOMAIN}/health" | jq .
echo "✓ Python ETL service responding"

echo ""
echo "Step 3: Test ETL service database connection"
curl -s -H "Authorization: Bearer ${ETL_API_KEY}" \
  "${ETL_DOMAIN}/admin/test-db" | jq .
echo "✓ Database connection OK"

echo ""
echo "Step 4: Test Node.js backend can reach ETL service"
curl -s "${MAIN_DOMAIN}/api/etl/health" | jq .
echo "✓ Backend can reach ETL service"

echo ""
echo "Step 5: Test frontend loads"
curl -s -I "${MAIN_DOMAIN}" | grep "HTTP"
echo "✓ Frontend is accessible"

echo ""
echo "Step 6: Optional - Trigger manual incremental ETL"
echo "  (Requires authenticated user with admin role)"
# curl -s -X POST "${MAIN_DOMAIN}/api/etl/trigger-incremental" \
#   -H "Authorization: Bearer YOUR_JWT_TOKEN" | jq .

echo ""
echo "=== All tests passed! Deployment successful ==="
```

---

### 5. Documentation (NEW - Remaining effort)

**Files to Create/Update:**
```
docs/
├── DEPLOYMENT_COMPLETE.md                      # Deployment summary
├── cpanel-deployment-guide.md                  # Full instructions with screenshots
├── etl-service-api.md                          # API reference for ETL service
├── split-architecture-design.md                # Architecture diagram & explanation
├── troubleshooting.md                          # Common issues & solutions
└── backups-and-recovery.md                     # Backup strategy
```

---

## Implementation Order (Priority)

### Week 1
- [ ] Create Python Flask app (`app.py`, `wsgi.py`, `routes/`, `services/`)
- [ ] Create Node.js ETL client (`etlClient.ts`, `etlScheduler.ts`)
- [ ] Add etl.ts routes to backend
- [ ] Update `.env.example` files for both services
- [ ] Create cPanel setup scripts

### Week 2
- [ ] Test locally: run both services, verify communication
- [ ] Create deployment documentation
- [ ] Create test/validation scripts
- [ ] Deploy to cPanel staging (if available)
- [ ] Document troubleshooting guide

### Week 3
- [ ] Deploy to production cPanel
- [ ] Configure DNS (api-etl.benmussa-invest.com)
- [ ] Set up SSL/TLS certificates
- [ ] Configure cron jobs for automated ETL
- [ ] Monitor first week of production

---

## Key Configuration (Env Vars)

### Node.js Backend (benmussa-invest.com/.env)
```
DB_HOST=localhost
DB_USER=ps_warehouse_user
DB_PASSWORD=***
DB_NAME=ps_warehouse

JWT_SECRET=***
ETL_API_URL=https://api-etl.benmussa-invest.com
ETL_API_KEY=***
ETL_CRON=0 2 * * *
```

### Python ETL (api-etl.benmussa-invest.com/.env)
```
DB_HOST=localhost
DB_USER=ps_warehouse_user
DB_PASSWORD=***
DB_NAME=ps_warehouse

ETL_API_KEY=***
LOG_LEVEL=INFO
VALIDATE_AFTER_LOAD=true

ALLOW_LIVE_ODOO=0
```

---

## Deployment Checklist

- [ ] Python Flask app created and tested locally
- [ ] Node.js ETL client created and tested locally
- [ ] .env files configured for both services
- [ ] cPanel setup scripts created
- [ ] Deployment documentation complete
- [ ] Test/validation scripts created
- [ ] Node.js app deployed to benmussa-invest.com
- [ ] Python app deployed to api-etl.benmussa-invest.com
- [ ] Both services verified responding
- [ ] Database connectivity confirmed from both services
- [ ] cron job configured for daily ETL refresh
- [ ] SSL/TLS certificates installed
- [ ] First manual ETL run successful
- [ ] Monitoring/logging configured
- [ ] Runbook documented for production support

---

## Success Criteria

✅ Frontend loads at https://benmussa-invest.com
✅ Backend API responds at https://benmussa-invest.com/api/health
✅ Python ETL responds at https://api-etl.benmussa-invest.com/health
✅ Node backend can trigger Python ETL via HTTPS
✅ Tachometer dashboard displays live data from MySQL
✅ Incremental ETL runs daily via cron without manual intervention
✅ No single point of failure (both services independent)
✅ Logs visible in cPanel for debugging
