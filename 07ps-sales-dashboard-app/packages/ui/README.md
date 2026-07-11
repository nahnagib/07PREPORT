# @07ps/ui

Shared, versioned component library for every 07 Ps dashboard (Sales today; Production, Supply Chain,
HR, HSE, Excellence, Finance in later phases). Per Standards Section 3.20/5.8:

> "A single shared component library ... is the only building block set future dashboards may use —
> no one-off bespoke components per department. Any new component proposed by a department must be
> reviewed and added to the shared library before use, never built inline for a single page."

Governance: this package is semantically versioned (Section 5.17). A breaking change requires a major
version bump and a regression check against every dashboard that consumes it before release — not just
the page that requested the change.

## Components in this Phase P1/P2 release

Foundation/state components only (no Sales-specific components yet — those arrive in Phase P3):

- `KpiTile` — Section 3.6 KPI card (value + label + optional variance, semantic color)
- `Card` — Section 3.5 base card container
- `Gauge` / `DonutRing` — Section 3.7 gauge/ring primitives used by Tachometer-style visuals
- `DataTable` — Section 3.8 sticky-header, frozen-first-column, pinned-totals table
- `FilterChip` / `FilterSelect` — Section 4 filter controls
- `LoadingSkeleton` — Section 3.21
- `EmptyState` — Section 3.22
- `ErrorState` — Section 3.23
- `SemanticBadge` — Section 3.9 green/amber/red status pill (color never the only signal — Section 5.10)
