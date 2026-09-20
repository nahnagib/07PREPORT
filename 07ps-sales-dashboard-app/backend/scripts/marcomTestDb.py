"""Throwaway MySQL 8 for the DB-backed MARCOM tests -- NEVER your real database.

    python backend/scripts/marcomTestDb.py up      # start docker container, apply schema
    python backend/scripts/marcomTestDb.py reset   # drop + recreate the container
    python backend/scripts/marcomTestDb.py down    # remove the container
    npm run test:marcom-db --workspace backend

Container `marcom-test-mysql` on 127.0.0.1:33307, root/testroot, database `marcom_test`
(lower_case_table_names=1 to match the Windows MySQL the repo's SQL was written against).

Schema: migrations 0001-0017 + 0022 + 0023. Migration 0018 currently fails on a fresh database
(pre-existing, unrelated) and 0009's `CREATE TABLE IF NOT EXISTS app_user` is a no-op when the old
0006 table exists, so the missing auth columns are added here -- for the test DB only.
"""
import glob
import os
import subprocess
import sys
import time

import pymysql
from pymysql.constants import CLIENT

NAME, PORT, PWD, DB = "marcom-test-mysql", 33307, "testroot", "marcom_test"
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
MIG = os.path.join(ROOT, "data", "warehouse", "migrations")

APP_USER_PATCH = """ALTER TABLE app_user
 ADD COLUMN password_hash VARCHAR(255) NOT NULL DEFAULT '',
 ADD COLUMN status ENUM('ACTIVE','INACTIVE','LOCKED','PENDING_PASSWORD_CHANGE') NOT NULL DEFAULT 'PENDING_PASSWORD_CHANGE',
 ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT TRUE,
 ADD COLUMN last_login_at TIMESTAMP NULL,
 ADD COLUMN updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 ADD COLUMN failed_login_count INT NOT NULL DEFAULT 0,
 ADD COLUMN password_changed_at TIMESTAMP NULL,
 ADD COLUMN password_reset_token_hash VARCHAR(255) NULL,
 ADD COLUMN password_reset_expires_at TIMESTAMP NULL,
 ADD COLUMN sessions_revoked_at TIMESTAMP NULL,
 ADD COLUMN role_id INT NULL, ADD FOREIGN KEY (role_id) REFERENCES roles(role_id)"""


def sh(*a, check=True):
    return subprocess.run(a, check=check, capture_output=True, text=True)


def connect(db=None, tries=60):
    for _ in range(tries):
        try:
            return pymysql.connect(host="127.0.0.1", port=PORT, user="root", password=PWD, database=db,
                                   client_flag=CLIENT.MULTI_STATEMENTS, autocommit=True, connect_timeout=3)
        except Exception:
            time.sleep(2)
    raise SystemExit("MySQL did not come up")


def run_sql(conn, path):
    with conn.cursor() as cur:
        cur.execute(open(path, encoding="utf-8").read())
        while cur.nextset():
            pass


def up():
    if NAME not in sh("docker", "ps", "-a", "--format", "{{.Names}}").stdout.split():
        sh("docker", "run", "-d", "--name", NAME, "-e", f"MYSQL_ROOT_PASSWORD={PWD}", "-e", f"MYSQL_DATABASE={DB}",
           "-p", f"{PORT}:3306", "mysql:8.0", "--lower_case_table_names=1", "--max_allowed_packet=64M")
    else:
        sh("docker", "start", NAME, check=False)
    time.sleep(5)
    conn = connect(DB)
    with conn.cursor() as cur:
        cur.execute("SHOW TABLES LIKE 'marcom_upload_batch'")
        if cur.fetchone():
            print("schema already present")
            return
    for path in sorted(glob.glob(os.path.join(MIG, "00*.sql"))):
        name = os.path.basename(path)
        if name >= "0018" and name < "0022":
            continue  # see module docstring
        if name.startswith("0022"):
            with conn.cursor() as cur:
                cur.execute(APP_USER_PATCH)
        run_sql(conn, path)
        print("applied", name)
    print("ready: 127.0.0.1:%d / %s" % (PORT, DB))


def down():
    sh("docker", "rm", "-f", NAME, check=False)
    print("removed", NAME)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "up"
    if cmd == "reset":
        down(); up()
    elif cmd == "down":
        down()
    else:
        up()
