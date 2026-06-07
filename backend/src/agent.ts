// agent.ts — Claude Sonnet agentic loop with tool use and SSE streaming
import type { Response } from "express";
import Anthropic from "@anthropic-ai/sdk";
import {
  anthropic,
  MODEL,
  calcCost,
} from "./anthropicClient";
import { runCalculations, type RawInput } from "./calculator";
import { generateHTMLReport, type ReportMeta, type ToneEvidenceItem, type YouTubeChannelData, type ReportTemplate } from "./htmlGenerator";
import {
  fetchSerper,
  fetchYouTube,
  fetchXApi,
  fetchInstagram,
  fetchLinkedIn,
  fetchSemrush,
  fetchLLMVisibility,
  fetchCommentSentiment,
  fetchWikipedia,
  type CommentSentimentResult,
  type WikipediaInfo,
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
  /** Summary of the last generated report — injected into the system prompt for QUERY intent */
  reportSummary?: string | null;
  /** Report template — controls which sections appear and their titles/descriptions */
  reportTemplate?: ReportTemplate | null;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------
function getSystemPrompt(reportSummary?: string | null): string {
  const today = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const summaryBlock = reportSummary
    ? `\n## Stored report summary (for answering queries about this report)\n${reportSummary}\n`
    : "";
  return `Today's date is ${today}. Use this as your reference for all date calculations and when deciding what counts as historical vs. future data.

You are Emerald AI, an expert Air Quality Media Intelligence analyst. You help users generate, query, and update Air Quality Media Intelligence Reports for NGOs and research organisations.

You have access to tools to fetch live data and run precise calculations. Always use tools to back your analysis — never invent numbers.
${summaryBlock}
## Intent routing
Classify the user's message as one of:
- GENERATE: They want a new full report. If orgs / outlets / date range / LLMs are missing, ask for them, then follow the GENERATE workflow below.
- QUERY: They have a question about an existing report. Answer from the Stored report summary above. Do NOT use tools for queries unless the user explicitly asks for updated data.
- ADD_STAT: They want to add/update a specific data point. Re-run run_calculation with updated data, then update_report_section.
- APPROVE: They are approving the draft (e.g. "looks good", "generate the report", "approve"). Call generate_report using stored stats + meta.
- HELP: Explain what you can do.

## Default LLMs (use if not specified)
ChatGPT, Perplexity, Gemini

## Default outlets (use if not specified)
Hindustan Times, The Times of India, The Hindu, NDTV, News18, India Today

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

## ⚠️ CRITICAL OUTPUT RULE — READ FIRST
NEVER write a report, summary table, or analysis as plain text.
The ONLY valid way to deliver a report is by calling the generate_report tool.
If you are about to type headings, bullet points, or data tables into a text response after collecting tool data — STOP and call run_calculation then present_draft instead.
Violating this rule means the user cannot view, download, or interact with the report.

## GENERATE workflow — follow this order exactly
1. Fetch all data IN PARALLEL where possible: fetch_serper, fetch_youtube, fetch_x_api, fetch_instagram, fetch_linkedin, fetch_llm_visibility
2. After ALL fetches are done, call fetch_comment_sentiment
3. Check data quality: if ANY org has total media mentions < 5, also call fetch_wikipedia for all orgs
4. Call run_calculation with ALL the fetched data — this is MANDATORY, never skip it
5. Call present_draft with the calc results — STOP after this tool call, do not write any text
6. Wait for the user to approve
7. When user approves → immediately call generate_report (pass all stored data including wiki_data if available)
8. After generate_report succeeds, write exactly 3 key insights as a short plain-text note (50 words max)

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
- NEVER write report content (metrics, tables, analysis) as plain text — always use tools.
- NEVER call generate_report immediately after run_calculation. Always go through present_draft first.
- After all data-fetch tools complete, your immediate next call MUST be run_calculation — no text response in between.
- After run_calculation, your immediate next call MUST be present_draft — no text response in between.
- Call BOTH fetch_youtube AND fetch_x_api for social data.
- Call fetch_instagram with org Instagram handles (e.g. @ceew_india) and query_keywords matching the topic. If the handle is unknown, use the org name as the handle — the fetcher will search by org name. source='not_found' means the org has no indexed Instagram presence; mark the row as "handle not confirmed" in the report.
- Call fetch_linkedin with org LinkedIn company slugs or names and query_keywords. source='not_found' means no indexed LinkedIn presence; mark as "handle not confirmed".
- fetch_instagram returns: { data: { [handle]: { platform, impressions, likes, comments, saves, indexed_posts, source } } }
- fetch_linkedin returns: { data: { [handle]: { platform, impressions, likes, shares, comments, indexed_posts, source } } }
→ Add Instagram entry from fetch_instagram as: { org, platform: "Instagram", impressions, likes, shares: 0, comments, saves, quote_rt: 0 }
→ Add LinkedIn entry from fetch_linkedin as: { org, platform: "LinkedIn", impressions, likes, shares, comments, saves: 0, quote_rt: 0 }
→ If source = "not_found", still add the row but set all metrics to 0 so the report shows the platform with "(handle not confirmed)" label.
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
}

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
    name: "fetch_instagram",
    description:
      "Fetch Instagram engagement metrics (impressions, likes, comments, saves) for org handles via Serper search. Meta Graph API is owner-only; this uses Google-indexed Instagram posts as a proxy. Returns estimated metrics with source='serper_instagram_posts' or 'not_found'. Pass handles as @slug or plain slug, e.g. '@ceew_india'.",
    input_schema: {
      type: "object" as const,
      properties: {
        handles: { type: "array", items: { type: "string" }, description: "Instagram handles, e.g. ['@ceew_india', '@cstep_india']" },
        orgs:    { type: "array", items: { type: "string" }, description: "Org names matching handles order, e.g. ['CEEW', 'CSTEP']" },
        date_range: {
          type: "object",
          properties: { from: { type: "string" }, to: { type: "string" } },
          required: ["from", "to"],
        },
        query_keywords: { type: "array", items: { type: "string" }, description: "Topic keywords e.g. ['air quality', 'AQI', 'pollution']" },
      },
      required: ["handles", "orgs", "date_range", "query_keywords"],
    },
  },
  {
    name: "fetch_linkedin",
    description:
      "Fetch LinkedIn engagement metrics (impressions, likes/reactions, shares, comments) for org pages via Serper search. LinkedIn API is owner-only; this uses Google-indexed LinkedIn posts as a proxy. Returns estimated metrics with source='serper_linkedin_posts' or 'not_found'. Pass handles as company slug or org name.",
    input_schema: {
      type: "object" as const,
      properties: {
        handles: { type: "array", items: { type: "string" }, description: "LinkedIn company slugs or org names, e.g. ['ceew-council-on-energy', 'cstep-india']" },
        orgs:    { type: "array", items: { type: "string" }, description: "Org names matching handles order, e.g. ['CEEW', 'CSTEP']" },
        date_range: {
          type: "object",
          properties: { from: { type: "string" }, to: { type: "string" } },
          required: ["from", "to"],
        },
        query_keywords: { type: "array", items: { type: "string" }, description: "Topic keywords e.g. ['air quality', 'AQI', 'pollution']" },
      },
      required: ["handles", "orgs", "date_range", "query_keywords"],
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
        meta: {
          type: "object",
          description: "Report metadata (pass the full meta object from the original report)",
        },
        stats_json: {
          type: "string",
          description: "Updated stats JSON string (or pass the original if only metadata changed)",
        },
        section: {
          type: "string",
          description: "Section name: social, media, aeo, scorecards, action_matrix",
        },
      },
      required: ["meta", "stats_json", "section"],
    },
  },
];

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------
interface AgentState {
  reportSummary?: string;
  meta: ReportMeta;
  statsJson: string;
  htmlReport: string;
  toolCalls: Record<string, number>;
  toolCallsRecord: { tool: string; input: Record<string, unknown>; output: Record<string, unknown> }[];
}

// ---------------------------------------------------------------------------
// Run agent
// ---------------------------------------------------------------------------
export async function runAgent({
  conversationId,
  userMessage,
  history,
  res,
  reportStatsJson,
  reportMeta,
  reportSummary,
  reportTemplate,
}: AgentOptions) {
  logger.info(
    { conversationId, userMessage },
    "agent run start"
  );

  const store: AgentState = {
    meta: reportMeta ?? {
      orgs: [],
      date_range: { from: "", to: "" },
      outlets: [],
      llms: [],
    },
    statsJson: reportStatsJson ?? "",
    htmlReport: "",
    toolCalls: {},
    toolCallsRecord: [],
  };

  // If reportMeta is provided but statsJson is empty, build an empty stats JSON
  if (reportMeta && !reportStatsJson) {
    const emptyStats = {
      success: true,
      social: [],
      media: [],
      aeo: [],
      scorecards: [],
      action_matrix: [],
    };
    store.statsJson = JSON.stringify(emptyStats);
  }

  // Helper: build tool execution
  const executeTool = async (name: string, input: Record<string, unknown>): Promise<Record<string, unknown>> => {
    store.toolCalls[name] = (store.toolCalls[name] ?? 0) + 1;
    logger.info({ tool: name, input }, "Tool call");

    switch (name) {
      case "fetch_serper": {
        const result = await fetchSerper(input as any);
        const returnObj: Record<string, unknown> = {
          stub: result.stub,
          data: result.data,
          tone_evidence: (result as any).tone_evidence,
          serper_requests: (result as any).serper_requests,
        };
        if ((result as any).data_quality) {
          returnObj.data_quality = (result as any).data_quality;
        }
        return returnObj;
      }
      case "fetch_youtube": {
        const result = await fetchYouTube(input as any);
        return { stub: result.stub, data: result.data };
      }
      case "fetch_x_api": {
        const result = await fetchXApi(input as any);
        return { stub: result.stub, data: result.data };
      }
      case "fetch_instagram": {
        const result = await fetchInstagram(input as any);
        return { stub: result.stub, data: result.data };
      }
      case "fetch_linkedin": {
        const result = await fetchLinkedIn(input as any);
        return { stub: result.stub, data: result.data };
      }
      case "fetch_semrush": {
        const result = await fetchSemrush(input as any);
        return { stub: result.stub, data: result.data };
      }
      case "fetch_llm_visibility": {
        const result = await fetchLLMVisibility(input as any);
        return {
          stub: result.stub,
          data: result.data,
          costs: result.costs,
          query_results: result.query_results,
        };
      }
      case "fetch_wikipedia": {
        const result = await fetchWikipedia((input as any).orgs as string[]);
        return { data: result.data };
      }
      case "fetch_comment_sentiment": {
        const result = await fetchCommentSentiment((input as any).org_video_pairs as any);
        return { data: result.data };
      }
      case "run_calculation": {
        const raw = (input as any).raw_input as RawInput;
        const result = runCalculations(raw);
        store.statsJson = JSON.stringify(result);
        return { stats: result };
      }
      case "present_draft": {
        const meta = (input as any).meta as ReportMeta;
        const statsJson = (input as any).stats_json as string;
        const summary = (input as any).summary as string;

        store.meta = meta;
        store.statsJson = statsJson;
        store.reportSummary = summary;

        // Build a summary of the draft for the LLM to display
        const stats = JSON.parse(statsJson) as {
          success: boolean;
          sanity_errors?: string[];
          social?: any[];
          media?: any[];
          aeo?: any[];
          scorecards?: any[];
          action_matrix?: any[];
        };

        const socialLines = (stats.social ?? []).map(
          (s: any) => `${s.org} · ${s.platform}: ${s.impressions?.toLocaleString()} impressions, ER ${s.er_pct}%`
        );
        const mediaLines = (stats.media ?? []).map(
          (m: any) => `${m.org}: ${m.total_mentions} mentions, ${m.dofollow_links} dofollow, ${m.direct_cites} direct cites, ${m.aligned_tone_pct}% authoritative tone`
        );
        const aeoLines = (stats.aeo ?? []).map(
          (a: any) => `${a.org} · ${a.llm}: ${a.mention_count}/20, avg pos ${a.avg_position}, citation ${a.citation_type}, tier ${a.visibility_tier}`
        );
        const scorecardLines = (stats.scorecards ?? []).map(
          (sc: any) => `${sc.org}: ${sc.grade} (${sc.overall_score}/100) — Social ${sc.social_score} · Media ${sc.media_score} · AEO ${sc.aeo_score}`
        );
        const actionLines = (stats.action_matrix ?? []).slice(0, 4).map(
          (a: any) => `${a.org} · ${a.priority}: ${a.action}`
        );

        const draft = `📝 **DRAFT — Review Before Generating Report**

${summary}

**Social Media:**
${socialLines.length ? socialLines.join("\n") : "No social data"}

**Media Coverage:**
${mediaLines.length ? mediaLines.join("\n") : "No media data"}

**AEO / LLM Visibility:**
${aeoLines.length ? aeoLines.join("\n") : "No AEO data"}

**Scorecards:**
${scorecardLines.length ? scorecardLines.join("\n") : "No scorecards"}

**Top Actions:**
${actionLines.length ? actionLines.join("\n") : "No action matrix"}

${stats.sanity_errors?.length ? `\n⚠️ **Sanity checks:**\n${stats.sanity_errors.join("\n")}` : ""}

Type "generate" or "approve" to produce the final HTML report.`;

        sendEvent(res, {
          type: "draft",
          content: draft,
          meta: meta,
          statsJson: statsJson,
        });

        return { success: true };
      }
      case "generate_report": {
        const meta = (input as any).meta as ReportMeta;
        const statsJson = (input as any).stats_json as string;
        const stats = JSON.parse(statsJson) as any;

        store.meta = meta;
        store.statsJson = statsJson;

        const html = generateHTMLReport(meta, stats, reportTemplate ?? undefined);
        store.htmlReport = html;

        // Build summary
        const summary = buildReportSummary(meta, stats);
        store.reportSummary = summary;

        sendEvent(res, {
          type: "report",
          html,
          summary,
          meta: meta,
          statsJson: statsJson,
        });

        return { success: true, html, summary };
      }
      case "update_report_section": {
        const meta = (input as any).meta as ReportMeta;
        const statsJson = (input as any).stats_json as string;
        const section = (input as any).section as string;
        const stats = JSON.parse(statsJson) as any;

        const html = generateHTMLReport(meta, stats, reportTemplate ?? undefined);
        store.htmlReport = html;

        sendEvent(res, {
          type: "report",
          html,
          meta: meta,
          statsJson: statsJson,
        });

        return { success: true, html };
      }
      default:
        return { error: "Unknown tool" };
    }
  };

  // Build messages
  const systemPrompt = getSystemPrompt(reportSummary);
  const messages: Anthropic.MessageParam[] = [
    ...history.map(
      (h): Anthropic.MessageParam => ({
        role: h.role,
        content: h.content,
      })
    ),
    { role: "user", content: userMessage },
  ];

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheWriteTokens = 0;
  let totalCacheReadTokens = 0;

  const MAX_ITERATIONS = 8;
  let iterMessages = messages;
  let assistantText = "";
  let iterations = 0;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    iterations++;
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages: iterMessages,
      tools: TOOLS,
      tool_choice: { type: "auto" },
    });

    totalInputTokens += response.usage.input_tokens;
    totalOutputTokens += response.usage.output_tokens;
    totalCacheWriteTokens += (response.usage as any).cache_creation_input_tokens ?? 0;
    totalCacheReadTokens += (response.usage as any).cache_read_input_tokens ?? 0;

    const toolBlocks = response.content.filter(
      (c): c is Anthropic.ToolUseBlock => c.type === "tool_use"
    );
    const textBlocks = response.content.filter(
      (c): c is Anthropic.TextBlock => c.type === "text"
    );

    // If no tools, we are done
    if (!toolBlocks.length) {
      assistantText = textBlocks.map((t) => t.text).join("");
      break;
    }

    // If there are text blocks and tools, stream the text first
    if (textBlocks.length) {
      const text = textBlocks.map((t) => t.text).join("");
      if (text.trim()) {
        sendEvent(res, { type: "text", content: text });
      }
    }

    // Execute all tool calls in parallel
    const toolResults: {
      type: "tool_result";
      tool_use_id: string;
      content: string;
    }[] = [];

    await Promise.all(
      toolBlocks.map(async (toolBlock) => {
        const toolInput = toolBlock.input as Record<string, unknown>;
        const output = await executeTool(toolBlock.name, toolInput);
        const outputStr = JSON.stringify(output);

        store.toolCallsRecord.push({
          tool: toolBlock.name,
          input: toolInput,
          output: JSON.parse(outputStr),
        });

        // Truncate large tool outputs before appending to the context window
        const MAX_TOOL_RESULT_CHARS = 6_000;
        const contextOutput =
          outputStr.length > MAX_TOOL_RESULT_CHARS
            ? outputStr.slice(0, MAX_TOOL_RESULT_CHARS) + "…[truncated — full data used by generator]"
            : outputStr;

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolBlock.id,
          content: contextOutput,
        });
      })
    );

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
    reportSummary: store.reportSummary,
    toolCallsJson:
      store.toolCallsRecord.length > 0 ? JSON.stringify(store.toolCallsRecord) : undefined,
  };
}

function buildReportSummary(meta: ReportMeta, stats: any): string {
  const orgs = meta.orgs.join(", ");
  const dateRange = `${meta.date_range.from} to ${meta.date_range.to}`;
  const outlets = meta.outlets.join(", ");
  const llms = meta.llms.join(", ");

  const social = (stats.social ?? []).map(
    (s: any) => `${s.org} ${s.platform}: ${s.impressions} impressions, ER ${s.er_pct}%`
  );
  const media = (stats.media ?? []).map(
    (m: any) => `${m.org}: ${m.total_mentions} mentions, ${m.dofollow_links} dofollow, ${m.direct_cites} direct cites`
  );
  const aeo = (stats.aeo ?? []).map(
    (a: any) => `${a.org} ${a.llm}: ${a.mention_count}/20, pos ${a.avg_position}, ${a.citation_type}, ${a.visibility_tier}`
  );
  const scorecards = (stats.scorecards ?? []).map(
    (sc: any) => `${sc.org}: ${sc.grade} (${sc.overall_score}/100)`
  );

  return `Air Quality Media Intelligence Report for ${orgs} (${dateRange}).
Outlets: ${outlets}. LLMs: ${llms}.

Social: ${social.join("; ")}
Media: ${media.join("; ")}
AEO: ${aeo.join("; ")}
Scorecards: ${scorecards.join("; ")}`;
}
