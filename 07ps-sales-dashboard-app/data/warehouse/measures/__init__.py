"""Tachometer page KPI/measures layer.

Pure query + business-logic module, no framework dependency (no Express/Flask, no ORM). Every
function here takes plain Python values in and returns plain Python values out, so it can be
ported near-verbatim into whichever backend module ends up serving these as API endpoints
(Phase P3) -- see ../../ingestion/README.md and this package's README.md for the current backend
data-access-layer mismatch (Postgres/RLS scaffold vs. the now-current MySQL warehouse) that Phase
P3 will need to resolve before wiring these in for real.
"""
