import { useState, useRef, useEffect, useCallback } from "react";

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
  cost?: { inputTokens: number; outputTokens: number; costUsd: number };
}

interface ToolEvent {
  tool: string;
  label: string;
  status: "running" | "done";
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
  const [reportHtml, setReportHtml] = useState<string | null>(null);
  const [showReport, setShowReport] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  // Create conversation on mount
  useEffect(() => {
    fetch(`${API_BASE}/conversations`, { method: "POST" })
      .then((r) => r.json())
      .then((d) => setConvId(d.conversationId))
      .catch(() => setConvId(1));
  }, []);

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
    }
  }, [input, loading, convId]);

  const handleEvent = (evt: Record<string, unknown>, msgId: string) => {
    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== msgId) return m;

        switch (evt.type) {
          case "text":
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

          case "report_html":
            setReportHtml(evt.html as string);
            setShowReport(true);
            return { ...m, hasReport: true };

          case "cost":
            return {
              ...m,
              cost: {
                inputTokens: evt.inputTokens as number,
                outputTokens: evt.outputTokens as number,
                costUsd: evt.costUsd as number,
              },
            };

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
      {/* Sidebar */}
      <aside style={styles.sidebar}>
        <div style={styles.logoWrap}>
          <div style={styles.logoMark}>E</div>
          <div>
            <div style={styles.logoName}>Emerald AI</div>
            <div style={styles.logoSub}>Media Intelligence</div>
          </div>
        </div>

        <div style={styles.sideSection}>
          <div style={styles.sideSectionTitle}>QUICK START</div>
          {QUICK_PROMPTS.map((p) => (
            <button
              key={p.label}
              style={styles.quickBtn}
              onClick={() => setInput(p.prompt)}
            >
              <span style={{ fontSize: 16 }}>{p.icon}</span>
              <span>{p.label}</span>
            </button>
          ))}
        </div>

        <div style={{ flex: 1 }} />

        {reportHtml && (
          <button
            style={styles.viewReportBtn}
            onClick={() => setShowReport(true)}
          >
            📊 View Latest Report
          </button>
        )}

        <div style={styles.sideFooter}>
          Conv #{convId ?? "…"} · {messages.filter((m) => m.role !== "system").length} messages
        </div>
      </aside>

      {/* Main chat */}
      <main style={styles.main}>
        <div style={styles.chatArea}>
          {messages.map((m) => (
            <ChatMessage key={m.id} message={m} />
          ))}
          <div ref={bottomRef} />
        </div>

        {/* Input bar */}
        <div style={styles.inputBar}>
          <textarea
            ref={textareaRef}
            style={styles.textarea}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask Emerald AI to generate a report, query data, or add statistics…"
            rows={1}
            disabled={loading}
          />
          <button
            style={{
              ...styles.sendBtn,
              opacity: loading || !input.trim() ? 0.5 : 1,
              cursor: loading || !input.trim() ? "not-allowed" : "pointer",
            }}
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

      {/* Report overlay */}
      {showReport && reportHtml && (
        <div style={styles.reportOverlay}>
          <div style={styles.reportHeader}>
            <span style={{ fontWeight: 700, color: "#00b37e" }}>
              📊 Intelligence Report
            </span>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                style={styles.reportBtn}
                onClick={() => {
                  const blob = new Blob([reportHtml], { type: "text/html" });
                  const a = document.createElement("a");
                  a.href = URL.createObjectURL(blob);
                  a.download = "emerald-report.html";
                  a.click();
                }}
              >
                ⬇ Download
              </button>
              <button
                style={styles.reportBtn}
                onClick={() => setShowReport(false)}
              >
                ✕ Close
              </button>
            </div>
          </div>
          <iframe
            style={styles.reportFrame}
            srcDoc={reportHtml}
            title="Intelligence Report"
            sandbox="allow-same-origin"
          />
        </div>
      )}
    </div>
  );
}

// ─── Chat Message ───────────────────────────────────────────────────────────
function ChatMessage({ message: m }: { message: Message }) {
  const isUser = m.role === "user";
  const isSystem = m.role === "system";

  if (isSystem) {
    return (
      <div style={styles.systemMsg}>
        <MdText text={m.content} />
      </div>
    );
  }

  return (
    <div
      style={{
        ...styles.msgRow,
        justifyContent: isUser ? "flex-end" : "flex-start",
      }}
    >
      {!isUser && <div style={styles.avatar}>E</div>}
      <div
        style={{
          ...styles.bubble,
          ...(isUser ? styles.bubbleUser : styles.bubbleAssistant),
        }}
      >
        {/* Tool events */}
        {(m.toolEvents ?? []).length > 0 && (
          <div style={styles.toolList}>
            {m.toolEvents!.map((te, i) => (
              <div key={i} style={styles.toolItem}>
                <span style={{ fontSize: 14 }}>
                  {TOOL_ICONS[te.tool] ?? "⚙️"}
                </span>
                <span style={{ color: "#8b949e", fontSize: 12 }}>{te.label}</span>
                <span style={{ marginLeft: "auto", fontSize: 12 }}>
                  {te.status === "running" ? (
                    <span style={{ color: "#d29922" }}>● running</span>
                  ) : (
                    <span style={{ color: "#3fb950" }}>✓ done</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Text */}
        {m.content && <MdText text={m.content} />}

        {/* Report badge */}
        {m.hasReport && (
          <div style={styles.reportBadge}>
            📊 Report generated — click "View Latest Report" in the sidebar
          </div>
        )}

        {/* Cost */}
        {m.cost && (
          <div style={styles.costLine}>
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

// ─── Quick prompts ────────────────────────────────────────────────────────────
const QUICK_PROMPTS = [
  {
    icon: "📋",
    label: "New full report",
    prompt:
      "Generate a full Air Quality Media Intelligence report for Greenpeace and WWF from 2025-01-01 to 2025-03-31",
  },
  {
    icon: "📰",
    label: "Media only",
    prompt:
      "Fetch only media coverage for Clean Air Fund from 2025-04-01 to 2025-04-30",
  },
  {
    icon: "🤖",
    label: "LLM visibility",
    prompt:
      "Check LLM visibility for ClientEarth across ChatGPT, Perplexity, and Gemini",
  },
  {
    icon: "❓",
    label: "What can you do?",
    prompt: "What can you help me with?",
  },
];

// ─── Styles ────────────────────────────────────────────────────────────────
const styles: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    height: "100vh",
    background: "#0d1117",
    color: "#e6edf3",
    fontFamily: "'Segoe UI', system-ui, sans-serif",
    overflow: "hidden",
  },
  sidebar: {
    width: 240,
    background: "#161b22",
    borderRight: "1px solid #30363d",
    display: "flex",
    flexDirection: "column",
    padding: "20px 16px",
    flexShrink: 0,
  },
  logoWrap: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    marginBottom: 28,
  },
  logoMark: {
    width: 36,
    height: 36,
    background: "#00b37e",
    borderRadius: 10,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: 900,
    fontSize: 18,
    color: "#0d1117",
    flexShrink: 0,
  },
  logoName: {
    fontWeight: 700,
    fontSize: 15,
    letterSpacing: "-0.02em",
  },
  logoSub: {
    fontSize: 11,
    color: "#8b949e",
    marginTop: 1,
  },
  sideSection: {
    marginBottom: 24,
  },
  sideSectionTitle: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: "0.1em",
    color: "#8b949e",
    marginBottom: 8,
    textTransform: "uppercase" as const,
  },
  quickBtn: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    background: "none",
    border: "none",
    color: "#c9d1d9",
    cursor: "pointer",
    padding: "7px 8px",
    borderRadius: 6,
    fontSize: 12,
    textAlign: "left" as const,
    marginBottom: 2,
    transition: "background 0.15s",
  },
  viewReportBtn: {
    background: "rgba(0,179,126,0.1)",
    border: "1px solid rgba(0,179,126,0.3)",
    color: "#00b37e",
    borderRadius: 8,
    padding: "9px 12px",
    cursor: "pointer",
    fontWeight: 600,
    fontSize: 13,
    width: "100%",
    marginBottom: 12,
  },
  sideFooter: {
    fontSize: 11,
    color: "#484f58",
    textAlign: "center" as const,
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
    padding: "24px 32px",
    display: "flex",
    flexDirection: "column",
    gap: 16,
  },
  systemMsg: {
    background: "rgba(0,179,126,0.07)",
    border: "1px solid rgba(0,179,126,0.2)",
    borderRadius: 10,
    padding: "14px 18px",
    fontSize: 14,
    color: "#c9d1d9",
    lineHeight: 1.7,
    maxWidth: 680,
  },
  msgRow: {
    display: "flex",
    alignItems: "flex-end",
    gap: 10,
  },
  avatar: {
    width: 30,
    height: 30,
    background: "#00b37e",
    borderRadius: 8,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: 900,
    fontSize: 13,
    color: "#0d1117",
    flexShrink: 0,
  },
  avatarUser: {
    width: 30,
    height: 30,
    background: "#21262d",
    border: "1px solid #30363d",
    borderRadius: 8,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: 700,
    fontSize: 13,
    color: "#8b949e",
    flexShrink: 0,
  },
  bubble: {
    maxWidth: 680,
    padding: "12px 16px",
    borderRadius: 12,
    fontSize: 14,
    lineHeight: 1.7,
  },
  bubbleUser: {
    background: "#21262d",
    border: "1px solid #30363d",
    borderBottomRightRadius: 4,
  },
  bubbleAssistant: {
    background: "#161b22",
    border: "1px solid #21262d",
    borderBottomLeftRadius: 4,
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
    background: "#0d1117",
    border: "1px solid #21262d",
    borderRadius: 6,
    padding: "5px 10px",
    fontSize: 12,
  },
  reportBadge: {
    marginTop: 10,
    background: "rgba(0,179,126,0.1)",
    border: "1px solid rgba(0,179,126,0.2)",
    borderRadius: 6,
    padding: "7px 12px",
    fontSize: 12,
    color: "#00b37e",
  },
  costLine: {
    marginTop: 8,
    fontSize: 11,
    color: "#484f58",
  },
  inputBar: {
    display: "flex",
    alignItems: "flex-end",
    gap: 8,
    padding: "12px 32px 8px",
    borderTop: "1px solid #21262d",
    background: "#0d1117",
  },
  textarea: {
    flex: 1,
    background: "#161b22",
    border: "1px solid #30363d",
    borderRadius: 10,
    color: "#e6edf3",
    padding: "11px 14px",
    fontSize: 14,
    resize: "none" as const,
    outline: "none",
    fontFamily: "inherit",
    lineHeight: 1.6,
    overflowY: "auto" as const,
  },
  sendBtn: {
    width: 40,
    height: 40,
    background: "#00b37e",
    border: "none",
    borderRadius: 10,
    color: "#0d1117",
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
    padding: "4px 32px 12px",
    fontSize: 11,
    color: "#484f58",
  },
  reportOverlay: {
    position: "fixed" as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: "#0d1117",
    zIndex: 200,
    display: "flex",
    flexDirection: "column" as const,
  },
  reportHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 20px",
    background: "#161b22",
    borderBottom: "1px solid #30363d",
  },
  reportBtn: {
    background: "#21262d",
    border: "1px solid #30363d",
    color: "#c9d1d9",
    borderRadius: 6,
    padding: "6px 12px",
    cursor: "pointer",
    fontSize: 13,
  },
  reportFrame: {
    flex: 1,
    border: "none",
    width: "100%",
  },
};
