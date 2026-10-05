"""Department-agnostic ETL framework (docs/ETL.md).

Named ``etl_platform`` rather than ``platform``: a top-level ``platform`` package would shadow the standard
library module of that name, which pandas, SQLAlchemy and pymysql all import.

Layers (one MySQL database, separated by table prefix):
  raw_<source>_<entity>   source records as extracted        incremental upsert by source id
  dim_* / map_*           conformed dimensions (core/)       upsert on natural key, never drop/recreate
  fact_<dept>_* ...       department marts (departments/)    atomic swap, or snapshot delete+insert
  v_<dept>_*              serving views                      migrations
  etl_*                   run/task log, watermarks, DQ       migrations
"""
