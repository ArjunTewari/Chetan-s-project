---
name: SSE report delivery
description: How to deliver the generated HTML report to the frontend reliably
---

Do NOT send full HTML (100-300KB) as a single SSE event frame. Instead:
1. In agent.ts `generate_report` case: send `{ type: "report_ready", html_length }` (lightweight signal)
2. Server saves HTML to DB via `upsertReport` before sending the `done` event
3. Frontend receives `done` with `hasReport: true`, then fetches `/conversations/:id/report` to get the full HTML

**Why:** A 200KB JSON-stringified SSE line can fail to parse (silently caught by the frontend's try/catch), leaving `reportHtml` null and the "View Report" button never appearing. Fetching from the API endpoint after `done` is reliable and avoids the large-payload problem.

**How to apply:** Any tool that generates large binary/HTML output should follow this pattern — store in DB, signal via lightweight SSE, fetch on demand.
