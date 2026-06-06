import Anthropic from "@anthropic-ai/sdk";

export const MODEL = "claude-sonnet-4-20250514";

// Cost per token (USD) — Sonnet 4
export const COST_PER_INPUT_TOKEN = 3 / 1_000_000;
export const COST_PER_OUTPUT_TOKEN = 15 / 1_000_000;

if (!process.env.ANTHROPIC_API_KEY) {
  throw new Error("ANTHROPIC_API_KEY environment variable is required");
}

export const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export function calcCost(inputTokens: number, outputTokens: number): number {
  return (
    inputTokens * COST_PER_INPUT_TOKEN + outputTokens * COST_PER_OUTPUT_TOKEN
  );
}
