// server.ts — Express HTTP + SSE server
import express from "express";
import cors from "cors";
import { runAgent, sendEvent, type ConversationMessage } from "./agent";
import { logger } from "./logger";

const app = express();
const PORT = process.env.PORT ?? 3001;

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(
  cors({
    origin: process.env.ALLOWED_ORIGIN ?? "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);
app.use(express.json({ limit: "2mb" }));

// ---------------------------------------------------------------------------
// In-memory conversation store (replace with DB for production)
// ---------------------------------------------------------------------------
interface ConversationRecord {
  id: number;
  messages: ConversationMessage[];
  statsJson?: string;
  htmlReport?: string;
  createdAt: Date;
  updatedAt: Date;
}

const conversations = new Map<number, ConversationRecord>();
let nextConvId = 1;

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** Health check */
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

/** Create a new conversation */
app.post("/conversations", (_req, res) => {
  const id = nextConvId++;
  conversations.set(id, {
    id,
    messages: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  res.json({ conversationId: id });
});

/** List conversations */
app.get("/conversations", (_req, res) => {
  const list = Array.from(conversations.values()).map((c) => ({
    id: c.id,
    messageCount: c.messages.length,
    hasReport: !!c.htmlReport,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  }));
  res.json(list);
});

/** Delete a conversation */
app.delete("/conversations/:id", (req, res) => {
  const id = parseInt(req.params.id);
  if (!conversations.has(id)) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  conversations.delete(id);
  res.json({ deleted: id });
});

/**
 * POST /conversations/:id/chat
 *
 * Body: { message: string }
 * Streams SSE events back:
 *   { type: "text", content: string }
 *   { type: "tool_start", tool: string, label: string }
 *   { type: "tool_done", tool: string }
 *   { type: "report_html", html: string }
 *   { type: "cost", inputTokens, outputTokens, costUsd }
 *   { type: "done", assistantText, inputTokens, outputTokens, costUsd }
 *   { type: "error", message: string }
 */
app.post("/conversations/:id/chat", async (req, res) => {
  const id = parseInt(req.params.id);
  const { message } = req.body as { message?: string };

  if (!message?.trim()) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  let conv = conversations.get(id);
  if (!conv) {
    // Auto-create if not found
    conv = {
      id,
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    conversations.set(id, conv);
  }

  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  try {
    const result = await runAgent({
      conversationId: id,
      userMessage: message,
      history: conv.messages,
      res,
      reportStatsJson: conv.statsJson ?? null,
    });

    // Persist conversation
    conv.messages.push({ role: "user", content: message });
    conv.messages.push({ role: "assistant", content: result.assistantText });
    if (result.statsJson) conv.statsJson = result.statsJson;
    if (result.htmlReport) conv.htmlReport = result.htmlReport;
    conv.updatedAt = new Date();

    sendEvent(res, {
      type: "done",
      assistantText: result.assistantText,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd: result.costUsd,
      hasReport: !!result.htmlReport,
    });
  } catch (err) {
    logger.error({ err }, "Agent error");
    sendEvent(res, { type: "error", message: String(err) });
  } finally {
    res.end();
  }
});

/** GET the latest HTML report for a conversation */
app.get("/conversations/:id/report", (req, res) => {
  const id = parseInt(req.params.id);
  const conv = conversations.get(id);
  if (!conv?.htmlReport) {
    res.status(404).json({ error: "No report found for this conversation" });
    return;
  }
  res.setHeader("Content-Type", "text/html");
  res.send(conv.htmlReport);
});

/** GET the stats JSON for a conversation */
app.get("/conversations/:id/stats", (req, res) => {
  const id = parseInt(req.params.id);
  const conv = conversations.get(id);
  if (!conv?.statsJson) {
    res.status(404).json({ error: "No stats found for this conversation" });
    return;
  }
  res.setHeader("Content-Type", "application/json");
  res.send(conv.statsJson);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  logger.info(`Emerald AI backend running on port ${PORT}`);
});

export default app;
