import { useState, useRef, useEffect, useCallback } from "react";
import "./animations.css";

// ─── Config ────────────────────────────────────────────────────────────────
const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3001";

// ─── Types ─────────────────────────────────────────────────────────────────
type Role = "user" | "assistant" | "system";

interface Message {
  id: string;
  role: Role;
  content: string;
  toolEvents?: ToolEvent[];
  hasReport?: boolean;
  hasDraft?: boolean;
  cost?: { inputTokens: number; outputTokens: number; costUsd: number };
}

interface ToolEvent {
  tool: string;
  label: string;
  status: "running" | "done";
}

interface ConvListItem {
  id: number;
  title: string;
  messageCount: number;
  hasReport: boolean;
  createdAt: string;
  updatedAt: string;
}

// Minimal shape of what we need from CalcResult for the review panel
interface DraftStats {
  scorecards: Array<{ org: string; overall_score: number; grade: string; social_score: number; media_score: number; aeo_score: number }>;
  action_matrix: Array<{ org: string; priority: string; area: string; action: string; rationale: string }>;
  social: Array<{ org: string; platform: string; impressions: number; er_pct: number }>;
  media: Array<{ org: string; total_mentions: number; dofollow_links: number; aligned_tone_pct: number }>;
  aeo: Array<{ org: string; llm: string; mention_count: number; mention_rate_pct: number; visibility_tier: string }>;
  sanity_errors?: string[];
}

interface DraftPayload {
  meta: Record<string, unknown>;
  stats: DraftStats;
  stats_json: string;
  summary: string;
}

// ─── Helpers ───────────────────────────────────────────────────────────────
const uid = () => Math.random().toString(36).slice(2, 9);

const TOOL_ICONS: Record<string, string> = {
  fetch_serper: "📰",
  fetch_youtube: "▶️",
  fetch_x_api: "𝕏",
  fetch_semrush: "🔗",
  fetch_llm_visibility: "🤖",
  run_calculation: "🔢",
  generate_report: "📊",
  update_report_section: "✏️",
};

// ─── Component ─────────────────────────────────────────────────────────────
export default function App() {
  const [convId, setConvId] = useState<number | null>(null);
  const [messages, setMessages] = useState<Message[]>([
    {
      id: uid(),
      role: "system",
      content:
        "Welcome to **Emerald AI** — Air Quality Media Intelligence.\n\nTell me which organisations and date range you want to analyse, and I'll generate a full report. Or ask me anything about a report you've already generated.",
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [welcomeExiting, setWelcomeExiting] = useState(false);
  const [welcomeGone, setWelcomeGone] = useState(false);
  const [reportHtml, setReportHtml] = useState<string | null>(null);
  const [showReport, setShowReport] = useState(false);
  const [reportUpdated, setReportUpdated] = useState(false);
  const [draftPayload, setDraftPayload] = useState<DraftPayload | null>(null); // pre-approval review
  const [showDraft, setShowDraft] = useState(false);
  const [editDraft, setEditDraft] = useState("");
  const [sessionCost, setSessionCost] = useState({ claude: 0, llm: 0, serper: 0 });
  const [ytStatus, setYtStatus] = useState<"unknown" | "connected" | "disconnected">("unknown");
  const [convList, setConvList] = useState<ConvListItem[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Fade out welcome on first user message
  const hasUserMessages = messages.some((m) => m.role === "user");
  useEffect(() => {
    if (hasUserMessages && !welcomeExiting && !welcomeGone) {
      setWelcomeExiting(true);
      const t = setTimeout(() => setWelcomeGone(true), 450);
      return () => clearTimeout(t);
    }
  }, [hasUserMessages, welcomeExiting, welcomeGone]);

  // Auto-scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height =
        Math.min(textareaRef.current.scrollHeight, 160) + "px";
    }
  }, [input]);

  // Check YouTube auth status
  useEffect(() => {
    const check = () =>
      fetch(`${API_BASE}/youtube/status`)
        .then((r) => r.json())
        .then((d) => setYtStatus(d.authorized ? "connected" : "disconnected"))
        .catch(() => setYtStatus("disconnected"));
    check();
    const interval = setInterval(check, 10_000); // re-check every 10s
    return () => clearInterval(interval);
  }, []);

  // Poll conversation list
  const refreshConvList = useCallback(() => {
    fetch(`${API_BASE}/conversations`)
      .then((r) => r.json())
      .then((list) => setConvList(list as ConvListItem[]))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshConvList();
    const interval = setInterval(refreshConvList, 8_000);
    return () => clearInterval(interval);
  }, [refreshConvList]);

  // Create conversation on mount
  useEffect(() => {
    fetch(`${API_BASE}/conversations`, { method: "POST" })
      .then((r) => r.json())
      .then((d) => { setConvId(d.conversationId); refreshConvList(); })
      .catch(() => setConvId(1));
  }, [refreshConvList]);

  // Load an existing conversation by ID
  const loadConversation = useCallback(async (id: number) => {
    if (id === convId) return;
    try {
      const data = await fetch(`${API_BASE}/conversations/${id}/messages`).then((r) => r.json()) as {
        messages: { role: "user" | "assistant"; content: string }[];
        hasReport: boolean;
      };
      setConvId(id);
      setMessages([
        {
          id: uid(), role: "system",
          content: "Welcome to **Emerald AI** — Air Quality Media Intelligence.\n\nTell me which organisations and date range you want to analyse, and I'll generate a full report. Or ask me anything about a report you've already generated.",
        },
        ...data.messages.map((m) => ({ id: uid(), role: m.role, content: m.content })),
      ]);
      // Clear transient state
      setReportHtml(null);
      setShowReport(false);
      setDraftPayload(null);
      setShowDraft(false);
      setSessionCost({ claude: 0, llm: 0, serper: 0 });
      setEditDraft("");
      // Reset welcome state based on whether loaded conv has user messages
      if (data.messages.some((m) => m.role === "user")) {
        setWelcomeExiting(false); setWelcomeGone(true);
      } else {
        setWelcomeExiting(false); setWelcomeGone(false);
      }
      // If the conversation has a report, fetch the HTML
      if (data.hasReport) {
        const html = await fetch(`${API_BASE}/conversations/${id}/report`).then((r) => r.text()).catch(() => null);
        if (html) setReportHtml(html);
      }
    } catch { /* ignore */ }
  }, [convId]);

  // Start a new conversation
  const startNewConversation = useCallback(async () => {
    try {
      const data = await fetch(`${API_BASE}/conversations`, { method: "POST" }).then((r) => r.json()) as { conversationId: number };
      setConvId(data.conversationId);
      setMessages([{
        id: uid(), role: "system",
        content: "Welcome to **Emerald AI** — Air Quality Media Intelligence.\n\nTell me which organisations and date range you want to analyse, and I'll generate a full report. Or ask me anything about a report you've already generated.",
      }]);
      setReportHtml(null);
      setShowReport(false);
      setDraftPayload(null);
      setShowDraft(false);
      setSessionCost({ claude: 0, llm: 0, serper: 0 });
      setEditDraft("");
      setWelcomeExiting(false); setWelcomeGone(false);
      refreshConvList();
    } catch { /* ignore */ }
  }, [refreshConvList]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || loading || !convId) return;

    setInput("");
    setLoading(true);

    const userMsg: Message = { id: uid(), role: "user", content: text };
    const assistantMsg: Message = {
      id: uid(),
      role: "assistant",
      content: "",
      toolEvents: [],
    };

    setMessages((prev) => [...prev, userMsg, assistantMsg]);

    try {
      const res = await fetch(`${API_BASE}/conversations/${convId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });

      if (!res.body) throw new Error("No response body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const evt = JSON.parse(line.slice(6));
            handleEvent(evt, assistantMsg.id);
          } catch {
            // ignore malformed
          }
        }
      }
    } catch (err) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsg.id
            ? { ...m, content: `Error: ${String(err)}` }
            : m
        )
      );
    } finally {
      setLoading(false);
      setStreaming(false);
      refreshConvList(); // update title/count in sidebar after each response
    }
  }, [input, loading, convId]);

  const handleEvent = (evt: Record<string, unknown>, msgId: string) => {
    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== msgId) return m;

        switch (evt.type) {
          case "text":
            setStreaming(true);
            return { ...m, content: m.content + (evt.content as string) };

          case "tool_start":
            return {
              ...m,
              toolEvents: [
                ...(m.toolEvents ?? []),
                {
                  tool: evt.tool as string,
                  label: evt.label as string,
                  status: "running" as const,
                },
              ],
            };

          case "tool_done":
            return {
              ...m,
              toolEvents: (m.toolEvents ?? []).map((te) =>
                te.tool === evt.tool ? { ...te, status: "done" as const } : te
              ),
            };

          case "draft_ready":
            setDraftPayload(evt as unknown as DraftPayload);
            setShowDraft(true);
            return { ...m, hasDraft: true };

          case "report_html":
            setReportHtml(evt.html as string);
            setShowReport(true);
            setShowDraft(false); // dismiss draft panel when final report arrives
            setReportUpdated(true);
            setTimeout(() => setReportUpdated(false), 4000);
            return { ...m, hasReport: true };

          case "cost":
            setSessionCost(prev => ({
              ...prev,
              claude: prev.claude + (evt.costUsd as number),
            }));
            return {
              ...m,
              cost: {
                inputTokens: evt.inputTokens as number,
                outputTokens: evt.outputTokens as number,
                costUsd: evt.costUsd as number,
              },
            };

          case "llm_cost":
            setSessionCost(prev => ({
              ...prev,
              llm: prev.llm + (evt.costUsd as number),
            }));
            return m;

          case "serper_cost":
            setSessionCost(prev => ({
              ...prev,
              serper: prev.serper + (evt.costUsd as number),
            }));
            return m;

          default:
            return m;
        }
      })
    );
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div style={styles.root}>
      {/* Top loading bar */}
      {loading && (
        <div className="progress-bar-wrap">
          <div className="progress-bar-inner" />
        </div>
      )}

      {/* Sidebar */}
      <aside style={styles.sidebar}>
        <div style={styles.logoWrap}>
          <div>
            <div style={styles.logoName}>Emerald AI</div>
            <div style={styles.logoSub}>Media Intelligence</div>
          </div>
        </div>

        {/* YouTube connect */}
        <div style={styles.sideSection}>
          <div style={styles.sideSectionTitle}>Integrations</div>
          <div style={styles.ytWidget}>
            <div style={styles.ytWidgetLeft}>
              <span style={{ fontSize: 16 }}>▶</span>
              <div>
                <div style={styles.ytWidgetName}>YouTube</div>
                <div style={{
                  ...styles.ytWidgetStatus,
                  color: ytStatus === "connected" ? "#e0e0e0"
                       : ytStatus === "disconnected" ? "#444444"
                       : "#333333",
                }}>
                  {ytStatus === "connected" ? "● Connected"
                   : ytStatus === "disconnected" ? "● Disconnected"
                   : "Checking…"}
                </div>
              </div>
            </div>
            {ytStatus !== "connected" && (
              <button
                style={styles.ytConnectBtn}
                className="yt-connect-btn"
                onClick={() => window.open(`${API_BASE}/youtube/auth`, "_blank", "width=600,height=700")}
              >
                Connect
              </button>
            )}
          </div>
        </div>

        {/* Previous chats */}
        <div style={{ ...styles.sideSection, flex: 1, overflow: "hidden", display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <div style={styles.sideSectionTitle}>Chats</div>
            <button
              style={styles.newChatBtn}
              className="quick-btn"
              title="New conversation"
              onClick={startNewConversation}
            >
              + New
            </button>
          </div>

          <div style={{ flex: 1, overflowY: "auto", marginRight: -4 }} className="smooth-scroll">
            {convList.length === 0 && (
              <div style={{ fontSize: 11, color: "#484f58", padding: "8px 2px" }}>No previous chats yet.</div>
            )}
            {convList.map((c) => {
              const isActive = c.id === convId;
              const date = new Date(c.updatedAt);
              const dateStr = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
              return (
                <button
                  key={c.id}
                  style={{
                    ...styles.convItem,
                    background: isActive ? "rgba(255,255,255,0.06)" : "none",
                    borderColor: isActive ? "rgba(255,255,255,0.12)" : "transparent",
                  }}
                  className="conv-item"
                  onClick={() => loadConversation(c.id)}
                >
                  <div style={styles.convItemHeader}>
                    <span style={{ fontSize: 11, color: isActive ? "#e0e0e0" : "#333333", fontWeight: 600 }}>
                      #{c.id}
                    </span>
                    <span style={{ fontSize: 10, color: "#484f58" }}>{dateStr}</span>
                    {c.hasReport && (
                      <span style={{ fontSize: 9, background: "rgba(255,255,255,0.06)", color: "#888888", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 4, padding: "1px 5px" }}>
                        report
                      </span>
                    )}
                  </div>
                  <div style={styles.convItemTitle}>
                    {c.title.length > 52 ? c.title.slice(0, 52) + "…" : c.title}
                  </div>
                  {c.messageCount > 0 && (
                    <div style={{ fontSize: 10, color: "#484f58", marginTop: 2 }}>
                      {c.messageCount} message{c.messageCount !== 1 ? "s" : ""}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Bottom action buttons */}
        {draftPayload && !showReport && (
          <button
            style={{ ...styles.viewReportBtn, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", color: "#cccccc" }}
            className="view-report-btn view-draft-btn-new"
            onClick={() => setShowDraft(true)}
          >
            📋 Review Draft Data
          </button>
        )}

        {reportHtml && (
          <button
            style={styles.viewReportBtn}
            className={`view-report-btn${reportUpdated ? " view-report-btn-new" : ""}`}
            onClick={() => setShowReport(true)}
          >
            📊 View Latest Report
          </button>
        )}

        {/* Cost tracker */}
        {(sessionCost.claude > 0 || sessionCost.llm > 0 || sessionCost.serper > 0) && (
          <div style={styles.costWidget}>
            <div style={styles.costWidgetTitle}>Session Cost</div>
            <div style={styles.costWidgetTotal}>
              ${(sessionCost.claude + sessionCost.llm + sessionCost.serper).toFixed(4)}
            </div>
            <div style={styles.costWidgetBreakdown}>
              {sessionCost.claude > 0 && (
                <div style={styles.costRow}>
                  <span>Claude</span><span>${sessionCost.claude.toFixed(4)}</span>
                </div>
              )}
              {sessionCost.llm > 0 && (
                <div style={styles.costRow}>
                  <span>LLM APIs</span><span>${sessionCost.llm.toFixed(4)}</span>
                </div>
              )}
              {sessionCost.serper > 0 && (
                <div style={styles.costRow}>
                  <span>Serper</span><span>${sessionCost.serper.toFixed(4)}</span>
                </div>
              )}
            </div>
          </div>
        )}

        <div style={styles.sideFooter}>
          Active: Conv #{convId ?? "…"}
        </div>
      </aside>

      {/* Main chat */}
      <main style={styles.main}>
        <div style={{ ...styles.chatArea, position: "relative" }}>

          {/* Centered welcome — visible before first message, fades out on first send */}
          {!welcomeGone && (
            <div
              className={welcomeExiting ? "welcome-exit" : "welcome-enter"}
              style={{
                position: "absolute", inset: 0,
                display: "flex", flexDirection: "column",
                alignItems: "center", justifyContent: "center",
                pointerEvents: welcomeExiting ? "none" : "auto",
                padding: "0 40px",
              }}
            >
              <div style={{ textAlign: "center", maxWidth: 520 }}>
                <div style={{
                  fontFamily: "'Syne', sans-serif", fontSize: 36, fontWeight: 800,
                  color: "#ffffff", letterSpacing: "-0.03em", lineHeight: 1.1, marginBottom: 12,
                }}>
                  Emerald AI
                </div>
                <div style={{
                  fontSize: 13, color: "#444444", letterSpacing: "0.06em",
                  textTransform: "uppercase", marginBottom: 28, fontWeight: 500,
                }}>
                  Air Quality Media Intelligence
                </div>
                <div style={{
                  fontSize: 15, color: "#666666", lineHeight: 1.75, maxWidth: 440, margin: "0 auto",
                }}>
                  Tell me which organisations and date range you want to analyse,
                  and I'll generate a full report. Or ask me anything about a
                  report you've already generated.
                </div>
              </div>
            </div>
          )}

          {/* Conversation messages — only non-system messages */}
          {messages
            .filter((m) => m.role !== "system")
            .map((m, idx, arr) => (
              <ChatMessage
                key={m.id}
                message={m}
                isStreaming={streaming && idx === arr.length - 1 && m.role === "assistant"}
              />
            ))}
          <div ref={bottomRef} />
        </div>

        {/* Input bar */}
        <div style={styles.inputBar}>
          <textarea
            ref={textareaRef}
            style={styles.textarea}
            className="chat-textarea"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask Emerald AI to generate a report, query data, or add statistics…"
            rows={1}
            disabled={loading}
          />
          <button
            data-send-btn
            style={{
              ...styles.sendBtn,
              opacity: loading || !input.trim() ? 0.5 : 1,
              cursor: loading || !input.trim() ? "not-allowed" : "pointer",
            }}
            className="send-btn"
            onClick={send}
            disabled={loading || !input.trim()}
          >
            {loading ? <Spinner /> : "↑"}
          </button>
        </div>
        <div style={styles.inputHint}>
          Enter to send · Shift+Enter for new line
        </div>
      </main>

      {/* Draft review overlay */}
      {showDraft && draftPayload && (
        <div className="anim-overlay-in" style={{ position: "fixed", inset: 0, zIndex: 300 }}>
        <DraftReviewPanel
          payload={draftPayload}
          onApprove={(changeNote) => {
            setShowDraft(false);
            const msg = changeNote?.trim()
              ? `Please make these changes to the draft: ${changeNote.trim()}. Then generate the final report.`
              : "The draft data looks correct. Please generate the final HTML report and PPTX now.";
            setInput(msg);
            setTimeout(() => {
              const btn = document.querySelector("[data-send-btn]") as HTMLButtonElement;
              btn?.click();
            }, 50);
          }}
          onClose={() => setShowDraft(false)}
        />
        </div>
      )}

      {/* Report overlay */}
      {showReport && reportHtml && (
        <div style={styles.reportOverlay} className="anim-overlay-in">
          {/* Header */}
          <div style={styles.reportHeader}>
            <span style={{ fontWeight: 700, color: "#f0f0f0", fontSize: 13 }}>Intelligence Report</span>
            <div style={{ display: "flex", gap: 8 }}>
              {reportUpdated && (
                <span style={{ fontSize: 12, color: "#aaaaaa", marginRight: 8, fontWeight: 500 }}>
                  ✓ Updated
                </span>
              )}
              <button
                style={styles.reportBtn}
                className="overlay-btn"
                onClick={() => {
                  const blob = new Blob([reportHtml], { type: "text/html" });
                  const a = document.createElement("a");
                  a.href = URL.createObjectURL(blob);
                  a.download = `emerald-report-${new Date().toISOString().slice(0,10)}.html`;
                  a.click();
                }}
              >
                ⬇ HTML
              </button>
              <button
                style={{ ...styles.reportBtn, background: "rgba(255,255,255,0.06)", color: "#f0f0f0", border: "1px solid rgba(255,255,255,0.14)" }}
                className="pptx-btn overlay-btn"
                onClick={() => {
                  const a = document.createElement("a");
                  a.href = `${API_BASE}/conversations/${convId}/report.pptx`;
                  a.download = `emerald-report-${new Date().toISOString().slice(0,10)}.pptx`;
                  a.click();
                }}
              >
                📊 Download PPTX
              </button>
              <button style={styles.reportBtn} className="overlay-btn" onClick={() => setShowReport(false)}>
                ✕ Close
              </button>
            </div>
          </div>

          {/* Body: iframe + edit panel side by side */}
          <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
            <iframe
              style={styles.reportFrame}
              srcDoc={reportHtml}
              title="Intelligence Report"
              sandbox="allow-same-origin"
            />

            {/* Edit / review panel */}
            <div style={styles.editPanel}>
              <div style={styles.editPanelTitle}>Review & Edit</div>

              {/* Quick section edits */}
              <div style={styles.editPanelLabel}>Request a section change:</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 }}>
                {["Social", "Media", "AEO / LLM Visibility", "Action Matrix", "Scorecards"].map((sec) => (
                  <button
                    key={sec}
                    style={styles.sectionBtn}
                    className="section-btn"
                    onClick={() => setEditDraft(`Please update the ${sec} section: `)}
                  >
                    ✏ {sec}
                  </button>
                ))}
              </div>

              {/* Free-text change request */}
              <div style={styles.editPanelLabel}>Or describe your change:</div>
              <textarea
                style={styles.editTextarea}
                placeholder="e.g. Update the AEO section with actual ChatGPT query results..."
                value={editDraft}
                onChange={(e) => setEditDraft(e.target.value)}
              />
              <button
                style={{
                  ...styles.reportBtn,
                  background: editDraft.trim() ? "rgba(0,179,126,0.2)" : "rgba(255,255,255,0.04)",
                  color: editDraft.trim() ? "#00b37e" : "#666",
                  marginTop: 8,
                  width: "100%",
                  justifyContent: "center",
                  cursor: editDraft.trim() ? "pointer" : "default",
                }}
                disabled={!editDraft.trim()}
                onClick={() => {
                  if (!editDraft.trim()) return;
                  // Send the message immediately (don't require user to find the chat box)
                  const draft = editDraft.trim();
                  setEditDraft("");
                  setShowReport(false); // close to show progress in chat
                  setInput(draft);
                  // Trigger send on next tick (after input state updates)
                  setTimeout(() => {
                    const btn = document.querySelector("[data-send-btn]") as HTMLButtonElement;
                    btn?.click();
                  }, 50);
                }}
              >
                Send to Chat →
              </button>

              <div style={styles.editPanelLabel} >Regenerate options:</div>
              {[
                "Regenerate the full report with updated data",
                "Add LLM visibility queries to the report",
                "Rewrite the Action Matrix with more specific recommendations",
              ].map((prompt) => (
                <button
                  key={prompt}
                  style={{ ...styles.sectionBtn, fontSize: 11, marginBottom: 4 }}
                  onClick={() => {
                    setEditDraft("");
                    setShowReport(false);
                    setInput(prompt);
                    setTimeout(() => {
                      const btn = document.querySelector("[data-send-btn]") as HTMLButtonElement;
                      btn?.click();
                    }, 50);
                  }}
                >
                  ↺ {prompt}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Draft Review Panel ─────────────────────────────────────────────────────
function DraftReviewPanel({
  payload,
  onApprove,
  onClose,
}: {
  payload: DraftPayload;
  onApprove: (changeNote?: string) => void;
  onClose: () => void;
}) {
  const [changeNote, setChangeNote] = useState("");
  const { stats } = payload;

  const GRADE_COLOR: Record<string, string> = {
    A: "#ffffff", B: "#dddddd", C: "#aaaaaa", D: "#777777", F: "#555555",
  };
  const TIER_COLOR: Record<string, string> = {
    High: "#f0f0f0", Moderate: "#aaaaaa", Low: "#555555",
  };
  const ACTION_COLOR: Record<string, string> = {
    "Fix Now": "#f0f0f0", Leverage: "#cccccc", Optimise: "#aaaaaa", Invest: "#888888",
  };

  return (
    <div style={draftStyles.overlay}>
      {/* Header */}
      <div style={draftStyles.header}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 18 }}>📋</span>
          <div>
            <div style={draftStyles.headerTitle}>Draft Ready for Review</div>
            <div style={draftStyles.headerSub}>Review all data before generating the final HTML report & PPTX</div>
          </div>
        </div>
        <button style={draftStyles.closeBtn} onClick={onClose}>✕</button>
      </div>

      <div style={draftStyles.body}>
        {/* Summary from Claude */}
        <div style={draftStyles.summaryBox}>
          <div style={draftStyles.summaryLabel}>Agent summary</div>
          <div style={draftStyles.summaryText}>{payload.summary}</div>
        </div>

        {/* Sanity warnings */}
        {stats.sanity_errors && stats.sanity_errors.length > 0 && (
          <div style={draftStyles.warnBox}>
            <strong>⚠ Data Quality Warnings</strong>
            <ul style={{ paddingLeft: 16, marginTop: 6 }}>
              {stats.sanity_errors.map((e, i) => <li key={i} style={{ fontSize: 12 }}>{e}</li>)}
            </ul>
          </div>
        )}

        {/* Scorecards */}
        <div style={draftStyles.sectionTitle} className="stagger-2">Organisation Scorecards</div>
        <div style={draftStyles.scoreGrid}>
          {stats.scorecards.map((sc, i) => (
            <div key={sc.org} style={draftStyles.scoreCard} className={`score-card-anim stagger-${Math.min(i + 3, 6)}`}>
              <div style={draftStyles.scoreOrg}>{sc.org}</div>
              <div style={{ ...draftStyles.scoreGrade, color: GRADE_COLOR[sc.grade] ?? "#8b949e" }}>{sc.grade}</div>
              <div style={draftStyles.scoreTotal}>{sc.overall_score}/100</div>
              <div style={draftStyles.scoreSub}>
                Social {sc.social_score} · Media {sc.media_score} · AEO {sc.aeo_score}
              </div>
            </div>
          ))}
        </div>

        {/* Social */}
        <div style={draftStyles.sectionTitle} className="stagger-3">Social Media — Engagement Rates</div>
        <table style={draftStyles.table}>
          <thead><tr>
            {["Organisation","Platform","Impressions","ER %"].map(h => (
              <th key={h} style={draftStyles.th}>{h}</th>
            ))}
          </tr></thead>
          <tbody>
            {stats.social.map((s, i) => (
              <tr key={i} className="draft-row">
                <td style={draftStyles.td}>{s.org}</td>
                <td style={draftStyles.td}>{s.platform}</td>
                <td style={draftStyles.td}>{s.impressions.toLocaleString()}</td>
                <td style={{ ...draftStyles.td, color: "#00b37e", fontWeight: 600 }}>{s.er_pct}%</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Media */}
        <div style={draftStyles.sectionTitle} className="stagger-4">Media Coverage</div>
        <table style={draftStyles.table}>
          <thead><tr>
            {["Organisation","Total Mentions","Dofollow Links","Auth. Tone %"].map(h => (
              <th key={h} style={draftStyles.th}>{h}</th>
            ))}
          </tr></thead>
          <tbody>
            {stats.media.map((m, i) => (
              <tr key={i}>
                <td style={draftStyles.td}>{m.org}</td>
                <td style={draftStyles.td}>{m.total_mentions}</td>
                <td style={{ ...draftStyles.td, color: "#00b37e" }}>{m.dofollow_links}</td>
                <td style={{ ...draftStyles.td, color: m.aligned_tone_pct >= 60 ? "#3fb950" : "#d29922" }}>{m.aligned_tone_pct}%</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* AEO */}
        <div style={draftStyles.sectionTitle} className="stagger-5">LLM / AEO Visibility</div>
        <table style={draftStyles.table}>
          <thead><tr>
            {["Organisation","LLM","Mention Rate","Tier"].map(h => (
              <th key={h} style={draftStyles.th}>{h}</th>
            ))}
          </tr></thead>
          <tbody>
            {stats.aeo.map((a, i) => (
              <tr key={i}>
                <td style={draftStyles.td}>{a.org}</td>
                <td style={draftStyles.td}>{a.llm}</td>
                <td style={{ ...draftStyles.td, color: "#00b37e", fontWeight: 600 }}>{a.mention_count}/20 ({a.mention_rate_pct}%)</td>
                <td style={{ ...draftStyles.td, color: TIER_COLOR[a.visibility_tier] ?? "#8b949e", fontWeight: 600 }}>{a.visibility_tier}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Action Matrix preview */}
        <div style={draftStyles.sectionTitle} className="stagger-6">Action Matrix Preview</div>
        <table style={draftStyles.table}>
          <thead><tr>
            {["Organisation","Priority","Area","Action"].map(h => (
              <th key={h} style={draftStyles.th}>{h}</th>
            ))}
          </tr></thead>
          <tbody>
            {stats.action_matrix.map((a, i) => (
              <tr key={i}>
                <td style={draftStyles.td}>{a.org}</td>
                <td style={{ ...draftStyles.td, color: ACTION_COLOR[a.priority] ?? "#8b949e", fontWeight: 600 }}>{a.priority}</td>
                <td style={draftStyles.td}>{a.area}</td>
                <td style={{ ...draftStyles.td, fontSize: 12 }}>{a.action}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Change request + approve */}
        <div style={draftStyles.approveSection}>
          <div style={draftStyles.changeLabel}>Request changes before generating (optional)</div>
          <textarea
            style={draftStyles.changeTextarea}
            placeholder="e.g. The media mentions for Reuters look too high. Can you re-check the Serper query? Or: Please change the AEO benchmark queries to be more specific to India."
            value={changeNote}
            onChange={(e) => setChangeNote(e.target.value)}
          />
          <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
            <button
              style={draftStyles.approveBtn}
              className="approve-btn"
              onClick={() => onApprove(changeNote)}
            >
              {changeNote.trim() ? "⚡ Apply Changes & Generate Report" : "✓ Approve — Generate Final Report"}
            </button>
            <button style={draftStyles.dismissBtn} className="overlay-btn" onClick={onClose}>
              Keep reviewing
            </button>
          </div>
          <div style={{ fontSize: 11, color: "#484f58", marginTop: 8 }}>
            Approving will generate the HTML report and make it available for PPTX download.
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Chat Message ───────────────────────────────────────────────────────────
function ChatMessage({ message: m, isStreaming }: { message: Message; isStreaming?: boolean }) {
  const isUser   = m.role === "user";
  const isSystem = m.role === "system";

  if (isSystem) {
    return (
      <div style={styles.systemMsg} className="msg-system">
        <MdText text={m.content} />
      </div>
    );
  }

  return (
    <div
      style={{ ...styles.msgRow, justifyContent: isUser ? "flex-end" : "flex-start" }}
      className="msg-enter"
    >
      {!isUser && <div style={styles.avatar}>E</div>}
      <div
        style={{
          ...styles.bubble,
          ...(isUser ? styles.bubbleUser : styles.bubbleAssistant),
        }}
        className={isUser ? "" : "bubble-assistant"}
      >
        {/* Tool events */}
        {(m.toolEvents ?? []).length > 0 && (
          <div style={styles.toolList}>
            {m.toolEvents!.map((te, i) => (
              <div
                key={i}
                style={styles.toolItem}
                className={`tool-item${te.status === "running" ? " tool-item-running" : " tool-item-done"}`}
              >
                <span style={{ fontSize: 14 }}>{TOOL_ICONS[te.tool] ?? "⚙️"}</span>
                <span style={{ color: "#8b949e", fontSize: 12 }}>{te.label}</span>
                <span style={{ marginLeft: "auto", fontSize: 12 }}>
                  {te.status === "running" ? (
                    <span style={{ color: "#d29922" }} className="tool-status-running">● running</span>
                  ) : (
                    <span style={{ color: "#3fb950" }} className="tool-status-done">✓ done</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Text — add streaming cursor to last assistant message while streaming */}
        {m.content && (
          <span className={isStreaming ? "streaming-cursor" : ""}>
            <MdText text={m.content} />
          </span>
        )}

        {/* Draft ready badge */}
        {m.hasDraft && (
          <div
            style={{ ...styles.reportBadge, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", color: "#777777" }}
            className="report-badge-anim"
          >
            📋 Draft data ready — review in sidebar, then approve to generate the report
          </div>
        )}

        {/* Report badge */}
        {m.hasReport && (
          <div style={styles.reportBadge} className="report-badge-anim">
            📊 Report generated — click "View Latest Report" in the sidebar
          </div>
        )}

        {/* Cost */}
        {m.cost && (
          <div style={styles.costLine} className="cost-tick">
            {m.cost.inputTokens.toLocaleString()} in ·{" "}
            {m.cost.outputTokens.toLocaleString()} out · $
            {m.cost.costUsd.toFixed(4)}
          </div>
        )}
      </div>
      {isUser && <div style={styles.avatarUser}>U</div>}
    </div>
  );
}

// ─── Minimal markdown renderer ──────────────────────────────────────────────
function MdText({ text }: { text: string }) {
  const html = text
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`(.+?)`/g, '<code style="background:#21262d;padding:1px 5px;border-radius:3px;font-family:monospace;font-size:12px">$1</code>')
    .replace(/\n/g, "<br/>");
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}

// ─── Spinner ─────────────────────────────────────────────────────────────────
function Spinner() {
  return (
    <span
      style={{
        display: "inline-block",
        width: 16,
        height: 16,
        border: "2px solid #ffffff40",
        borderTop: "2px solid #fff",
        borderRadius: "50%",
        animation: "spin 0.7s linear infinite",
      }}
    />
  );
}


// ─── Draft Review Styles — Premium B&W ───────────────────────────────────────
const draftStyles: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
    background: "#080808", zIndex: 300,
    display: "flex", flexDirection: "column", overflow: "hidden",
  },
  header: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "14px 24px", background: "#0f0f0f", borderBottom: "1px solid #1e1e1e",
    flexShrink: 0,
  },
  headerTitle: { fontFamily: "'Syne', sans-serif", fontWeight: 700, fontSize: 16, color: "#f0f0f0" },
  headerSub: { fontSize: 11, color: "#555555", marginTop: 2 },
  closeBtn: {
    background: "none", border: "1px solid #2a2a2a", color: "#666666",
    borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 13,
  },
  body: { flex: 1, overflowY: "auto", padding: "24px 32px", display: "flex", flexDirection: "column", gap: 20 },
  summaryBox: {
    background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 8, padding: "12px 16px",
  },
  summaryLabel: { fontSize: 10, fontWeight: 600, color: "#888888", textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 6 },
  summaryText: { fontSize: 13, color: "#cccccc", lineHeight: 1.6 },
  warnBox: {
    background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 8, padding: "12px 16px", color: "#aaaaaa", fontSize: 13,
  },
  sectionTitle: {
    fontFamily: "'Syne', sans-serif", fontSize: 14, fontWeight: 700,
    color: "#f0f0f0", borderLeft: "2px solid #ffffff", paddingLeft: 10,
  },
  scoreGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 12 },
  scoreCard: {
    background: "#111111", border: "1px solid #222222", borderRadius: 10,
    padding: "16px", textAlign: "center",
  },
  scoreOrg: { fontSize: 10, fontWeight: 600, color: "#555555", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 },
  scoreGrade: { fontFamily: "'Syne', sans-serif", fontSize: 48, fontWeight: 800, lineHeight: 1, marginBottom: 4 },
  scoreTotal: { fontSize: 16, fontWeight: 700, color: "#f0f0f0", marginBottom: 6 },
  scoreSub: { fontSize: 11, color: "#555555" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: {
    background: "#141414", padding: "9px 12px", textAlign: "left",
    fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.1em",
    color: "#555555", borderBottom: "1px solid #1e1e1e",
  },
  td: { padding: "9px 12px", borderBottom: "1px solid #161616", color: "#e0e0e0" },
  approveSection: {
    background: "#0f0f0f", border: "1px solid #1e1e1e", borderRadius: 10,
    padding: 20, marginTop: 8,
  },
  changeLabel: { fontSize: 11, fontWeight: 600, color: "#555555", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 10 },
  changeTextarea: {
    width: "100%", background: "#080808", border: "1px solid #2a2a2a",
    borderRadius: 6, color: "#e0e0e0", fontSize: 13, padding: "10px 12px",
    resize: "vertical", minHeight: 80, fontFamily: "inherit",
  },
  approveBtn: {
    background: "#ffffff", border: "none",
    color: "#000000", borderRadius: 8, padding: "11px 22px", cursor: "pointer",
    fontWeight: 700, fontSize: 13,
  },
  dismissBtn: {
    background: "transparent", border: "1px solid #2a2a2a",
    color: "#666666", borderRadius: 8, padding: "10px 16px", cursor: "pointer", fontSize: 13,
  },
};

// ─── Styles — Premium Black & White ───────────────────────────────────────────
const styles: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    height: "100vh",
    background: "#080808",
    color: "#f0f0f0",
    fontFamily: "'Inter', system-ui, sans-serif",
    overflow: "hidden",
  },
  sidebar: {
    width: 240,
    background: "#0c0c0c",
    borderRight: "1px solid #1a1a1a",
    display: "flex",
    flexDirection: "column",
    padding: "20px 14px",
    flexShrink: 0,
  },
  logoWrap: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    marginBottom: 24,
    paddingBottom: 20,
    borderBottom: "1px solid #181818",
  },
  logoMark: {
    width: 36,
    height: 36,
    background: "#ffffff",
    borderRadius: 10,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: 900,
    fontSize: 18,
    color: "#000000",
    flexShrink: 0,
  },
  logoName: {
    fontFamily: "'Syne', sans-serif",
    fontWeight: 700,
    fontSize: 15,
    letterSpacing: "-0.01em",
    color: "#f0f0f0",
  },
  logoSub: {
    fontFamily: "'Inter', sans-serif",
    fontSize: 11,
    color: "#444444",
    marginTop: 1,
    letterSpacing: "0.02em",
  },
  sideSection: {
    marginBottom: 20,
  },
  sideSectionTitle: {
    fontFamily: "'Inter', sans-serif",
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: "0.14em",
    color: "#444444",
    marginBottom: 8,
    textTransform: "uppercase" as const,
  },
  quickBtn: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    background: "none",
    border: "none",
    color: "#888888",
    cursor: "pointer",
    padding: "4px 8px",
    borderRadius: 6,
    fontSize: 11,
    textAlign: "left" as const,
  },
  newChatBtn: {
    display: "flex",
    alignItems: "center",
    background: "rgba(255,255,255,0.07)",
    border: "1px solid rgba(255,255,255,0.12)",
    color: "#f0f0f0",
    cursor: "pointer",
    padding: "4px 10px",
    borderRadius: 6,
    fontSize: 11,
    fontWeight: 600,
  },
  convItem: {
    display: "block",
    width: "100%",
    background: "none",
    border: "1px solid transparent",
    borderRadius: 7,
    color: "#888888",
    cursor: "pointer",
    padding: "8px 9px",
    textAlign: "left" as const,
    marginBottom: 2,
    transition: "background 0.13s, border-color 0.13s",
  },
  convItemHeader: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    marginBottom: 3,
  },
  convItemTitle: {
    fontSize: 12,
    color: "#cccccc",
    lineHeight: 1.35,
    fontFamily: "'Inter', sans-serif",
  },
  viewReportBtn: {
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.12)",
    color: "#f0f0f0",
    borderRadius: 8,
    padding: "9px 12px",
    cursor: "pointer",
    fontWeight: 600,
    fontSize: 13,
    width: "100%",
    marginBottom: 10,
  },
  sideFooter: {
    fontSize: 10,
    color: "#2e2e2e",
    textAlign: "center" as const,
    letterSpacing: "0.04em",
  },
  main: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  chatArea: {
    flex: 1,
    overflowY: "auto" as const,
    padding: "28px 40px",
    display: "flex",
    flexDirection: "column",
    gap: 16,
  },
  systemMsg: {
    background: "rgba(255,255,255,0.03)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 10,
    padding: "16px 20px",
    fontSize: 14,
    color: "#aaaaaa",
    lineHeight: 1.75,
    maxWidth: 680,
  },
  msgRow: {
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
  },
  avatar: {
    width: 30,
    height: 30,
    background: "#ffffff",
    borderRadius: 8,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: 900,
    fontSize: 13,
    color: "#000000",
    flexShrink: 0,
  },
  avatarUser: {
    width: 30,
    height: 30,
    background: "#181818",
    border: "1px solid #2a2a2a",
    borderRadius: 8,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: 700,
    fontSize: 13,
    color: "#555555",
    flexShrink: 0,
  },
  bubble: {
    maxWidth: 680,
    padding: "13px 17px",
    borderRadius: 12,
    fontSize: 14,
    lineHeight: 1.75,
  },
  bubbleUser: {
    background: "#131313",
    border: "1px solid #222222",
    borderBottomRightRadius: 4,
    color: "#e0e0e0",
  },
  bubbleAssistant: {
    background: "#0f0f0f",
    border: "1px solid #1a1a1a",
    borderBottomLeftRadius: 4,
    color: "#cccccc",
  },
  toolList: {
    marginBottom: 10,
    display: "flex",
    flexDirection: "column" as const,
    gap: 4,
  },
  toolItem: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    background: "#080808",
    border: "1px solid #1a1a1a",
    borderRadius: 6,
    padding: "5px 10px",
    fontSize: 12,
  },
  reportBadge: {
    marginTop: 10,
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: 6,
    padding: "7px 12px",
    fontSize: 12,
    color: "#aaaaaa",
  },
  costLine: {
    marginTop: 8,
    fontSize: 11,
    color: "#333333",
  },
  inputBar: {
    display: "flex",
    alignItems: "flex-end",
    gap: 8,
    padding: "12px 40px 10px",
    borderTop: "1px solid #141414",
    background: "#080808",
  },
  textarea: {
    flex: 1,
    background: "#0f0f0f",
    border: "1px solid #222222",
    borderRadius: 10,
    color: "#f0f0f0",
    padding: "11px 14px",
    fontSize: 14,
    resize: "none" as const,
    outline: "none",
    fontFamily: "inherit",
    lineHeight: 1.6,
    overflowY: "auto" as const,
    transition: "border-color 0.18s, box-shadow 0.18s",
  },
  sendBtn: {
    width: 40,
    height: 40,
    background: "#ffffff",
    border: "none",
    borderRadius: 10,
    color: "#000000",
    fontWeight: 900,
    fontSize: 18,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    transition: "opacity 0.15s",
  },
  inputHint: {
    padding: "4px 40px 12px",
    fontSize: 11,
    color: "#2e2e2e",
  },
  reportOverlay: {
    position: "fixed" as const,
    top: 0, left: 0, right: 0, bottom: 0,
    background: "#080808",
    zIndex: 200,
    display: "flex",
    flexDirection: "column" as const,
  },
  reportHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 20px",
    background: "#0f0f0f",
    borderBottom: "1px solid #1a1a1a",
  },
  reportBtn: {
    background: "#181818",
    border: "1px solid #2a2a2a",
    color: "#cccccc",
    borderRadius: 6,
    padding: "6px 12px",
    cursor: "pointer",
    fontSize: 13,
  },
  reportFrame: {
    flex: 1,
    border: "none",
    minWidth: 0,
  },
  editPanel: {
    width: 280,
    flexShrink: 0,
    background: "#0c0c0c",
    borderLeft: "1px solid #1a1a1a",
    padding: 16,
    overflowY: "auto" as const,
    display: "flex",
    flexDirection: "column" as const,
  },
  editPanelTitle: {
    fontWeight: 700,
    fontSize: 13,
    color: "#f0f0f0",
    marginBottom: 14,
    letterSpacing: 0.3,
  },
  editPanelLabel: {
    fontSize: 10,
    fontWeight: 600,
    color: "#444444",
    textTransform: "uppercase" as const,
    letterSpacing: "0.1em",
    marginBottom: 8,
    marginTop: 4,
  },
  sectionBtn: {
    background: "transparent",
    border: "1px solid #1e1e1e",
    color: "#888888",
    borderRadius: 6,
    padding: "7px 10px",
    cursor: "pointer",
    fontSize: 12,
    textAlign: "left" as const,
    width: "100%",
  },
  editTextarea: {
    width: "100%",
    background: "#080808",
    border: "1px solid #222222",
    borderRadius: 6,
    color: "#e0e0e0",
    fontSize: 12,
    padding: 8,
    resize: "vertical" as const,
    minHeight: 80,
    fontFamily: "inherit",
  },
  costWidget: {
    background: "rgba(255,255,255,0.03)",
    border: "1px solid #1e1e1e",
    borderRadius: 10,
    padding: "12px 14px",
    marginBottom: 10,
  },
  costWidgetTitle: {
    fontFamily: "'Inter', sans-serif",
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: "0.12em",
    textTransform: "uppercase" as const,
    color: "#444444",
    marginBottom: 6,
  },
  costWidgetTotal: {
    fontFamily: "'Syne', sans-serif",
    fontSize: 22,
    fontWeight: 700,
    color: "#ffffff",
    marginBottom: 8,
  },
  costWidgetBreakdown: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 3,
  },
  costRow: {
    display: "flex",
    justifyContent: "space-between",
    fontSize: 11,
    color: "#555555",
    fontFamily: "'Inter', sans-serif",
  },
  ytWidget: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    background: "rgba(255,255,255,0.02)",
    border: "1px solid #1e1e1e",
    borderRadius: 8,
    padding: "8px 10px",
  },
  ytWidgetLeft: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    color: "#888888",
  },
  ytWidgetName: {
    fontSize: 12,
    fontWeight: 600,
    color: "#cccccc",
    fontFamily: "'Inter', sans-serif",
  },
  ytWidgetStatus: {
    fontSize: 10,
    fontFamily: "'Inter', sans-serif",
    marginTop: 2,
  },
  ytConnectBtn: {
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.14)",
    color: "#dddddd",
    borderRadius: 6,
    padding: "4px 10px",
    fontSize: 11,
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "'Inter', sans-serif",
  },
};
