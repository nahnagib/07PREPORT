"""Pure DataFrame -> DataFrame builders for the conformed dimensions. No database, no Odoo: unit-tested directly.
Every builder returns frames whose columns match the core tables of migration 0029 (minus updated_at_utc,
added at load time)."""
