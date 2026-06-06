import { config } from "dotenv";
import path from "path";
config({ path: path.resolve(__dirname, "../.env"), override: true });
import Anthropic from "@anthropic-ai/sdk";

export const MODEL = "claude-sonnet-4-20250514";

// Cost per token (USD) — Sonnet 4
export const COST_PER_INPUT_TOKEN        = 3.00  / 1_000_000;
export const COST_PER_OUTPUT_TOKEN       = 15.00 / 1_000_000;
export const COST_PER_CACHE_WRITE_TOKEN  = 3.75  / 1_000_000; // +25% on first write
export const COST_PER_CACHE_READ_TOKEN   = 0.30  / 1_000_000; // −90% on subsequent reads

if (!process.env.ANTHROPIC_API_KEY) {
  throw new Error("ANTHROPIC_API_KEY environment variable is required");
}

export const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export function calcCost(
  inputTokens: number,
  outputTokens: number,
  cacheWriteTokens = 0,
  cacheReadTokens = 0,
): number {
  return (
    inputTokens        * COST_PER_INPUT_TOKEN +
    outputTokens       * COST_PER_OUTPUT_TOKEN +
    cacheWriteTokens   * COST_PER_CACHE_WRITE_TOKEN +
    cacheReadTokens    * COST_PER_CACHE_READ_TOKEN
  );
}
