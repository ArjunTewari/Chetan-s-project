// server.ts — Express HTTP + SSE server (PostgreSQL-backed)
import { config } from "dotenv";
import path from "path";
config({ path: path.resolve(__dirname, "../.env") });
import express from "express";
import cors from "cors";
import { runAgent, sendEvent, type ConversationMessage } from "./agent";
import { type ReportMeta } from "./htmlGenerator";
import { generatePPTX } from "./pptxGenerator";
import { type CalcResult } from "./calculator";
import { getAuthUrl, exchangeCode, isAuthorized } from "./youtubeOAuth";
import { logger } from "./logger";
import { pool, initSchema } from "./db";

const app = express();
const PORT = process.env.PORT ?? 3001;

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(
  cors({
    origin: process.env.ALLOWED_ORIGIN ?? "*",
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);
app.use(express.json({ limit: "2mb" }));

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function getConversationMessages(convId: number): Promise<ConversationMessage[]> {
  const result = await pool.query(
    "SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY id ASC",
    [convId]
  );
  return result.rows as ConversationMessage[];
}

async function getConversationReport(convId: number): Promise<{
  htmlReport: string | null;
  statsJson: string | null;
  reportMeta: ReportMeta | null;
  reportSummary: string | null;
} | null> {
  const result = await pool.query(
    "SELECT html_report, stats_json, report_meta, report_summary FROM reports WHERE conversation_id = $1",
    [convId]
  );
  if (result.rows.length === 0) return { htmlReport: null, statsJson: null, reportMeta: null, reportSummary: null };
  const row = result.rows[0];
  return {
    htmlReport: row.html_report ?? null,
    statsJson: row.stats_json ?? null,
    reportMeta: row.report_meta ?? null,
    reportSummary: row.report_summary ?? null,
  };
}

async function upsertReport(
  convId: number,
  htmlReport: string | null,
  statsJson: string | null,
  reportMeta: ReportMeta | null,
  reportSummary: string | null
): Promise<void> {
  const orgs: string[] = reportMeta?.orgs ?? [];
  const dateFrom: string = (reportMeta?.date_range as { from?: string } | undefined)?.from ?? "";
  const dateTo: string = (reportMeta?.date_range as { to?: string } | undefined)?.to ?? "";

  await pool.query(
    `INSERT INTO reports (conversation_id, html_report, stats_json, report_meta, report_summary, orgs, date_from, date_to, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
     ON CONFLICT (conversation_id) DO UPDATE SET
       html_report      = EXCLUDED.html_report,
       stats_json       = EXCLUDED.stats_json,
       report_meta      = EXCLUDED.report_meta,
       report_summary   = EXCLUDED.report_summary,
       orgs             = EXCLUDED.orgs,
       date_from        = EXCLUDED.date_from,
       date_to          = EXCLUDED.date_to,
       updated_at       = NOW()`,
    [convId, htmlReport, statsJson, reportMeta ? JSON.stringify(reportMeta) : null, reportSummary, orgs, dateFrom, dateTo]
  );
}

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

app.get("/youtube/auth", (_req, res) => {
  res.redirect(getAuthUrl());
});

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

app.get("/youtube/status", (_req, res) => {
  res.json({ authorized: isAuthorized() });
});

// ---------------------------------------------------------------------------
// Conversation routes
// ---------------------------------------------------------------------------

/** Create a new conversation */
app.post("/conversations", async (_req, res) => {
  try {
    const result = await pool.query(
      "INSERT INTO conversations DEFAULT VALUES RETURNING id"
    );
    const id: number = result.rows[0].id;
    res.json({ conversationId: id });
  } catch (err) {
    logger.error({ err }, "Failed to create conversation");
    res.status(500).json({ error: "Failed to create conversation" });
  }
});

/** List conversations with report metadata */
app.get("/conversations", async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        c.id,
        c.created_at,
        c.updated_at,
        COUNT(m.id)::int AS message_count,
        (SELECT content FROM messages WHERE conversation_id = c.id AND role = 'user' ORDER BY id ASC LIMIT 1) AS first_user_msg,
        r.orgs,
        r.date_from,
        r.date_to,
        (r.id IS NOT NULL AND r.html_report IS NOT NULL) AS has_report
      FROM conversations c
      LEFT JOIN messages m ON m.conversation_id = c.id
      LEFT JOIN reports r ON r.conversation_id = c.id
      GROUP BY c.id, c.created_at, c.updated_at, r.id, r.orgs, r.date_from, r.date_to, r.html_report
      ORDER BY c.updated_at DESC
    `);

    const list = result.rows.map((row) => {
      const orgs: string[] = row.orgs ?? [];
      const hasReport: boolean = row.has_report ?? false;
      const firstMsg: string = row.first_user_msg ?? "";

      let title: string;
      if (hasReport && orgs.length > 0) {
        const dateRange = row.date_from && row.date_to
          ? ` | ${row.date_from} – ${row.date_to}`
          : "";
        title = orgs.join(", ") + dateRange;
      } else {
        title = firstMsg.slice(0, 60) || "New conversation";
      }

      return {
        id: row.id,
        title,
        messageCount: row.message_count,
        hasReport,
        orgs,
        dateFrom: row.date_from ?? null,
        dateTo: row.date_to ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });

    res.json(list);
  } catch (err) {
    logger.error({ err }, "Failed to list conversations");
    res.status(500).json({ error: "Failed to list conversations" });
  }
});

/** Delete a conversation */
app.delete("/conversations/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const check = await pool.query("SELECT id FROM conversations WHERE id = $1", [id]);
    if (check.rows.length === 0) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    await pool.query("DELETE FROM conversations WHERE id = $1", [id]);
    res.json({ deleted: id });
  } catch (err) {
    logger.error({ err }, "Failed to delete conversation");
    res.status(500).json({ error: "Failed to delete conversation" });
  }
});

/** Chat endpoint — streams SSE */
app.post("/conversations/:id/chat", async (req, res) => {
  const id = parseInt(req.params.id);
  const { message } = req.body as { message?: string };

  if (!message?.trim()) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  try {
    // Ensure conversation exists (auto-create if missing)
    const convCheck = await pool.query("SELECT id FROM conversations WHERE id = $1", [id]);
    if (convCheck.rows.length === 0) {
      await pool.query("INSERT INTO conversations (id) VALUES ($1)", [id]);
    }

    // Load history and existing report data
    const history = await getConversationMessages(id);
    const reportData = await getConversationReport(id);

    // Set SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const result = await runAgent({
      conversationId: id,
      userMessage: message,
      history,
      res,
      reportStatsJson: reportData?.statsJson ?? null,
      reportMeta: reportData?.reportMeta ?? null,
      reportSummary: reportData?.reportSummary ?? null,
    });

    // Persist user + assistant messages
    await pool.query(
      "INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)",
      [id, "user", message]
    );
    await pool.query(
      "INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)",
      [id, "assistant", result.assistantText]
    );

    // Persist report if generated/updated
    if (result.htmlReport || result.statsJson || result.meta) {
      await upsertReport(
        id,
        result.htmlReport ?? reportData?.htmlReport ?? null,
        result.statsJson ?? reportData?.statsJson ?? null,
        result.meta ?? reportData?.reportMeta ?? null,
        result.reportSummary ?? reportData?.reportSummary ?? null
      );
    }

    // Update conversation updated_at
    await pool.query("UPDATE conversations SET updated_at = NOW() WHERE id = $1", [id]);

    sendEvent(res, {
      type: "done",
      assistantText: result.assistantText,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd: result.costUsd,
      hasReport: !!(result.htmlReport ?? reportData?.htmlReport),
    });
  } catch (err) {
    logger.error({ err }, "Agent error");
    sendEvent(res, { type: "error", message: String(err) });
  } finally {
    res.end();
  }
});

/** GET the latest HTML report for a conversation */
app.get("/conversations/:id/report", async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const result = await pool.query(
      "SELECT html_report FROM reports WHERE conversation_id = $1",
      [id]
    );
    if (result.rows.length === 0 || !result.rows[0].html_report) {
      res.status(404).json({ error: "No report found for this conversation" });
      return;
    }
    res.setHeader("Content-Type", "text/html");
    res.send(result.rows[0].html_report);
  } catch (err) {
    logger.error({ err }, "Failed to fetch report");
    res.status(500).json({ error: "Failed to fetch report" });
  }
});

/** GET messages for a conversation */
app.get("/conversations/:id/messages", async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const convCheck = await pool.query(
      "SELECT id, created_at, updated_at FROM conversations WHERE id = $1",
      [id]
    );
    if (convCheck.rows.length === 0) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    const messages = await getConversationMessages(id);
    const reportData = await getConversationReport(id);
    res.json({
      id,
      messages,
      hasReport: !!(reportData?.htmlReport),
      hasDraft: false,
      createdAt: convCheck.rows[0].created_at,
      updatedAt: convCheck.rows[0].updated_at,
    });
  } catch (err) {
    logger.error({ err }, "Failed to fetch messages");
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

/** GET the PPTX report for a conversation */
app.get("/conversations/:id/report.pptx", async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const result = await pool.query(
      "SELECT stats_json, report_meta FROM reports WHERE conversation_id = $1",
      [id]
    );
    if (result.rows.length === 0 || !result.rows[0].stats_json || !result.rows[0].report_meta) {
      res.status(404).json({ error: "No report found — generate a report first" });
      return;
    }
    const calcResult = JSON.parse(result.rows[0].stats_json) as CalcResult;
    const reportMeta = result.rows[0].report_meta as ReportMeta;
    const buffer = await generatePPTX(reportMeta, calcResult);
    const filename = `emerald-report-${new Date().toISOString().slice(0, 10)}.pptx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    logger.error({ err }, "PPTX generation error");
    res.status(500).json({ error: String(err) });
  }
});

/** GET the stats JSON for a conversation */
app.get("/conversations/:id/stats", async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const result = await pool.query(
      "SELECT stats_json FROM reports WHERE conversation_id = $1",
      [id]
    );
    if (result.rows.length === 0 || !result.rows[0].stats_json) {
      res.status(404).json({ error: "No stats found for this conversation" });
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.send(result.rows[0].stats_json);
  } catch (err) {
    logger.error({ err }, "Failed to fetch stats");
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
initSchema()
  .then(() => {
    app.listen(PORT, () => {
      logger.info(`Emerald AI backend running on port ${PORT}`);
    });
  })
  .catch((err) => {
    logger.error({ err }, "Failed to initialise database schema");
    process.exit(1);
  });

export default app;
