# NPS SLA preview

Screenshots of the actual application pages with synthetic demo API responses, captured on 7 November 2026.
They demonstrate every time colour, both no-SLA labels, an amber contacted board card, and the six-bucket stacked chart.
No customer data or production writes were used.

- [List column, light](list-light.png)
- [Board card, light](board-card-light.png)
- [Resolved Ageing, dark](resolution-ageing-dark.png)

The case window was also checked to use the same amber state, and the chart was checked in light and dark themes
and at a 390 px viewport (horizontal chart scrolling preserves readable bucket labels).

The dataviz `validate_palette.py` validator passed all-pairs checks in both themes (light surface `#ffffff`, dark
surface `#161d2e`). CVD separation reported WARN, with minima 8.0 and 7.4 respectively (allowed range 6–8 when
secondary encoding is present). Time values have distinct icons and named rule tooltips; chart series have solid /
hatched fills and explicit SLA labels. Automated contrast checks verify all four text colours at 4.5:1 on both
card and page backgrounds in each theme.
