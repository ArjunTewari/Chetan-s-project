---
name: htmlGenerator null safety
description: Fields in CalcResult/ReportMeta passed to htmlGenerator can be undefined; missing guards crash report generation
---

All numeric fields rendered in htmlGenerator.ts must use `(value ?? 0).toLocaleString()` or `(value ?? 0).toFixed(n)`. Fields that crashed: `api_costs[].input_tokens`, `api_costs[].output_tokens`, `api_costs[].cost_usd`, `social[].impressions`, `social[].total_engagement`, `social[].likes/shares/comments/saves`, YouTube channel stats.

**Why:** Claude sometimes passes sparse objects to `generate_report` where optional fields are absent. The crash is silently caught in executeTool's try/catch and returned as `{ error: "..." }` to Claude, which then claims it generated the report — creating a confusing "cannot view report" bug.

**How to apply:** Before adding any new field to htmlGenerator, add a `?? 0` / `?? "—"` default at the render site, not at the schema level.
