// agent.ts — Claude Sonnet agentic loop with tool use and SSE streaming
import type { Response } from "express";
import Anthropic from "@anthropic-ai/sdk";
import {
  anthropic,
  MODEL,
  calcCost,
} from "./anthropicClient";
import { runCalculations, type RawInput } from "./calculator";
import { generateHTMLReport, type ReportMeta } from "./htmlGenerator";
import {
  fetchSerper,
  fetchYouTube,
  fetchXApi,
  fetchSemrush,
  fetchLLMVisibility,
  fetchCommentSentiment,
  fetchWikipedia,
} from "./tools";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// SSE helper
// ---------------------------------------------------------------------------
export function sendEvent(res: Response, data: Record<string, unknown>) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AgentOptions {
  conversationId: number;
  userMessage: string;
  history: ConversationMessage[];
  res: Response;
  reportStatsJson?: string | null;
  /** Persisted meta from the last full report generation — used in update_report_section
   *  so that rich data (youtube_channels, tone_evidence, etc.) is never lost on edits */
  reportMeta?: ReportMeta | null;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are Emerald AI, an expert Air Quality Media Intelligence analyst. You help users generate, query, and update Air Quality Media Intelligence Reports for NGOs and research organisations.

You have access to tools to fetch live data and run precise calculations. Always use tools to back your analysis — never invent numbers.

## Intent routing
Classify the user's message as one of:
- GENERATE: They want a new full report. If orgs / outlets / date range / LLMs are missing, ask for them, then follow the GENERATE workflow below.
- QUERY: They have a question about an existing report. Answer from stats JSON / insights you have been given.
- ADD_STAT: They want to add/update a specific data point. Re-run run_calculation with updated data, then update_report_section.
- APPROVE: They are approving the draft (e.g. "looks good", "generate the report", "approve"). Call generate_report using stored stats + meta.
- HELP: Explain what you can do.

## Default LLMs (use if not specified)
ChatGPT, Perplexity, Gemini

## Default outlets (use if not specified)
The Guardian, BBC, Reuters, AP News, Bloomberg

## LLM visibility queries — MUST be generic discovery questions
Queries passed to fetch_llm_visibility must be generic questions a user would naturally ask.
DO NOT ask about the org directly. The score measures whether the org is mentioned unprompted.
Good examples (adapt for region/sector of the orgs):
  "Which organisations are leading the fight against air pollution in India?"
  "What NGOs work on urban air quality monitoring and advocacy?"
  "Who are the most influential environmental research groups on air quality in South Asia?"
  "Which nonprofits should I follow for air quality data and policy in India?"
  "Name the key civil society organisations working on clean air in Indian cities?"
Always supply exactly 5 such queries.

## GENERATE workflow — follow this order exactly
1. Fetch all data: fetch_serper, fetch_youtube, fetch_x_api, fetch_llm_visibility, fetch_comment_sentiment
2. Check data quality: if ANY org has total media mentions < 5, also call fetch_wikipedia for all orgs
3. Call run_calculation with all fetched data
4. Call present_draft — shows data to the user for review. STOP here.
5. Wait. Do NOT call generate_report yet.
6. When the user approves → call generate_report (pass wiki_data from fetch_wikipedia if available).
7. After generate_report, write 3 key insights as plain text.

## Data quality rules — NEVER leave 0 without trying alternatives
- fetch_serper now has 5 automatic fallback tiers per outlet. It also auto-tries backup specialist
  outlets (Down To Earth, Wire, Mongabay, Carbon Brief etc.) and runs a broad web search if
  primary outlets return thin coverage. Trust the results even if outlet names differ from the
  requested list — these are real articles found through fallback searches.
- fetch_x_api now uses real Serper search. If indexed_posts = 0 for a handle, the org genuinely
  has no indexed X activity in the period — report this honestly, do not inflate.
- fetch_wikipedia supplements when media coverage is thin. Pass result.data as meta.wiki_data
  to generate_report. Use the Wikipedia summary to give context about the org in the report text.
- fetch_llm_visibility now runs up to 8 queries (normalised to /20 scale). Trust the numbers.

## Rules
- NEVER call generate_report immediately after run_calculation. Always go through present_draft first.
- Call BOTH fetch_youtube AND fetch_x_api for social data.
- Pass ALL raw data from fetch calls into run_calculation.
- If data is genuinely 0 after all fallbacks, report it honestly with context ("no indexed coverage found in this period").
- Be precise and concise — users are analysts, not novices.
- For date ranges, if the user says "last month" or similar, calculate from today.

## Critical: how to map tool results into run_calculation

### Tone definition (important — affects data quality)
Tone "A" = Authoritative: org is cited as the primary expert source, researcher quoted directly.
Tone "N" = Neutral: org is mentioned among several sources but not as the lead expert.
This is NOT positive vs negative. An org can have 100% Neutral tone and still have excellent coverage.

fetch_serper returns: { data: { [org]: { [outlet]: { mentions, dofollow, direct_cites, tone } } }, tone_evidence: [...] }
→ flatten into raw.media as: [{ org, outlet, mentions, dofollow, direct_cites, tone }, ...]
→ pass result.tone_evidence directly as meta.tone_evidence to generate_report (representative articles for each outlet tone classification)

fetch_youtube returns: { data: { [handle]: { platform, impressions, likes, shares, comments, saves, quote_rt, channel_title, channel_id, channel_total_views, channel_subscribers, channel_video_count, top_videos[], longform: {...}, shorts: {...} } } }
fetch_x_api returns: { data: { [handle]: { platform, impressions, likes, shares, comments, saves, quote_rt } } }
→ For YouTube, emit TWO SocialRaw entries per handle when longform/shorts data is present:
    { org, platform: "YouTube Long-form", impressions: longform.impressions, likes: longform.likes, shares: 0, comments: longform.comments, saves: longform.saves, quote_rt: 0 }
    { org, platform: "YouTube Shorts",    impressions: shorts.impressions,   likes: shorts.likes,   shares: 0, comments: shorts.comments,   saves: shorts.saves,   quote_rt: 0 }
  If longform.impressions = 0 and shorts.impressions = 0, fall back to a single entry with platform: "YouTube"
→ Add X entry from fetch_x_api as: { org, platform: "X", impressions, likes, shares, comments, saves, quote_rt }
→ Use the org name (not the handle) for the "org" field.
→ Build meta.youtube_channels for generate_report: for each handle: { handle, channel_title, channel_id, channel_total_views, channel_subscribers, channel_video_count, top_videos }

fetch_llm_visibility returns: { data: [...], costs: [...], query_results: [...] }
→ pass result.data directly as raw.aeo (already the correct shape — NEVER pass the whole object)
→ pass result.costs as meta.api_costs to generate_report
→ pass result.query_results as meta.llm_query_results to generate_report (used for Sample Query Performance table)

fetch_semrush result does NOT go into run_calculation — it is supplementary context only.
fetch_wikipedia returns: { data: { [org]: { found, title, summary, url } } }
→ pass result.data as meta.wiki_data to generate_report (supplementary org context, not scored).

For raw.queries: if you have per-query mention data, include [{ query, org, llm, mentioned, position }, ...]; otherwise use [].

## Comment Sentiment Analysis
After calling fetch_youtube (and BEFORE calling generate_report), ALWAYS call fetch_comment_sentiment.
Build org_video_pairs from the fetch_youtube result:
  for each handle: { org: <org name matching meta.orgs>, video_ids: <top_videos[].videoId> }
Pass result.data as meta.comment_sentiment to generate_report.
If fetch_comment_sentiment returns empty data, pass an empty array [].
`;

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------
const TOOLS: Anthropic.Tool[] = [
  {
    name: "fetch_serper",
    description:
      "Fetch media mentions, dofollow links, direct citations, and tone from the Serper News API for given orgs and outlets in a date range.",
    input_schema: {
      type: "object" as const,
      properties: {
        orgs: { type: "array", items: { type: "string" }, description: "Organisation names" },
        outlets: { type: "array", items: { type: "string" }, description: "Media outlet names" },
        date_range: {
          type: "object",
          properties: { from: { type: "string" }, to: { type: "string" } },
          required: ["from", "to"],
        },
        query_keywords: {
          type: "array",
          items: { type: "string" },
          description: "Keywords to search (e.g. air quality, pollution, AQI)",
        },
      },
      required: ["orgs", "outlets", "date_range", "query_keywords"],
    },
  },
  {
    name: "fetch_youtube",
    description:
      "Fetch YouTube engagement metrics (impressions, likes, shares, comments, saves) for org handles.",
    input_schema: {
      type: "object" as const,
      properties: {
        handles: { type: "array", items: { type: "string" } },
        date_range: {
          type: "object",
          properties: { from: { type: "string" }, to: { type: "string" } },
          required: ["from", "to"],
        },
      },
      required: ["handles", "date_range"],
    },
  },
  {
    name: "fetch_x_api",
    description:
      "Fetch X (Twitter) engagement metrics (impressions, likes, shares, comments) for org handles.",
    input_schema: {
      type: "object" as const,
      properties: {
        handles: { type: "array", items: { type: "string" } },
        date_range: {
          type: "object",
          properties: { from: { type: "string" }, to: { type: "string" } },
          required: ["from", "to"],
        },
      },
      required: ["handles", "date_range"],
    },
  },
  {
    name: "fetch_semrush",
    description: "Fetch SEMrush backlink data for org domains.",
    input_schema: {
      type: "object" as const,
      properties: {
        domains: { type: "array", items: { type: "string" } },
        target_orgs: { type: "array", items: { type: "string" } },
      },
      required: ["domains", "target_orgs"],
    },
  },
  {
    name: "fetch_llm_visibility",
    description:
      "Run air quality queries against specified LLMs and collect mention rates, positions, and citation types.",
    input_schema: {
      type: "object" as const,
      properties: {
        orgs: { type: "array", items: { type: "string" } },
        queries: {
          type: "array",
          items: { type: "string" },
          description: "Air quality related queries",
        },
        llms: {
          type: "array",
          items: { type: "string" },
          description: "e.g. ChatGPT, Perplexity, Gemini",
        },
      },
      required: ["orgs", "queries", "llms"],
    },
  },
  {
    name: "fetch_wikipedia",
    description:
      "Fetch Wikipedia summary and credibility context for each organisation. Call this when any org has very low media coverage (total mentions < 5) or when org details are needed for the report. Wikipedia data supplements but does not replace real media data.",
    input_schema: {
      type: "object" as const,
      properties: {
        orgs: { type: "array", items: { type: "string" }, description: "Organisation names to look up" },
      },
      required: ["orgs"],
    },
  },
  {
    name: "fetch_comment_sentiment",
    description:
      "Fetch YouTube comments for each org's top videos and classify them as Positive, Neutral, or Negative toward the organisation using GPT-4o-mini. Call AFTER fetch_youtube.",
    input_schema: {
      type: "object" as const,
      properties: {
        org_video_pairs: {
          type: "array",
          description: "Array of { org, video_ids } pairs. video_ids from fetch_youtube top_videos.",
          items: {
            type: "object",
            properties: {
              org: { type: "string", description: "Organisation name" },
              video_ids: { type: "array", items: { type: "string" }, description: "YouTube video IDs" },
            },
            required: ["org", "video_ids"],
          },
        },
      },
      required: ["org_video_pairs"],
    },
  },
  {
    name: "present_draft",
    description:
      "Present calculated data as a structured draft for the user to review BEFORE generating the final HTML report. Call this after run_calculation and STOP — do not call generate_report until the user explicitly approves.",
    input_schema: {
      type: "object" as const,
      properties: {
        meta: {
          type: "object",
          description: "Report metadata (orgs, date_range, outlets, llms, youtube_channels, api_costs, etc.)",
        },
        stats_json: {
          type: "string",
          description: "JSON string of the CalcResult from run_calculation",
        },
        summary: {
          type: "string",
          description: "2–3 sentence plain-language summary of the key findings for the user to review",
        },
      },
      required: ["meta", "stats_json", "summary"],
    },
  },
  {
    name: "run_calculation",
    description:
      "Run all calculations (social ER%, media stats, AEO visibility scores, action matrix) from raw data. Returns a stats JSON object.",
    input_schema: {
      type: "object" as const,
      properties: {
        raw_input: {
          type: "object",
          description: "RawInput object with meta and raw sections",
          properties: {
            meta: {
              type: "object",
              properties: {
                orgs: { type: "array", items: { type: "string" } },
                date_range: {
                  type: "object",
                  properties: { from: { type: "string" }, to: { type: "string" } },
                  required: ["from", "to"],
                },
                outlets: { type: "array", items: { type: "string" } },
                llms: { type: "array", items: { type: "string" } },
              },
              required: ["orgs", "date_range", "outlets", "llms"],
            },
            raw: {
              type: "object",
              properties: {
                social: { type: "array", items: { type: "object" } },
                media: { type: "array", items: { type: "object" } },
                aeo: { type: "array", items: { type: "object" } },
                queries: { type: "array", items: { type: "object" } },
              },
              required: ["social", "media", "aeo", "queries"],
            },
          },
          required: ["meta", "raw"],
        },
      },
      required: ["raw_input"],
    },
  },
  {
    name: "generate_report",
    description:
      "Generate the full self-contained HTML report from a stats JSON object. Call AFTER run_calculation. Emits the report HTML over SSE.",
    input_schema: {
      type: "object" as const,
      properties: {
        meta: {
          type: "object",
          description: "Report metadata",
          properties: {
            orgs: { type: "array", items: { type: "string" } },
            date_range: {
              type: "object",
              properties: { from: { type: "string" }, to: { type: "string" } },
              required: ["from", "to"],
            },
            outlets: { type: "array", items: { type: "string" } },
            llms: { type: "array", items: { type: "string" } },
            client_name: { type: "string" },
            api_costs: { type: "array", items: { type: "object" }, description: "Cost array from fetch_llm_visibility result.costs" },
            claude_cost_usd: { type: "number", description: "Claude API cost for this run" },
            serper_requests: { type: "number", description: "Number of Serper API requests made" },
            youtube_channels:   { type: "array", items: { type: "object" }, description: "YouTube channel data from fetch_youtube" },
            comment_sentiment:  { type: "array", items: { type: "object" }, description: "Comment sentiment from fetch_comment_sentiment result.data" },
            llm_query_results:  { type: "array", items: { type: "object" }, description: "Per-query mention results from fetch_llm_visibility result.query_results" },
            tone_evidence:      { type: "array", items: { type: "object" }, description: "Representative articles for tone classification from fetch_serper result.tone_evidence" },
            wiki_data:          { type: "object", description: "Wikipedia summaries from fetch_wikipedia result.data — keyed by org name" },
          },
          required: ["orgs", "date_range", "outlets", "llms"],
        },
        stats_json: {
          type: "string",
          description: "JSON string of the stats object returned by run_calculation",
        },
      },
      required: ["meta", "stats_json"],
    },
  },
  {
    name: "update_report_section",
    description:
      "Update a specific section of an existing report with new or corrected data. Returns the updated HTML.",
    input_schema: {
      type: "object" as const,
      properties: {
        section: {
          type: "string",
          description: "Section name: social | media | aeo | action_matrix | scorecards",
        },
        updated_stats_json: { type: "string", description: "JSON of the updated stats" },
        meta: { type: "object", description: "Report metadata" },
      },
      required: ["section", "updated_stats_json", "meta"],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool label map for SSE display
// ---------------------------------------------------------------------------
const TOOL_LABELS: Record<string, string> = {
  fetch_serper: "Fetching news & media mentions...",
  fetch_youtube: "Fetching YouTube metrics...",
  fetch_x_api: "Fetching X engagement data...",
  fetch_semrush: "Fetching SEMrush backlink data...",
  fetch_llm_visibility: "Running LLM visibility queries...",
  fetch_wikipedia:         "Fetching Wikipedia context for organisations...",
  fetch_comment_sentiment: "Analysing YouTube comment sentiment...",
  present_draft: "Preparing draft for review...",
  run_calculation: "Running calculations...",
  generate_report: "Generating HTML report...",
  update_report_section: "Updating report section...",
};

// ---------------------------------------------------------------------------
// Tool result store (shared across loop iterations)
// ---------------------------------------------------------------------------
interface ToolResultStore {
  statsJson?: string;
  calcResult?: ReturnType<typeof runCalculations>;
  meta?: ReportMeta;
  htmlReport?: string;
  claudeCostUsd?: number; // accumulated before generate_report is called
}

// ---------------------------------------------------------------------------
// Execute a single tool call
// ---------------------------------------------------------------------------
async function executeTool(
  toolName: string,
  toolInput: Record<string, unknown>,
  store: ToolResultStore,
  res: Response
): Promise<string> {
  try {
    switch (toolName) {
      case "fetch_serper":
        return JSON.stringify(
          await fetchSerper(toolInput as unknown as Parameters<typeof fetchSerper>[0])
        );

      case "fetch_youtube":
        return JSON.stringify(
          await fetchYouTube(toolInput as unknown as Parameters<typeof fetchYouTube>[0])
        );

      case "fetch_x_api":
        return JSON.stringify(
          await fetchXApi(toolInput as unknown as Parameters<typeof fetchXApi>[0])
        );

      case "fetch_semrush":
        return JSON.stringify(
          await fetchSemrush(toolInput as unknown as Parameters<typeof fetchSemrush>[0])
        );

      case "fetch_llm_visibility":
        return JSON.stringify(
          await fetchLLMVisibility(
            toolInput as unknown as Parameters<typeof fetchLLMVisibility>[0]
          )
        );

      case "fetch_wikipedia":
        return JSON.stringify(
          await fetchWikipedia(toolInput as unknown as Parameters<typeof fetchWikipedia>[0])
        );

      case "fetch_comment_sentiment":
        return JSON.stringify(
          await fetchCommentSentiment(
            toolInput as unknown as Parameters<typeof fetchCommentSentiment>[0]
          )
        );

      case "present_draft": {
        const { meta: draftMeta, stats_json: draftStatsJson, summary } = toolInput as {
          meta: ReportMeta;
          stats_json: string;
          summary: string;
        };
        // Persist in store so generate_report can use it on approval
        try {
          store.calcResult = JSON.parse(draftStatsJson) as ReturnType<typeof runCalculations>;
          store.statsJson  = draftStatsJson;
        } catch { /* keep existing */ }
        store.meta = draftMeta;
        // Emit draft_ready event — frontend renders the review panel
        sendEvent(res, {
          type: "draft_ready",
          meta: draftMeta,
          stats: store.calcResult,
          stats_json: draftStatsJson,
          summary,
        });
        return JSON.stringify({
          success: true,
          message: "Draft presented to the user. STOP here — wait for their explicit approval before calling generate_report.",
        });
      }

      case "run_calculation": {
        const rawInput = (toolInput as { raw_input: RawInput }).raw_input;
        const calcResult = runCalculations(rawInput);
        store.calcResult = calcResult;
        store.statsJson = JSON.stringify(calcResult);
        if (!calcResult.success) {
          return JSON.stringify({
            error: calcResult.error,
            sanity_errors: calcResult.sanity_errors,
          });
        }
        return JSON.stringify(calcResult);
      }

      case "generate_report": {
        const { meta: rawMeta, stats_json } = toolInput as {
          meta: ReportMeta;
          stats_json: string;
        };
        // Inject the accumulated Claude cost so the report shows the true cost
        const meta: ReportMeta = {
          ...rawMeta,
          claude_cost_usd: store.claudeCostUsd ?? rawMeta.claude_cost_usd ?? 0,
        };
        store.meta = meta;
        let calcResult = store.calcResult;
        if (!calcResult) {
          try {
            calcResult = JSON.parse(stats_json) as ReturnType<typeof runCalculations>;
          } catch {
            return JSON.stringify({ error: "Invalid stats_json" });
          }
        }
        const html = generateHTMLReport(meta, calcResult);
        store.htmlReport = html;
        store.statsJson = JSON.stringify(calcResult);
        // Send a lightweight signal — frontend fetches the full HTML from the API
        // after receiving the "done" event. Avoid sending 100-300KB in a single SSE frame.
        sendEvent(res, { type: "report_ready", html_length: html.length });
        return JSON.stringify({ success: true, html_length: html.length });
      }

      case "update_report_section": {
        const { section, updated_stats_json, meta: claudeMeta } = toolInput as {
          section: string;
          updated_stats_json: string;
          meta: ReportMeta;
        };
        let calcResult: ReturnType<typeof runCalculations>;
        try {
          calcResult = JSON.parse(updated_stats_json) as ReturnType<typeof runCalculations>;
        } catch {
          // If Claude didn't pass updated stats, use the stored ones
          if (store.statsJson) {
            try { calcResult = JSON.parse(store.statsJson) as ReturnType<typeof runCalculations>; }
            catch { return JSON.stringify({ error: "Invalid updated_stats_json and no stored stats" }); }
          } else {
            return JSON.stringify({ error: "Invalid updated_stats_json" });
          }
        }
        // Merge: use stored rich meta as the base, overlay only what Claude explicitly provided
        // This preserves youtube_channels, tone_evidence, llm_query_results, comment_sentiment etc.
        const richMeta: ReportMeta = {
          ...(store.meta ?? {}),    // base: all previously stored rich data
          ...claudeMeta,            // overlay: whatever Claude provided (orgs, date_range, etc.)
          // Never let Claude drop the rich fields — keep stored versions if Claude omits them
          youtube_channels:   claudeMeta?.youtube_channels   ?? store.meta?.youtube_channels,
          tone_evidence:      claudeMeta?.tone_evidence      ?? store.meta?.tone_evidence,
          llm_query_results:  claudeMeta?.llm_query_results  ?? store.meta?.llm_query_results,
          comment_sentiment:  claudeMeta?.comment_sentiment  ?? store.meta?.comment_sentiment,
          api_costs:          claudeMeta?.api_costs          ?? store.meta?.api_costs,
          claude_cost_usd:    claudeMeta?.claude_cost_usd    ?? store.meta?.claude_cost_usd,
        };
        const html = generateHTMLReport(richMeta, calcResult);
        store.htmlReport = html;
        store.meta = richMeta;
        store.statsJson = JSON.stringify(calcResult);
        sendEvent(res, { type: "report_ready", html_length: html.length });
        sendEvent(res, { type: "section_complete", section });
        return JSON.stringify({ success: true, section_updated: section });
      }

      default:
        return JSON.stringify({ error: `Unknown tool: ${toolName}` });
    }
  } catch (err) {
    logger.error({ err, toolName }, "Tool execution error");
    return JSON.stringify({ error: String(err) });
  }
}

// ---------------------------------------------------------------------------
// Main agent entry point
// ---------------------------------------------------------------------------
export async function runAgent(opts: AgentOptions): Promise<{
  assistantText: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  statsJson?: string;
  htmlReport?: string;
  meta?: ReportMeta;
  toolCallsJson?: string;
}> {
  const { conversationId, userMessage, history, res } = opts;

  logger.info({ conversationId, userMessage }, "Agent started");

  // Trim history to the last 6 messages to prevent unbounded context growth.
  // Each extra history message is re-sent on every loop iteration — this is
  // the primary driver of high session costs.
  const MAX_HISTORY_MESSAGES = 6;
  const trimmedHistory = history.slice(-MAX_HISTORY_MESSAGES);

  const messages: Anthropic.MessageParam[] = [
    ...trimmedHistory.map((m) => ({ role: m.role, content: m.content })),
    { role: "user" as const, content: userMessage },
  ];

  // Prompt caching: mark the system prompt and last tool as cacheable.
  // After the first iteration the system prompt is cached and re-read at
  // 10% of normal cost (~90% saving on system-prompt input tokens).
  // Cast needed because the SDK's TS types don't yet expose cache_control on
  // TextBlockParam, but the API accepts it.
  const systemWithCache = [
    { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
  ] as unknown as Anthropic.TextBlockParam[];
  const toolsWithCache = TOOLS.map((t, i) =>
    i === TOOLS.length - 1
      ? ({ ...t, cache_control: { type: "ephemeral" } } as Anthropic.Tool)
      : t
  );

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheWriteTokens = 0;
  let totalCacheReadTokens = 0;
  let assistantText = "";
  // Pre-seed store with persisted meta so update_report_section can use the rich data
  const store: ToolResultStore = {
    meta: opts.reportMeta ?? undefined,
    statsJson: opts.reportStatsJson ?? undefined,
  };
  const toolCallsRecord: Array<{ tool: string; input: unknown; output: unknown }> = [];

  let iterMessages = [...messages];
  let iterations = 0;
  const MAX_ITERATIONS = 12;

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    logger.info({ iteration: iterations }, "Agent loop");

    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: systemWithCache,
      tools: toolsWithCache,
      messages: iterMessages,
    });

    const usage = response.usage as typeof response.usage & {
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    totalInputTokens       += usage.input_tokens;
    totalOutputTokens      += usage.output_tokens;
    totalCacheWriteTokens  += usage.cache_creation_input_tokens ?? 0;
    totalCacheReadTokens   += usage.cache_read_input_tokens     ?? 0;

    const currentCost = calcCost(
      totalInputTokens,
      totalOutputTokens,
      totalCacheWriteTokens,
      totalCacheReadTokens,
    );
    store.claudeCostUsd = currentCost;

    sendEvent(res, {
      type: "cost",
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cacheWriteTokens: totalCacheWriteTokens,
      cacheReadTokens: totalCacheReadTokens,
      costUsd: currentCost,
    });

    const toolUseBlocks: Anthropic.ToolUseBlock[] = [];

    for (const block of response.content) {
      if (block.type === "text") {
        assistantText += block.text;
        sendEvent(res, { type: "text", content: block.text });
      } else if (block.type === "tool_use") {
        toolUseBlocks.push(block);
      }
    }

    if (response.stop_reason === "end_turn" || toolUseBlocks.length === 0) {
      break;
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolBlock of toolUseBlocks) {
      const label = TOOL_LABELS[toolBlock.name] ?? `Running ${toolBlock.name}...`;
      sendEvent(res, { type: "tool_start", tool: toolBlock.name, label });

      const output = await executeTool(
        toolBlock.name,
        toolBlock.input as Record<string, unknown>,
        store,
        res
      );

      sendEvent(res, { type: "tool_done", tool: toolBlock.name });
      toolCallsRecord.push({
        tool: toolBlock.name,
        input: toolBlock.input,
        output: JSON.parse(output),
      });

      // Truncate large tool outputs before appending to the context window.
      // Claude only needs summary-level data; full payloads are used by the
      // generator functions directly. Cap at 6 000 chars (~1 500 tokens).
      const MAX_TOOL_RESULT_CHARS = 6_000;
      const contextOutput =
        output.length > MAX_TOOL_RESULT_CHARS
          ? output.slice(0, MAX_TOOL_RESULT_CHARS) + '…[truncated — full data used by generator]'
          : output;

      toolResults.push({
        type: "tool_result",
        tool_use_id: toolBlock.id,
        content: contextOutput,
      });
    }

    iterMessages = [
      ...iterMessages,
      { role: "assistant" as const, content: response.content },
      { role: "user" as const, content: toolResults },
    ];
  }

  const finalCostUsd = calcCost(
    totalInputTokens,
    totalOutputTokens,
    totalCacheWriteTokens,
    totalCacheReadTokens,
  );
  logger.info(
    { iterations, finalCostUsd, totalCacheWriteTokens, totalCacheReadTokens },
    "Agent finished"
  );

  return {
    assistantText,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    costUsd: finalCostUsd,
    statsJson: store.statsJson,
    htmlReport: store.htmlReport,
    meta: store.meta,
    toolCallsJson:
      toolCallsRecord.length > 0 ? JSON.stringify(toolCallsRecord) : undefined,
  };
}
