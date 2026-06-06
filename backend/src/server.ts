// server.ts — Express HTTP + SSE server
import { config } from "dotenv";
import path from "path";
config({ path: path.resolve(__dirname, "../.env"), override: true });
import express from "express";
import cors from "cors";
import { runAgent, sendEvent, type ConversationMessage } from "./agent";
import { type ReportMeta } from "./htmlGenerator";
import { generatePPTX } from "./pptxGenerator";
import { type CalcResult } from "./calculator";
import { getAuthUrl, exchangeCode, isAuthorized } from "./youtubeOAuth";
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
  reportMeta?: ReportMeta;      // persisted rich meta for section updates
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

// ---------------------------------------------------------------------------
// YouTube OAuth2 routes
// ---------------------------------------------------------------------------

/** Step 1 — redirect browser to Google consent screen */
app.get("/youtube/auth", (_req, res) => {
  res.redirect(getAuthUrl());
});

/** Step 2 — Google redirects here with ?code=… */
app.get("/youtube/callback", async (req, res) => {
  const code = req.query.code as string | undefined;
  if (!code) { res.status(400).send("Missing code parameter"); return; }
  try {
    await exchangeCode(code);
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
      body{font-family:'Inter',system-ui,sans-serif;background:#0d1117;color:#e6edf3;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
      .box{text-align:center;padding:40px;border:1px solid #30363d;border-radius:16px;background:#161b22}
      h2{color:#00b37e;font-size:28px;margin-bottom:12px} p{color:#8b949e;font-size:14px}
    </style></head><body><div class="box"><h2>✓ YouTube Connected</h2><p>Authorization successful. You can close this tab.</p></div></body></html>`);
  } catch (err) {
    logger.error({ err }, "YouTube callback error");
    res.status(500).send(`Authorization failed: ${String(err)}`);
  }
});

/** Status check for the frontend */
app.get("/youtube/status", (_req, res) => {
  res.json({ authorized: isAuthorized() });
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
  const list = Array.from(conversations.values())
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    .map((c) => {
      const firstUser = c.messages.find((m) => m.role === "user");
      return {
        id: c.id,
        title: firstUser?.content?.slice(0, 60) ?? "New conversation",
        messageCount: c.messages.length,
        hasReport: !!c.htmlReport,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      };
    });
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
      reportMeta: conv.reportMeta ?? null,
    });

    // Persist conversation
    conv.messages.push({ role: "user", content: message });
    conv.messages.push({ role: "assistant", content: result.assistantText });
    if (result.statsJson) conv.statsJson = result.statsJson;
    if (result.htmlReport) conv.htmlReport = result.htmlReport;
    if (result.meta) conv.reportMeta = result.meta;
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

/** GET messages for a conversation */
app.get("/conversations/:id/messages", (req, res) => {
  const id = parseInt(req.params.id);
  const conv = conversations.get(id);
  if (!conv) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  res.json({
    id: conv.id,
    messages: conv.messages,
    hasReport: !!conv.htmlReport,
    hasDraft: false,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
  });
});

/** GET the PPTX report for a conversation */
app.get("/conversations/:id/report.pptx", async (req, res) => {
  const id = parseInt(req.params.id);
  const conv = conversations.get(id);
  if (!conv?.statsJson || !conv?.reportMeta) {
    res.status(404).json({ error: "No report found — generate a report first" });
    return;
  }
  try {
    const calcResult = JSON.parse(conv.statsJson) as CalcResult;
    const buffer = await generatePPTX(conv.reportMeta, calcResult);
    const filename = `emerald-report-${new Date().toISOString().slice(0,10)}.pptx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    logger.error({ err }, "PPTX generation error");
    res.status(500).json({ error: String(err) });
  }
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
