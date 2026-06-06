// agent.ts — Claude Sonnet agentic loop with tool use and SSE streaming
import type { Response } from "express";
import Anthropic from "@anthropic-ai/sdk";
import {
  anthropic,
  MODEL,
  COST_PER_INPUT_TOKEN,
  COST_PER_OUTPUT_TOKEN,
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
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are Emerald AI, an expert Air Quality Media Intelligence analyst. You help users generate, query, and update Air Quality Media Intelligence Reports for NGOs and research organisations.

You have access to tools to fetch live data and run precise calculations. Always use tools to back your analysis — never invent numbers.

## Intent routing
Classify the user's message as one of:
- GENERATE: They want a new full report. If orgs / outlets / date range / LLMs are missing, ask for them, then run all data-fetching tools followed by run_calculation and generate_report.
- QUERY: They have a question about an existing report. Answer from stats JSON / insights you have been given.
- ADD_STAT: They want to add/update a specific data point. Re-run run_calculation with updated data, then update_report_section.
- HELP: Explain what you can do.

## Default LLMs (use if not specified)
ChatGPT, Perplexity, Gemini

## Default outlets (use if not specified)
The Guardian, BBC, Reuters, AP News, Bloomberg

## Report sections (emit in this order)
Cover → Methodology → Social → Media → AEO → ActionMatrix → Scorecards → Sources

## Rules
- Always call run_calculation BEFORE generate_report. Never fabricate stats.
- When fetching social data, you MUST call both fetch_youtube and fetch_x_api.
- Pass the raw data from ALL fetch calls into run_calculation's raw_input.
- If data is missing or null, surface it honestly as "data not available".
- Be precise and concise — users are analysts, not novices.
- After generate_report, summarise 3 key insights in plain text.
- For date ranges, if the user says "last month" or similar, calculate from today.
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
          await fetchSerper(toolInput as Parameters<typeof fetchSerper>[0])
        );

      case "fetch_youtube":
        return JSON.stringify(
          await fetchYouTube(toolInput as Parameters<typeof fetchYouTube>[0])
        );

      case "fetch_x_api":
        return JSON.stringify(
          await fetchXApi(toolInput as Parameters<typeof fetchXApi>[0])
        );

      case "fetch_semrush":
        return JSON.stringify(
          await fetchSemrush(toolInput as Parameters<typeof fetchSemrush>[0])
        );

      case "fetch_llm_visibility":
        return JSON.stringify(
          await fetchLLMVisibility(
            toolInput as Parameters<typeof fetchLLMVisibility>[0]
          )
        );

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
        const { meta, stats_json } = toolInput as {
          meta: ReportMeta;
          stats_json: string;
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
        sendEvent(res, { type: "report_html", html });
        return JSON.stringify({ success: true, html_length: html.length });
      }

      case "update_report_section": {
        const { section, updated_stats_json, meta } = toolInput as {
          section: string;
          updated_stats_json: string;
          meta: ReportMeta;
        };
        let calcResult: ReturnType<typeof runCalculations>;
        try {
          calcResult = JSON.parse(updated_stats_json) as ReturnType<
            typeof runCalculations
          >;
        } catch {
          return JSON.stringify({ error: "Invalid updated_stats_json" });
        }
        const html = generateHTMLReport(meta, calcResult);
        store.htmlReport = html;
        sendEvent(res, { type: "report_html", html });
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
  toolCallsJson?: string;
}> {
  const { conversationId, userMessage, history, res } = opts;

  logger.info({ conversationId, userMessage }, "Agent started");

  const messages: Anthropic.MessageParam[] = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user" as const, content: userMessage },
  ];

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let assistantText = "";
  const store: ToolResultStore = {};
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
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages: iterMessages,
    });

    totalInputTokens += response.usage.input_tokens;
    totalOutputTokens += response.usage.output_tokens;

    sendEvent(res, {
      type: "cost",
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      costUsd: calcCost(totalInputTokens, totalOutputTokens),
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

      toolResults.push({
        type: "tool_result",
        tool_use_id: toolBlock.id,
        content: output,
      });
    }

    iterMessages = [
      ...iterMessages,
      { role: "assistant" as const, content: response.content },
      { role: "user" as const, content: toolResults },
    ];
  }

  const finalCostUsd = calcCost(totalInputTokens, totalOutputTokens);
  logger.info({ iterations, finalCostUsd }, "Agent finished");

  return {
    assistantText,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    costUsd: finalCostUsd,
    statsJson: store.statsJson,
    htmlReport: store.htmlReport,
    toolCallsJson:
      toolCallsRecord.length > 0 ? JSON.stringify(toolCallsRecord) : undefined,
  };
}
