"""Conformed dimensions shared by every department (dim_*, map_*).

Keys are deterministic (Odoo ids, frozen Excel codes, yyyymmdd) and every dimension has a -1 Unknown member.
Tables are owned by migrations and loaded by upsert only -- never dropped or recreated. Jobs are defined in
``core/jobs.py`` (added in phase 2).
"""
