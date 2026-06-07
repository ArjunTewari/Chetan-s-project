---
name: run_calculation context overflow fix
description: Why run_calculation receives empty input with large org sets, and how the server-side accumulation fallback works.
---

## The problem
With 9–13 orgs, all the fetch_* tool responses fill Claude's context window so completely that when it tries to call `run_calculation`, it cannot serialize the full `raw_input` payload (hundreds of KB of JSON) into the tool call arguments. It sends `input={}` instead. The old code returned an error, the LLM retried up to 8 times, wasting ~$0.68 per run with no report generated.

## The fix (implemented in backend/src/agent.ts)
Server-side data accumulation in `store.accumulated: AccumulatedFetchData`.

As each fetch tool runs, its input (for handle→org mapping) and output (data) are saved to `store.accumulated`:
- `fetch_serper` → `serperInput` + `serperData`
- `fetch_youtube` → `youtubeInput` + `youtubeData`
- `fetch_x_api` → `xInput` + `xData`
- `fetch_instagram` → `instagramInput` + `instagramData`
- `fetch_linkedin` → `linkedinInput` + `linkedinData`
- `fetch_llm_visibility` → `aeoData` + `aeoLlms`

When `run_calculation` is called with missing/empty `raw_input`, `buildAutoRawInput(store.accumulated)` reconstructs the full `RawInput` object server-side and passes it to `runCalculations()`.

**Why:** The LLM doesn't need to re-pass all the raw data — the server already has it from when the tools ran. The fallback is transparent; if the LLM does pass `raw_input` it's used as-is.

## Schema changes
`fetch_youtube` and `fetch_x_api` now require an `orgs` array (matching handles order) alongside `handles` — essential for correct handle→org mapping in the accumulator.

## Deployment flow
1. `cd backend && npm run build`
2. `cd frontend && npm run build`
3. User clicks Publish in Replit
4. Production run command: `cd backend && PORT=5000 NODE_ENV=production node dist/server.js`
