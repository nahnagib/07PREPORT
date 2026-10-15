"""Execute the report's actual allocation SQL against mixed old/new payment fixtures."""
from pathlib import Path
import re
import sqlite3

from departments.finance.collections import collection_invoice_dates


def test_only_prior_invoice_portions_count_including_not_yet_due():
    source = Path(__file__).resolve().parents[3] / 'backend/src/measures/debtCollections.ts'
    match = re.search(r'const PRIOR_INVOICE_ALLOCATIONS = `(.+?)`;', source.read_text(encoding='utf-8'), re.S)
    assert match, 'The tested SQL must be the report source, not a separate copy of the rule'
    db = sqlite3.connect(':memory:')
    db.executescript("""
      CREATE TABLE fact_finance_collection (payment_id INT, allocation_no INT, payment_date TEXT);
      CREATE TABLE v_finance_collection_trend (payment_id INT, allocation_no INT, amount_doc_ccy REAL, amount_company_ccy REAL);
      CREATE TABLE fact_finance_collection_invoice (payment_id INT, allocation_no INT, move_id INT, move_type TEXT, kind TEXT, applied_doc_ccy REAL);
      CREATE TABLE dim_finance_collection_invoice_date (move_id INT PRIMARY KEY, invoice_date TEXT);
    """)
    # 1 is a mixed payment: 200 old overdue + 300 old not due + 400 same-day sale + 100 advance.
    for pid, amount, company in [(1,1000,1000),(2,500,500),(3,120,120),(4,70,70),(5,75,75),(6,200,200),(7,60,60),(8,50,50),(9,90,90),(10,100,650)]:
        db.execute('INSERT INTO fact_finance_collection VALUES (?,1,?)', (pid,'2026-10-15'))
        db.execute('INSERT INTO v_finance_collection_trend VALUES (?,1,?,?)',(pid,amount,company))
    db.executemany('INSERT INTO dim_finance_collection_invoice_date VALUES (?,?)',[(1,'2026-09-01'),(2,'2026-10-14'),(3,'2026-10-15'),(4,'2026-10-16'),(5,None)])
    allocations=[(1,1,'overdue',200),(1,2,'not_due',300),(1,3,'not_due',400),
      (2,3,'not_due',500),(3,2,'not_due',120),(4,4,'not_due',70),(5,1,'other',75),
      (7,5,'overdue',60),(8,1,'overdue',20),(8,1,'overdue',30),(9,3,'overdue',90),
      (10,1,'overdue',60),(10,3,'not_due',40)]
    for pid,mid,kind,amount in allocations:
        db.execute('INSERT INTO fact_finance_collection_invoice VALUES (?,1,?,?,?,?)',(pid,mid,'entry' if kind=='other' else 'out_invoice',kind,amount))
    actual=db.execute(f"""SELECT v.payment_id,e.amount_doc_ccy,e.applied_overdue_doc_ccy,e.applied_not_due_doc_ccy,
       e.amount_doc_ccy*v.amount_company_ccy/NULLIF(v.amount_doc_ccy,0)
       FROM v_finance_collection_trend v {match.group(1)} ORDER BY v.payment_id""").fetchall()
    assert actual == [(1,500,200,300,500),(3,120,0,120,120),(8,50,50,0,50),(10,60,60,0,390)]
    # Same-day, future, unmatched, non-invoice and undated money never adds to collection or payment counts.
    assert len(actual)==4
    db.close()


def test_invoice_dates_are_actual_invoice_dates_not_due_dates():
    dates=collection_invoice_dates({
      1:{'id':1,'move_type':'out_invoice','invoice_date':'2026-10-14','invoice_date_due':'2026-11-14'},
      2:{'id':2,'move_type':'out_receipt','invoice_date':'2026-10-15'},
      3:{'id':3,'move_type':'out_invoice','invoice_date':False,'invoice_date_due':'2026-09-01'},
      4:{'id':4,'move_type':'entry','invoice_date':'2026-01-01'},
    }).set_index('move_id')
    assert str(dates.loc[1,'invoice_date'])=='2026-10-14'
    assert str(dates.loc[2,'invoice_date'])=='2026-10-15'
    assert dates.loc[3,'invoice_date'] is None
    assert 4 not in dates.index


def test_invoice_date_metadata_fits_the_actual_migration(platform_engine):
    import datetime as dt
    from sqlalchemy import text
    from sqlite_schema import apply_migration_sqlite
    from etl_platform.load import upsert
    apply_migration_sqlite(platform_engine, '0045_collection_invoice_dates.sql')
    dates=collection_invoice_dates({1:{'id':1,'move_type':'out_invoice','invoice_date':'2026-10-14'}})
    with platform_engine.begin() as conn:
        assert upsert(conn,'dim_finance_collection_invoice_date',dates.assign(updated_at_utc=dt.datetime(2026,10,15)))==1
        assert str(conn.execute(text('SELECT invoice_date FROM dim_finance_collection_invoice_date WHERE move_id=1')).scalar())=='2026-10-14'
