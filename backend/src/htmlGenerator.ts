// htmlGenerator.ts — generates a self-contained HTML report
import type { CalcResult } from "./calculator";
import type { LLMApiCost, CommentSentimentResult, WikipediaInfo } from "./tools";

export interface YouTubeChannelData {
  handle:               string;
  channel_title:        string;
  channel_id:           string;
  channel_total_views:  number;
  channel_subscribers:  number;
  channel_video_count:  number;
  top_videos: {
    title: string; videoId: string;
    views: number; likes: number; comments: number; publishedAt: string;
  }[];
}

export interface ToneEvidenceItem {
  org: string; outlet: string; tone: "A" | "N";
  article_title: string; article_link: string; article_date: string;
}

export interface LLMQueryResult {
  query: string; org: string; llm: string;
  mentioned: boolean; position?: number;
}

export interface ReportMeta {
  orgs: string[];
  date_range: { from: string; to: string };
  outlets: string[];
  llms: string[];
  client_name?: string;
  api_costs?: LLMApiCost[];
  claude_cost_usd?: number;
  serper_requests?: number;
  youtube_channels?: YouTubeChannelData[];
  comment_sentiment?: CommentSentimentResult[];
  /** Per-query LLM visibility results — drives Sample Query Performance table */
  llm_query_results?: LLMQueryResult[];
  /** Representative articles used to classify journalist tone per org × outlet */
  tone_evidence?: ToneEvidenceItem[];
  /** Wikipedia summaries for each org — shown when media coverage is thin */
  wiki_data?: Record<string, WikipediaInfo>;
}

export function generateHTMLReport(meta: ReportMeta, stats: CalcResult): string {
  const title = `Air Quality Media Intelligence Report`;
  const subtitle = `${meta.orgs.join(", ")} · ${meta.date_range.from} to ${meta.date_range.to}`;
  const generatedAt = new Date().toISOString();

  // YouTube channel cards + top-video tables
  const ytChannels = meta.youtube_channels ?? [];
  const ytFrom = meta.date_range?.from ? new Date(meta.date_range.from).getTime() : 0;
  const ytTo = meta.date_range?.to ? new Date(meta.date_range.to).getTime() : Infinity;
  const ytChannelCards = ytChannels.map(ch => {
    // Filter videos published within the report date range, with null-safe date parsing
    const videosInPeriod = (ch.top_videos ?? []).filter((v) => {
      if (!v.publishedAt) return false;
      const ts = new Date(v.publishedAt).getTime();
      return !isNaN(ts) && ts >= ytFrom && ts <= ytTo;
    });
    const videoCount = videosInPeriod.length;
    const label = videoCount === 0
      ? "No Videos Published in Period"
      : `Videos Published in Period · Sorted by Views at Time of Report`;
    return `
    <div class="yt-channel-card">
      <div class="yt-channel-header">
        <span class="yt-icon">▶</span>
        <div>
          <div class="yt-channel-title">${ch.channel_title}</div>
          <a class="yt-channel-link" href="https://youtube.com/channel/${ch.channel_id}" target="_blank">youtube.com/channel/${ch.channel_id}</a>
        </div>
      </div>
      <div class="yt-stats-row">
        <div class="yt-stat"><div class="yt-stat-label">All-Time Views</div><div class="yt-stat-value">${(ch.channel_total_views ?? 0).toLocaleString()}</div></div>
        <div class="yt-stat"><div class="yt-stat-label">Subscribers</div><div class="yt-stat-value">${(ch.channel_subscribers ?? 0).toLocaleString()}</div></div>
        <div class="yt-stat"><div class="yt-stat-label">Total Videos</div><div class="yt-stat-value">${(ch.channel_video_count ?? 0).toLocaleString()}</div></div>
      </div>
      <div class="yt-top-title">${label}</div>
      ${videoCount === 0 ? '<p style="color:var(--text-muted);font-size:12px;margin:8px 0">No videos were published within the selected date range.</p>' : `
      <table>
        <thead><tr><th>#</th><th>Title</th><th>Published</th><th>Views</th><th>Likes</th><th>Comments</th></tr></thead>
        <tbody>${videosInPeriod.map((v, i) => {
          const d = v.publishedAt ? new Date(v.publishedAt) : null;
          const dateStr = d && !isNaN(d.getTime()) ? d.toLocaleDateString() : "—";
          return `
          <tr>
            <td style="color:var(--text-muted)">${i + 1}</td>
            <td><a href="https://youtube.com/watch?v=${v.videoId}" target="_blank" style="color:var(--emerald);text-decoration:none">${v.title}</a></td>
            <td style="color:var(--text-muted)">${dateStr}</td>
            <td class="highlight">${(v.views ?? 0).toLocaleString()}</td>
            <td>${(v.likes ?? 0).toLocaleString()}</td>
            <td>${(v.comments ?? 0).toLocaleString()}</td>
          </tr>`;
        }).join("")}
        </tbody>
      </table>`}
    </div>`;
  }).join("");

  // Comment Sentiment section
  const sentimentData = meta.comment_sentiment ?? [];
  const sentimentRows = sentimentData.map((s) => {
    const total = s.total_relevant > 0 ? s.total_relevant : 1;
    const posPct = Math.round((s.positive / total) * 100);
    const neuPct = Math.round((s.neutral  / total) * 100);
    const negPct = Math.round((s.negative / total) * 100);
    const negClass = s.negative > s.positive && s.negative > s.neutral ? "bad" : s.negative > 0 ? "warn" : "";
    const topicsDisplay = s.negative_topics?.length
      ? s.negative_topics.map((t) => `<span style="display:inline-block;background:rgba(248,81,73,0.08);border:1px solid rgba(248,81,73,0.2);border-radius:4px;padding:1px 6px;font-size:11px;margin:1px">${t}</span>`).join(" ")
      : `<span style="color:var(--text-muted);font-size:11px">—</span>`;
    return `
      <tr>
        <td><strong>${s.org}</strong></td>
        <td class="good">${s.positive}<span style="color:var(--text-muted);font-weight:400;margin-left:5px">(${posPct}%)</span></td>
        <td style="color:var(--text-muted)">${s.neutral}<span style="margin-left:5px">(${neuPct}%)</span></td>
        <td class="${negClass}">${s.negative}<span style="color:var(--text-muted);font-weight:400;margin-left:5px">(${negPct}%)</span></td>
        <td style="color:var(--text-muted)">${s.total_relevant} <span style="font-size:11px">/ ${s.total_fetched} fetched</span></td>
        <td>${topicsDisplay}</td>
        <td style="font-style:italic;color:var(--text-muted);font-size:12px;max-width:280px">${s.verdict}</td>
      </tr>`;
  }).join("");

  // ── Wikipedia context section ────────────────────────────────────────────
  const wikiData = meta.wiki_data ?? {};
  const wikiEntries = Object.values(wikiData).filter((w) => w.found && w.summary);
  const wikiSection = wikiEntries.length > 0 ? `
<div id="wikipedia-context" class="section">
  <h2 class="section-title">Organisation Context
    <span class="source-badge source-stub" style="background:rgba(121,192,255,0.1);color:#79c0ff;border-color:rgba(121,192,255,0.25)">● Wikipedia</span>
  </h2>
  <p class="section-desc">Background context from Wikipedia — supplementary to media coverage data, not scored.</p>
  <div class="metric-note">
    Wikipedia summaries are fetched automatically when media coverage is thin, to provide context about
    each organisation's mandate and work. This data is <strong>not included in scoring</strong> —
    scores are based solely on actual media mentions, social engagement, and LLM visibility.
  </div>
  <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:16px">
    ${wikiEntries.map((w) => `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:18px 20px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
        <div style="font-family:'Syne',sans-serif;font-size:15px;font-weight:700">${w.title}</div>
        <a href="${w.url}" target="_blank" style="font-size:10px;color:var(--text-muted);text-decoration:none;margin-left:auto;white-space:nowrap">Wikipedia ↗</a>
      </div>
      <div style="font-size:13px;color:var(--text-muted);line-height:1.65">${w.summary}</div>
    </div>`).join("")}
  </div>
</div>` : "";

  // Cost data removed from report — only shown in sidebar widget

  // ── Social rows — Reach / Engagement sub-column grouping ──────────────────
  // Benchmark ER% per platform (Rival IQ 2025 Nonprofit medians)
  const ER_BENCHMARKS: Record<string, string> = {
    "youtube long-form": "1.72%",
    "youtube":           "1.72%",
    "youtube shorts":    "6.2%",
    "x":                 "2.44%",
    "instagram":         "0.56%",
    "linkedin":          "6.5%",
  };

  const socialRows = stats.social.map((s) => {
    const benchmark = ER_BENCHMARKS[s.platform.toLowerCase()] ?? "—";
    const vs = benchmark !== "—"
      ? (s.er_pct >= parseFloat(benchmark) ? `<span class="good">▲</span>` : `<span class="warn">▼</span>`)
      : "—";
    return `
      <tr>
        <td>${s.org}</td><td>${s.platform}</td>
        <td>${(s.impressions ?? 0).toLocaleString()}</td>
        <td>${(s.total_engagement ?? 0).toLocaleString()}</td>
        <td class="highlight">${s.er_pct ?? 0}%</td>
        <td style="color:var(--text-muted);font-size:12px">${benchmark}</td>
        <td>${vs}</td>
        <td>${(s.likes ?? 0).toLocaleString()}</td>
        <td>${(s.shares ?? 0) > 0 ? (s.shares ?? 0).toLocaleString() : "—"}</td>
        <td>${(s.comments ?? 0).toLocaleString()}</td>
        <td>${(s.saves ?? 0) > 0 ? (s.saves ?? 0).toLocaleString() : "—"}</td>
      </tr>`;
  }).join("");

  // Instagram / LinkedIn placeholders (handles not yet connected)
  const knownPlatformsPerOrg: Record<string, Set<string>> = {};
  for (const s of stats.social) {
    if (!knownPlatformsPerOrg[s.org]) knownPlatformsPerOrg[s.org] = new Set();
    knownPlatformsPerOrg[s.org].add(s.platform.toLowerCase());
  }
  const placeholderRows = meta.orgs.map((org) => {
    const known = knownPlatformsPerOrg[org] ?? new Set();
    const rows: string[] = [];
    for (const [p, bm] of [["Instagram", "0.56%"], ["LinkedIn", "6.5%"]] as const) {
      if (!known.has(p.toLowerCase())) {
        rows.push(`
          <tr style="opacity:0.45">
            <td>${org}</td><td>${p} <span style="font-size:10px;color:var(--text-muted)">(handle not confirmed)</span></td>
            <td>—</td><td>—</td><td>—</td><td style="font-size:12px;color:var(--text-muted)">${bm}</td><td>—</td>
            <td>—</td><td>—</td><td>—</td><td>—</td>
          </tr>`);
      }
    }
    return rows.join("");
  }).join("");

  // ── Media rows ──────────────────────────────────────────────────────────────
  const mediaRows = stats.media.map((m) => `
      <tr>
        <td>${m.org}</td>
        <td>${m.total_mentions}</td>
        <td>${m.dofollow_links}</td>
        <td>${m.direct_cites}</td>
        <td class="${m.aligned_tone_pct >= 60 ? "good" : "warn"}">${m.aligned_tone_pct}%</td>
        <td>${m.top_outlets.map((o) => `${o.outlet} (${o.mentions})`).join(", ")}</td>
      </tr>`).join("");

  // ── Journalist Tone Evidence ────────────────────────────────────────────────
  const toneEvidence = meta.tone_evidence ?? [];
  const toneEvidenceRows = toneEvidence.map((t) => `
      <tr>
        <td>${t.org}</td>
        <td>${t.outlet}</td>
        <td><span class="badge ${t.tone === "A" ? "tone-auth" : "tone-neutral"}">${t.tone === "A" ? "Authoritative" : "Neutral"}</span></td>
        <td><a href="${t.article_link}" target="_blank" style="color:var(--emerald);text-decoration:none">${t.article_title}</a></td>
        <td style="color:var(--text-muted);font-size:12px">${t.article_date}</td>
      </tr>`).join("");

  // ── AEO rows — X/20 format + visibility tier ────────────────────────────────
  const aeoRows = stats.aeo.map((a) => {
    const mentionDisplay = `${a.mention_count}/20 (${a.mention_rate_pct}%)`;
    const tierClass = a.visibility_tier === "High" ? "tier-high" : a.visibility_tier === "Moderate" ? "tier-moderate" : "tier-low";
    return `
      <tr>
        <td>${a.org}</td><td>${a.llm}</td>
        <td class="highlight">${mentionDisplay}</td>
        <td>${a.avg_position > 0 ? a.avg_position : "—"}</td>
        <td>${a.citation_type}</td>
        <td>${a.direct_links}</td>
        <td>${a.visibility_score}/100</td>
        <td><span class="badge ${tierClass}">${a.visibility_tier}</span></td>
      </tr>`;
  }).join("");

  // ── Sample Query Performance table ─────────────────────────────────────────
  const qResults = meta.llm_query_results ?? [];
  // Unique queries (preserve order)
  const uniqueQueries = [...new Set(qResults.map((q) => q.query))].slice(0, 10);
  // Unique org+llm combos for column headers
  const orgLlmCols = [...new Set(qResults.map((q) => `${q.org}|${q.llm}`))];
  const queryPerfRows = uniqueQueries.map((query) => {
    const cells = orgLlmCols.map((key) => {
      const [org, llm] = key.split("|");
      const r = qResults.find((x) => x.query === query && x.org === org && x.llm === llm);
      if (!r) return `<td style="color:var(--text-muted)">—</td>`;
      if (!r.mentioned) return `<td style="color:var(--bad)">✗</td>`;
      const pos = r.position != null ? ` #${r.position}` : "";
      return `<td class="good">✓${pos}</td>`;
    }).join("");
    return `<tr><td style="font-size:12px;max-width:300px">${query}</td>${cells}</tr>`;
  }).join("");
  const queryPerfHeaders = orgLlmCols.map((key) => {
    const [org, llm] = key.split("|");
    return `<th>${org}<br><span style="font-weight:400;text-transform:none;letter-spacing:0">${llm}</span></th>`;
  }).join("");

  // ── Scorecards ──────────────────────────────────────────────────────────────
  const scorecardCards = stats.scorecards.map((sc) => `
      <div class="scorecard-card grade-${sc.grade.toLowerCase()}">
        <div class="sc-org">${sc.org}</div>
        <div class="sc-grade">${sc.grade}</div>
        <div class="sc-overall">${sc.overall_score}/100</div>
        <div class="sc-breakdown">
          <span>Social: ${sc.social_score}</span>
          <span>Media: ${sc.media_score}</span>
          <span>AEO: ${sc.aeo_score}</span>
        </div>
      </div>`).join("");

  // ── Action Matrix — 4 categories ───────────────────────────────────────────
  const ACTION_META: Record<string, { css: string; emoji: string; label: string }> = {
    "Fix Now":  { css: "fix-now",  emoji: "🟠", label: "Fix Now — act this week" },
    "Leverage": { css: "leverage", emoji: "🟢", label: "Leverage — double down" },
    "Optimise": { css: "optimise", emoji: "🔵", label: "Optimise — 4–8 weeks" },
    "Invest":   { css: "invest",   emoji: "🔴", label: "Invest — platform gap" },
  };
  const actionRows = stats.action_matrix.map((a) => {
    const m = ACTION_META[a.priority] ?? { css: "fix-now", emoji: "⚪", label: a.priority };
    return `
      <tr>
        <td>${a.org}</td>
        <td><span class="badge action-${m.css}">${m.emoji} ${a.priority}</span></td>
        <td>${a.area}</td>
        <td>${a.action}</td>
        <td style="font-size:12px;color:var(--text-muted)">${a.rationale}</td>
      </tr>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Syne:wght@600;700;800&display=swap" rel="stylesheet" />
<style>
  :root {
    --emerald: #00b37e; --emerald-dark: #007a55;
    --bg: #0d1117; --surface: #161b22; --surface2: #21262d;
    --border: #30363d; --text: #e6edf3; --text-muted: #8b949e;
    --good: #3fb950; --warn: #d29922; --bad: #f85149;
    --grade-a:#3fb950; --grade-b:#79c0ff; --grade-c:#d29922; --grade-d:#ffa657; --grade-f:#f85149;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: 'Inter', system-ui, sans-serif; font-size: 14px; line-height: 1.6; -webkit-font-smoothing: antialiased; }

  /* Cover */
  .cover { background: linear-gradient(135deg,#0d1117 0%,#0a2e1e 55%,#0d1117 100%); padding: 72px 48px 56px; border-bottom: 1px solid var(--border); position:relative; }
  .confidential-badge { position:absolute; top:24px; right:48px; background:rgba(248,81,73,0.12); border:1px solid rgba(248,81,73,0.3); color:var(--bad); font-family:'Inter',sans-serif; font-size:10px; font-weight:700; letter-spacing:0.15em; text-transform:uppercase; padding:4px 12px; border-radius:20px; }
  .cover-logo { font-family:'Inter',sans-serif; font-size:11px; font-weight:600; letter-spacing:0.18em; color:var(--emerald); text-transform:uppercase; margin-bottom:36px; opacity:0.9; }
  .cover-title { font-family:'Syne',sans-serif; font-size:42px; font-weight:800; line-height:1.1; margin-bottom:14px; background:linear-gradient(100deg,#ffffff 30%,var(--emerald)); -webkit-background-clip:text; -webkit-text-fill-color:transparent; background-clip:text; letter-spacing:-0.02em; }
  .cover-subtitle { font-family:'Inter',sans-serif; font-size:15px; font-weight:400; color:var(--text-muted); margin-bottom:32px; letter-spacing:0.01em; }
  .cover-meta { display:flex; gap:12px; flex-wrap:wrap; margin-top:8px; }
  .cover-meta-item { background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); border-radius:10px; padding:14px 18px; backdrop-filter:blur(4px); }
  .cover-meta-label { font-family:'Inter',sans-serif; font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:0.12em; color:var(--text-muted); }
  .cover-meta-value { font-family:'Inter',sans-serif; font-size:13px; font-weight:600; margin-top:5px; color:var(--text); }
  .cover-benchmarks { margin-top:24px; font-family:'Inter',sans-serif; font-size:11px; color:var(--text-muted); }
  .cover-benchmarks strong { color:#c9d1d9; }

  /* Nav */
  .nav { background:rgba(22,27,34,0.95); border-bottom:1px solid var(--border); padding:0 48px; position:sticky; top:0; z-index:100; display:flex; gap:0; overflow-x:auto; backdrop-filter:blur(8px); }
  .nav a { display:block; padding:14px 16px; color:var(--text-muted); text-decoration:none; font-family:'Inter',sans-serif; font-size:12px; font-weight:500; letter-spacing:0.02em; white-space:nowrap; border-bottom:2px solid transparent; transition:all 0.2s; }
  .nav a:hover { color:var(--emerald); border-bottom-color:var(--emerald); }

  /* Sections */
  .section { padding:48px; border-bottom:1px solid var(--border); }
  .section-title { font-family:'Syne',sans-serif; font-size:20px; font-weight:700; letter-spacing:-0.01em; margin-bottom:6px; display:flex; align-items:center; gap:12px; }
  .section-title::before { content:''; display:inline-block; width:3px; height:22px; background:var(--emerald); border-radius:2px; flex-shrink:0; }
  .section-desc { font-family:'Inter',sans-serif; color:var(--text-muted); margin-bottom:28px; font-size:13px; }
  .subsection-title { font-family:'Syne',sans-serif; font-size:16px; font-weight:700; margin-bottom:8px; display:flex; align-items:center; gap:10px; }

  /* Tables */
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { background:var(--surface2); padding:11px 14px; text-align:left; font-family:'Inter',sans-serif; font-weight:600; font-size:10px; text-transform:uppercase; letter-spacing:0.1em; color:var(--text-muted); border-bottom:1px solid var(--border); }
  .th-group { background:rgba(0,179,126,0.06); color:var(--emerald); font-size:9px; text-align:center; border-bottom:1px solid var(--border); padding:6px 14px; }
  td { padding:11px 14px; border-bottom:1px solid var(--border); vertical-align:top; font-family:'Inter',sans-serif; font-size:13px; }
  tr:hover td { background:rgba(255,255,255,0.02); }
  .highlight { color:var(--emerald); font-weight:600; }
  .good { color:var(--good); font-weight:600; }
  .warn { color:var(--warn); font-weight:600; }
  .bad { color:var(--bad); }

  /* Scorecards */
  .scorecards-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:16px; }
  .scorecard-card { background:var(--surface); border:1px solid var(--border); border-radius:14px; padding:28px 24px; text-align:center; }
  .sc-org { font-family:'Inter',sans-serif; font-size:12px; font-weight:500; letter-spacing:0.03em; color:var(--text-muted); margin-bottom:14px; text-transform:uppercase; }
  .sc-grade { font-family:'Syne',sans-serif; font-size:60px; font-weight:800; line-height:1; margin-bottom:6px; }
  .sc-overall { font-family:'Inter',sans-serif; font-size:18px; font-weight:700; margin-bottom:14px; }
  .sc-breakdown { display:flex; flex-direction:column; gap:4px; font-family:'Inter',sans-serif; font-size:12px; color:var(--text-muted); }
  .grade-a .sc-grade{color:var(--grade-a)} .grade-b .sc-grade{color:var(--grade-b)} .grade-c .sc-grade{color:var(--grade-c)} .grade-d .sc-grade{color:var(--grade-d)} .grade-f .sc-grade{color:var(--grade-f)}

  /* Badges */
  .badge { display:inline-block; padding:3px 9px; border-radius:20px; font-family:'Inter',sans-serif; font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:0.07em; }
  /* Action priority badges */
  .action-fix-now  { background:rgba(255,140,0,0.12); color:#ffa657; border:1px solid rgba(255,140,0,0.25); }
  .action-leverage { background:rgba(63,185,80,0.12);  color:#3fb950; border:1px solid rgba(63,185,80,0.25); }
  .action-optimise { background:rgba(121,192,255,0.12); color:#79c0ff; border:1px solid rgba(121,192,255,0.25); }
  .action-invest   { background:rgba(248,81,73,0.12);  color:#f85149; border:1px solid rgba(248,81,73,0.2); }
  /* Visibility tier badges */
  .tier-high     { background:rgba(63,185,80,0.12);   color:#3fb950; border:1px solid rgba(63,185,80,0.25); }
  .tier-moderate { background:rgba(210,153,34,0.12);  color:#d29922; border:1px solid rgba(210,153,34,0.25); }
  .tier-low      { background:rgba(248,81,73,0.12);   color:#f85149; border:1px solid rgba(248,81,73,0.2); }
  /* Tone badges */
  .tone-auth    { background:rgba(0,179,126,0.12); color:var(--emerald); border:1px solid rgba(0,179,126,0.25); }
  .tone-neutral { background:rgba(139,148,158,0.12); color:var(--text-muted); border:1px solid rgba(139,148,158,0.2); }

  /* Misc */
  .sanity-box { background:rgba(210,153,34,0.08); border:1px solid rgba(210,153,34,0.25); border-radius:10px; padding:16px 20px; margin-bottom:24px; }
  .sanity-box h4 { font-family:'Inter',sans-serif; color:var(--warn); margin-bottom:8px; font-size:13px; font-weight:600; }
  .sanity-box ul { padding-left:16px; color:var(--text-muted); font-size:12px; }
  .source-badge { display:inline-flex; align-items:center; gap:5px; font-family:'Inter',sans-serif; font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:0.08em; padding:3px 8px; border-radius:20px; margin-left:10px; vertical-align:middle; }
  .source-real { background:rgba(63,185,80,0.12); color:#3fb950; border:1px solid rgba(63,185,80,0.25); }
  .source-stub { background:rgba(210,153,34,0.12); color:#d29922; border:1px solid rgba(210,153,34,0.25); }
  .metric-note { font-family:'Inter',sans-serif; font-size:12px; color:var(--text-muted); background:rgba(255,255,255,0.03); border:1px solid var(--border); border-radius:8px; padding:12px 16px; margin-bottom:20px; line-height:1.7; }
  .metric-note strong { color:#c9d1d9; }
  .vis-scale { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:20px; }
  .vis-scale-item { background:var(--surface); border:1px solid var(--border); border-radius:8px; padding:10px 16px; font-family:'Inter',sans-serif; font-size:12px; }
  .vis-scale-item strong { display:block; font-size:13px; margin-bottom:3px; }

  /* YouTube */
  .yt-channel-card { background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:20px 24px; margin-bottom:20px; }
  .yt-channel-header { display:flex; align-items:center; gap:12px; margin-bottom:16px; }
  .yt-icon { font-size:20px; color:#ff4e45; }
  .yt-channel-title { font-family:'Syne',sans-serif; font-size:16px; font-weight:700; }
  .yt-channel-link { font-family:'Inter',sans-serif; font-size:11px; color:var(--text-muted); text-decoration:none; }
  .yt-stats-row { display:flex; gap:12px; margin-bottom:20px; flex-wrap:wrap; }
  .yt-stat { background:rgba(255,255,255,0.03); border:1px solid var(--border); border-radius:8px; padding:10px 16px; min-width:130px; }
  .yt-stat-label { font-family:'Inter',sans-serif; font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:0.1em; color:var(--text-muted); margin-bottom:4px; }
  .yt-stat-value { font-family:'Syne',sans-serif; font-size:18px; font-weight:700; color:var(--text); }
  .yt-top-title { font-family:'Inter',sans-serif; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.1em; color:var(--text-muted); margin-bottom:10px; }

  /* Cost */
  .cost-summary { display:flex; gap:12px; flex-wrap:wrap; margin-bottom:8px; }
  .cost-card { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:16px 20px; min-width:160px; }
  .cost-label { font-family:'Inter',sans-serif; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.1em; color:var(--text-muted); margin-bottom:6px; }
  .cost-value { font-family:'Syne',sans-serif; font-size:22px; font-weight:700; color:var(--emerald); }

  /* Footer */
  .footer { padding:28px 48px; text-align:center; color:var(--text-muted); font-family:'Inter',sans-serif; font-size:12px; letter-spacing:0.02em; }
  .footer strong { color:var(--emerald); }
</style>
</head>
<body>

<!-- ══ COVER ══════════════════════════════════════════════════════════════════ -->
<div class="cover">
  <div class="confidential-badge">Confidential</div>
  <div class="cover-logo">Emerald AI · Air Quality Intelligence</div>
  <h1 class="cover-title">${title}</h1>
  <p class="cover-subtitle">${subtitle}</p>
  <div class="cover-meta">
    ${meta.client_name ? `<div class="cover-meta-item"><div class="cover-meta-label">Prepared for</div><div class="cover-meta-value">${meta.client_name}</div></div>` : ""}
    <div class="cover-meta-item"><div class="cover-meta-label">Prepared by</div><div class="cover-meta-value">Emerald AI</div></div>
    <div class="cover-meta-item"><div class="cover-meta-label">Organisations</div><div class="cover-meta-value">${meta.orgs.join(", ")}</div></div>
    <div class="cover-meta-item"><div class="cover-meta-label">Period</div><div class="cover-meta-value">${meta.date_range.from} → ${meta.date_range.to}</div></div>
    <div class="cover-meta-item"><div class="cover-meta-label">Outlets</div><div class="cover-meta-value">${meta.outlets.join(", ")}</div></div>
    <div class="cover-meta-item"><div class="cover-meta-label">LLMs</div><div class="cover-meta-value">${meta.llms.join(", ")}</div></div>
    <div class="cover-meta-item"><div class="cover-meta-label">Generated</div><div class="cover-meta-value">${new Date(generatedAt).toLocaleString()}</div></div>
  </div>
  <div class="cover-benchmarks">
    <strong>Benchmarks:</strong>&nbsp;
    Rival IQ 2025 Nonprofit Industry Report &nbsp;·&nbsp; Hootsuite 2025 &nbsp;·&nbsp; Sprout Social 2025 &nbsp;·&nbsp; Metricool/Statista 2024
    &nbsp;·&nbsp; All benchmarks use medians (not averages) — resistant to viral outliers.
  </div>
</div>

<nav class="nav">
  <a href="#methodology">Methodology</a>
  <a href="#social">Social</a>
  <a href="#media">Media</a>
  <a href="#journalist-tone">Journalist Tone</a>
  ${wikiEntries.length > 0 ? `<a href="#wikipedia-context">Org Context</a>` : ""}
  <a href="#aeo">AEO / LLM</a>
  <a href="#scorecards">Scorecards</a>
  <a href="#action-matrix">Action Matrix</a>
  <a href="#cost">Cost</a>
</nav>

${stats.sanity_errors?.length ? `<div class="section"><div class="sanity-box"><h4>⚠ Data Quality Warnings</h4><ul>${stats.sanity_errors.map((e)=>`<li>${e}</li>`).join("")}</ul></div></div>` : ""}

<!-- ══ METHODOLOGY ═══════════════════════════════════════════════════════════ -->
<div id="methodology" class="section">
  <h2 class="section-title">Methodology &amp; Definitions</h2>
  <p class="section-desc">How each table is built, what the metrics mean, and which benchmarks are used.</p>
  <div class="metric-note">
    <strong>Table 1 — Social Media Engagement</strong><br>
    Platforms: YouTube (Long-form + Shorts), X/Twitter, Instagram, LinkedIn — where confirmed handles exist.
    <em>ER % = engagement metrics ÷ impressions × 100.</em>
    Benchmarks = Rival IQ 2025 Nonprofit medians (150+ orgs, same 3-month window). Medians used over averages — one viral post can inflate an average by 10×.
    YouTube impressions = cumulative views across the top 10 most-viewed videos (all-time; YouTube Data API v3 does not support date-filtered views without Analytics OAuth).
    X impressions = via X API v2 (own account data only).
    Instagram &amp; LinkedIn handles shown as "—" until confirmed.<br><br>
    <strong>Table 2 — Media Coverage</strong><br>
    Outlets tracked via Serper News API (Google News index). Tone classification:
    <strong style="color:var(--emerald)">A = Authoritative</strong> — org is the primary expert source, researcher quoted directly.
    <strong style="color:var(--text-muted)">N = Neutral</strong> — org is mentioned among several sources but not as the lead expert.
    This is NOT a positive/negative scale. Authoritative tone is the goal — it directly raises LLM citation probability.
    Dofollow links estimated at 60% of mentions for major outlets (verified via SEMrush where available).<br><br>
    <strong>Table 3 — LLM / AEO Visibility</strong><br>
    5 generic discovery queries per LLM run live via official APIs (ChatGPT-4o, Perplexity AI, Google Gemini).
    Queries are deliberately generic — the score measures whether the org is mentioned <em>unprompted</em>, which is the true test of LLM visibility.
    Mention rate expressed as X/20. Position = rank of first mention in the response (1 = named first).
    AI Visibility Scale is Emerald AI v1.0 — no universal industry standard exists as of 2025.
    Methodology reference: Aggarwal et al. (2023) <em>GEO: Generative Engine Optimisation</em> — <a href="https://arxiv.org/abs/2311.09735" target="_blank" style="color:var(--emerald)">arxiv.org/abs/2311.09735</a>
  </div>
</div>

<!-- ══ SOCIAL ═════════════════════════════════════════════════════════════════ -->
<div id="social" class="section">
  <h2 class="section-title">Social Media Engagement
    <span class="source-badge source-real">● YouTube Live</span>
    <span class="source-badge source-stub">○ X Simulated</span>
  </h2>
  <p class="section-desc">Reach and engagement across YouTube (Long-form + Shorts) and X. Benchmarks = Rival IQ 2025 Nonprofit medians.</p>
  <div class="metric-note">
    <strong>Impressions / Views</strong> — top-10 video views (all-time, YouTube Data API v3 limitation). &nbsp;
    <strong>ER %</strong> — engagement ÷ impressions × 100. &nbsp;
    <strong>Benchmark</strong> — Rival IQ 2025 medians: YT Long-form 1.72%, YT Shorts 6.2%, X 2.44%. &nbsp;
    <strong>▲ / ▼</strong> — above / below benchmark. &nbsp;
    <strong>Shares / Saves</strong> — not public via YouTube Data API v3 (shown as —). &nbsp;
    <strong>X figures</strong> — simulated (X API v2 requires a paid subscription).
  </div>

  ${ytChannels.length > 0 ? `<div style="margin-bottom:28px">${ytChannelCards}</div>` : ""}

  ${sentimentRows ? `
  <div style="margin-bottom:36px">
    <div class="subsection-title">Comment Sentiment Analysis
      <span class="source-badge source-real">● GPT-4o-mini · YouTube only</span>
    </div>
    <div class="metric-note" style="margin-bottom:14px">
      <strong>Methodology</strong> — Up to 250 comments fetched from top 5 videos per org (YouTube Data API v3 commentThreads).
      GPT-4o-mini step 1: <em>filter</em> — discard generic reactions, spam, off-topic comments; keep only org-relevant comments.
      Step 2: <em>classify</em> each kept comment as <strong style="color:var(--good)">Positive</strong>, <span style="color:var(--text-muted)">Neutral</span>, or <strong style="color:var(--bad)">Negative</strong>.
      Step 3: <em>extract recurring negative topics</em> for root-cause diagnosis.
      The <strong>Verdict</strong> is a GPT-generated one-sentence summary.
    </div>
    <table>
      <thead><tr>
        <th>Organisation</th><th>Positive</th><th>Neutral</th><th>Negative</th>
        <th>Relevant / Fetched</th><th>Negative Spike Topics</th><th>Verdict</th>
      </tr></thead>
      <tbody>${sentimentRows}</tbody>
    </table>
  </div>` : ""}

  <div class="subsection-title" style="margin-bottom:14px">Platform Engagement Summary</div>
  <table>
    <thead>
      <tr>
        <th rowspan="2">Organisation</th>
        <th rowspan="2">Platform</th>
        <th colspan="3" class="th-group">REACH METRICS</th>
        <th colspan="4" class="th-group">ENGAGEMENT METRICS</th>
        <th rowspan="2">ER %</th>
        <th rowspan="2">Benchmark</th>
        <th rowspan="2">vs Bench</th>
      </tr>
      <tr>
        <th>Impressions</th><th>Engagement</th><th>Likes</th>
        <th>Shares</th><th>Comments</th><th>Saves</th><th></th>
      </tr>
    </thead>
    <tbody>${socialRows}${placeholderRows}</tbody>
  </table>
</div>

<!-- ══ MEDIA ══════════════════════════════════════════════════════════════════ -->
<div id="media" class="section">
  <h2 class="section-title">Media Coverage
    <span class="source-badge source-real">● Serper News API</span>
  </h2>
  <p class="section-desc">News mentions, dofollow links, direct citations, and journalist tone across tracked outlets. AQ content only.</p>
  <div class="metric-note">
    <strong>Total Mentions</strong> — articles found via Serper News API (Google News index). Uses a 5-tier fallback: (1) site-specific search, (2) quoted org name, (3) topic-only search, (4) backup specialist outlets (Down To Earth, The Wire, Mongabay India, Scroll, The Print, etc.), (5) broad web search. Outlet names marked with ★ were found through backup searches. &nbsp;
    <strong>Dofollow Links</strong> — estimated backlinks passing domain authority (60% of mentions for major outlets). &nbsp;
    <strong>Direct Cites</strong> — articles whose snippet or title explicitly names the organisation. &nbsp;
    <strong>Authoritative Tone %</strong> — % of outlet rows where tone = A (org is primary expert source, researcher quoted). <em>N = Neutral (not negative)</em> — org mentioned among peers. Authoritative coverage directly raises LLM citation probability.
  </div>
  <table>
    <thead><tr>
      <th>Organisation</th><th>Total Mentions</th><th>Dofollow Links</th>
      <th>Direct Cites</th><th>Authoritative Tone %</th><th>Top Outlets by Mentions</th>
    </tr></thead>
    <tbody>${mediaRows}</tbody>
  </table>
</div>

${wikiSection}

<!-- ══ JOURNALIST TONE ════════════════════════════════════════════════════════ -->
<div id="journalist-tone" class="section">
  <h2 class="section-title">Journalist Tone Evidence
    <span class="source-badge source-real">● Serper Articles</span>
  </h2>
  <p class="section-desc">Representative articles used to classify journalist tone per organisation × outlet. Every tone classification is traceable to a source article.</p>
  <div class="metric-note">
    <strong>Authoritative</strong> — org is cited as the primary expert source; researcher quoted directly; research named as the primary data anchor. &nbsp;
    <strong>Neutral</strong> — org is mentioned among several sources; not positioned as the lead expert. &nbsp;
    Tone is scored per outlet per org, including when the org is one of several sources cited in an article.
    Articles shown are representative — first result returned for that outlet × org combination via Serper News API.
  </div>
  ${toneEvidenceRows ? `
  <table>
    <thead><tr>
      <th>Organisation</th><th>Outlet</th><th>Tone</th><th>Representative Article</th><th>Date</th>
    </tr></thead>
    <tbody>${toneEvidenceRows}</tbody>
  </table>` : `<p style="color:var(--text-muted);font-size:13px">No tone evidence data — run fetch_serper to populate this section.</p>`}
</div>

<!-- ══ AEO / LLM ══════════════════════════════════════════════════════════════ -->
<div id="aeo" class="section">
  <h2 class="section-title">AEO / LLM Visibility
    <span class="source-badge source-real">● Live API Calls</span>
  </h2>
  <p class="section-desc">How often each organisation appears in LLM responses to generic air-quality discovery queries. 5 queries per LLM, scored out of 20.</p>

  <div class="metric-note">
    <strong>Methodology</strong> — 5 generic discovery queries run live per LLM (ChatGPT, Perplexity, Gemini). Queries are deliberately non-org-specific — the score measures unprompted natural mentions, which is the true test of AEO effectiveness. Reference: Aggarwal et al. (2023) <em>GEO</em> paper. &nbsp;
    <strong>Mention Rate (X/20)</strong> — number of queries where the org name appeared. &nbsp;
    <strong>Avg Position</strong> — where in the response the org first appeared (1 = named first, 5 = late). — = never mentioned. &nbsp;
    <strong>Citation Type</strong> — Direct: org URL in response; Passing: named but no link; None: not mentioned. &nbsp;
    <strong>Visibility Score</strong> — 0–100 composite: 40pts mention rate, 30pts position, 30pts citation depth.
  </div>

  <div class="vis-scale">
    <div class="vis-scale-item"><strong class="tier-high" style="font-size:12px">High</strong>&nbsp; &gt;65% (13+/20) AND avg pos ≤ 2.0</div>
    <div class="vis-scale-item"><strong class="tier-moderate" style="font-size:12px">Moderate</strong>&nbsp; 40–65% (8–13/20) OR avg pos 2.0–3.0</div>
    <div class="vis-scale-item"><strong class="tier-low" style="font-size:12px">Low</strong>&nbsp; &lt;40% (&lt;8/20) AND avg pos &gt; 3.0</div>
    <div class="vis-scale-item" style="font-size:11px;color:var(--text-muted)">Emerald AI Visibility Scale v1.0 — no universal industry standard exists as of 2025</div>
  </div>

  <table style="margin-bottom:32px">
    <thead><tr>
      <th>Organisation</th><th>LLM</th><th>Mention Rate</th><th>Avg Position</th>
      <th>Citation Type</th><th>Direct Links</th><th>Visibility Score</th><th>Tier</th>
    </tr></thead>
    <tbody>${aeoRows}</tbody>
  </table>

  ${uniqueQueries.length > 0 ? `
  <div class="subsection-title" style="margin-bottom:8px">Sample Query Performance</div>
  <div class="metric-note" style="margin-bottom:14px">
    Exact queries sent to each LLM. ✓ = mentioned (with first position number). ✗ = not mentioned. ~ = partial/ambiguous mention.
    Queries are generic discovery questions — not org-specific.
  </div>
  <table>
    <thead><tr>
      <th>Query (sent verbatim to LLM)</th>${queryPerfHeaders}
    </tr></thead>
    <tbody>${queryPerfRows}</tbody>
  </table>` : ""}
</div>

<!-- ══ SCORECARDS ═════════════════════════════════════════════════════════════ -->
<div id="scorecards" class="section">
  <h2 class="section-title">Organisation Scorecards</h2>
  <p class="section-desc">Weighted composite: Social 30% · Media 40% · AEO 30% &nbsp;|&nbsp; A ≥80 · B 65–79 · C 50–64 · D 35–49 · F &lt;35</p>
  <div class="scorecards-grid">${scorecardCards}</div>
</div>

<!-- ══ ACTION MATRIX ══════════════════════════════════════════════════════════ -->
<div id="action-matrix" class="section">
  <h2 class="section-title">AI Insights — Action Matrix</h2>
  <p class="section-desc">Every insight references specific numbers from Tables 1–3. Rows = organisations (scalable). Columns = priority type.</p>
  <div class="metric-note" style="margin-bottom:20px">
    <span class="badge action-fix-now">🟠 Fix Now</span>&nbsp; Urgent risk — act this week. &nbsp;&nbsp;
    <span class="badge action-leverage">🟢 Leverage</span>&nbsp; Highest-value asset — double down. &nbsp;&nbsp;
    <span class="badge action-optimise">🔵 Optimise</span>&nbsp; Structural fix — 4–8 weeks. &nbsp;&nbsp;
    <span class="badge action-invest">🔴 Invest</span>&nbsp; Platform gap vs benchmark — allocate resource.
  </div>
  <table>
    <thead><tr>
      <th>Organisation</th><th>Priority</th><th>Area</th><th>Action</th><th>Rationale (data-anchored)</th>
    </tr></thead>
    <tbody>${actionRows}</tbody>
  </table>
</div>

<footer class="footer">
  Generated by <strong>Emerald AI</strong> · Air Quality Media Intelligence Platform · ${new Date(generatedAt).toUTCString()} · <strong>CONFIDENTIAL</strong>
</footer>

</body>
</html>`;
}
