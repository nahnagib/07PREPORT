# Tachometer KPI/Measures Layer

Pure Python query + business-logic module for the Tachometer page's KPIs. No framework
dependency (no Express/Flask, no ORM) -- every function takes plain values in, plain values out,
so it can be ported into whichever backend module ends up serving these as real endpoints. See
`../../ingestion/tachometer_kpi_validation.md` for the full validation report and
`../../ingestion/README.md` for the Postgres/MySQL backend driver mismatch this currently sits
outside of.

## Modules

- `classify.py` -- `classify_vs_target(actual, target)`: shared Green/Yellow/Red threshold logic
  used by both the tachometers and the ASP cards.
- `filters.py` -- `Filters` dataclass, `build_where_clause()`, date-window functions (`mtd_window`,
  `ytd_window`, `lmtd_window`, `lytd_window`, `flm_window`, `fly_window`), FY/FM Target-to-date
  proration (`prorate_mtd_target`, `prorate_ytd_target`), and the Salesperson RBAC lock
  (`apply_salesperson_lock`).
- `tachometer.py` -- `fetch_value_volume`, `fetch_target_for_months`, `compute_mtd_card`,
  `compute_ytd_card`, `compute_asp_card`: the actual metric queries, each citing its source table
  in its docstring.
- `refresh_status.py` -- Last Update / Last Refresh Time queries.
- `db.py` -- MySQL connection helper (same env-var contract as `data/ingestion/orchestrator.py`).

## Running the tests

```bash
cd data/warehouse/measures
PYTHONPATH="$(pwd)" python3 -m pytest tests/ -v
```

40 tests, no database required (pure logic -- date windows, proration math, WHERE-clause
building, classify boundaries, RBAC lock behavior).

## Running against a live warehouse

```bash
export DB_SOCKET=/path/to/mysqld.sock   # or DB_HOST/DB_PORT/DB_USER/DB_PASSWORD
export DB_NAME=ps_warehouse
python3 -c "
from datetime import date
from db import get_connection
from filters import Filters
from tachometer import compute_mtd_card

conn = get_connection()
card = compute_mtd_card(conn, date.today(), Filters(company_key=1), 'value')
print(card)
"
```
