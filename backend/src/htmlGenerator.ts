// htmlGenerator.ts — generates a self-contained HTML report
import type { CalcResult } from "./calculator";
import type { LLMApiCost, CommentSentimentResult, WikipediaInfo } from "./tools";

// ── Report Template ───────────────────────────────────────────────────────────

export interface TemplateSectionConfig {
  id: string;
  enabled: boolean;
  title: string;
  description: string;
}

export interface ReportTemplate {
  reportTitle?: string;
  clientName?: string;
  sections: TemplateSectionConfig[];
}

export const DEFAULT_SECTIONS: TemplateSectionConfig[] = [
  { id: "methodology",      enabled: true, title: "Methodology",
    description: "How data was collected, filtered, and analysed." },
  { id: "social",           enabled: true, title: "Social Media Engagement",
    description: "Reach and engagement across YouTube (Long-form + Shorts) and X. Benchmarks = Rival IQ 2025 Nonprofit medians." },
  { id: "media",            enabled: true, title: "Media Coverage",
    description: "News mentions, dofollow links, direct citations, and journalist tone across tracked outlets. AQ content only." },
  { id: "tv_coverage",          enabled: true, title: "TV Channel Coverage",
    description: "Coverage across English and Hindi TV channels: NDTV, News18, India Today, Aaj Tak, India TV, ABP News." },
  { id: "coverage_momentum",    enabled: true, title: "Coverage Momentum",
    description: "Whether each org's media coverage is accelerating or decelerating across the report period, based on first-half vs second-half article distribution." },
  { id: "citation_quality",     enabled: true, title: "Citation Quality",
    description: "How each org is cited: specific data/statistics cited vs. named in passing. Evidence links for every data citation." },
  { id: "emerging_narratives",  enabled: true, title: "Emerging Narratives",
    description: "AI-inferred topic clusters that appear repeatedly across coverage — topics gaining momentum that are distinct from each org's established focus." },
  { id: "wikipedia",        enabled: true, title: "Organisation Context",
    description: "Background context from Wikipedia — supplementary to media coverage data, not scored." },
  { id: "aeo",              enabled: true, title: "AEO / LLM Visibility",
    description: "How often each organisation appears in LLM responses to generic air-quality discovery queries. 5 queries per LLM, scored out of 20." },
  { id: "scorecards",       enabled: true, title: "Organisation Scorecards",
    description: "Weighted composite: Social 30% · Media 40% · AEO 30% | A ≥80 · B 65–79 · C 50–64 · D 35–49 · F <35" },
  { id: "action_matrix",    enabled: true, title: "AI Insights — Action Matrix",
    description: "Every insight references specific numbers from Tables 1–3. Rows = organisations. Columns = priority type." },
];

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
  /** Articles where the org name appears in snippet/title — evidence for Citation Quality section */
  citation_evidence?: {
    org: string; outlet: string;
    article_title: string; article_link: string; article_date: string; snippet: string;
  }[];
  /** Wikipedia summaries for each org — shown when media coverage is thin */
  wiki_data?: Record<string, WikipediaInfo>;
  /** AI-inferred emerging narrative clusters per org */
  emerging_narratives?: {
    org: string;
    topic: string;
    inference: string;
    articles: { title: string; link: string; outlet?: string; date?: string }[];
  }[];
}

export function generateHTMLReport(meta: ReportMeta, stats: CalcResult, template?: ReportTemplate): string {
  // ── Template helpers ────────────────────────────────────────────────────────
  const tmplSections = template?.sections?.length ? template.sections : DEFAULT_SECTIONS;
  const sectionMap = Object.fromEntries(tmplSections.map(s => [s.id, s]));
  const isEnabled = (id: string) => sectionMap[id]?.enabled !== false;
  const getTitle = (id: string, fallback: string) => sectionMap[id]?.title?.trim() || fallback;
  const getDesc = (id: string, fallback: string) => sectionMap[id]?.description?.trim() || fallback;

  const title = template?.reportTitle?.trim() || `Air Quality Media Intelligence Report`;
  const clientName = template?.clientName?.trim() || meta.client_name;
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

  // Comment Sentiment section — visual cards + table
  const sentimentData = meta.comment_sentiment ?? [];
  const sentimentCards = sentimentData.map((s) => {
    const total = s.total_relevant > 0 ? s.total_relevant : 1;
    const posPct = Math.round((s.positive / total) * 100);
    const neuPct = Math.round((s.neutral  / total) * 100);
    const negPct = Math.round((s.negative / total) * 100);
    const topicsDisplay = s.negative_topics?.length
      ? s.negative_topics.map((t) => `<span style="display:inline-block;background:rgba(248,81,73,0.08);border:1px solid rgba(248,81,73,0.2);border-radius:4px;padding:2px 8px;font-size:11px;margin:2px">${t}</span>`).join(" ")
      : `<span style="color:var(--text-muted);font-size:11px">No recurring negative themes</span>`;
    return `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:24px;margin-bottom:14px">
      <div style="font-family:'Syne',sans-serif;font-size:16px;font-weight:700;margin-bottom:18px">${s.org}</div>
      <div style="display:flex;gap:20px;flex-wrap:wrap;margin-bottom:16px">
        <div style="text-align:center;min-width:90px">
          <div style="font-family:'Syne',sans-serif;font-size:36px;font-weight:800;color:var(--good)">${posPct}%</div>
          <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.1em">Positive</div>
          <div style="font-size:12px;color:var(--text-muted)">${s.positive} comments</div>
        </div>
        <div style="text-align:center;min-width:90px">
          <div style="font-family:'Syne',sans-serif;font-size:36px;font-weight:800;color:var(--text-muted)">${neuPct}%</div>
          <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.1em">Neutral</div>
          <div style="font-size:12px;color:var(--text-muted)">${s.neutral} comments</div>
        </div>
        <div style="text-align:center;min-width:90px">
          <div style="font-family:'Syne',sans-serif;font-size:36px;font-weight:800;color:var(--bad)">${negPct}%</div>
          <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.1em">Negative</div>
          <div style="font-size:12px;color:var(--text-muted)">${s.negative} comments</div>
        </div>
        <div style="flex:1;min-width:200px;display:flex;flex-direction:column;justify-content:center">
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:var(--text-muted);margin-bottom:6px">Negative spike topics</div>
          <div>${topicsDisplay}</div>
          ${s.verdict ? `<div style="margin-top:10px;font-size:12px;font-style:italic;color:var(--text-muted)">${s.verdict}</div>` : ""}
        </div>
      </div>
      <div style="font-size:11px;color:var(--text-muted)">${s.total_relevant} relevant / ${s.total_fetched} fetched from top 5 videos · GPT-4o-mini classification</div>
    </div>`;
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

  // Group social rows by org so we can rowspan the org cell
  const socialRowsByOrg: Record<string, any[]> = {};
  for (const s of stats.social) {
    (socialRowsByOrg[s.org] = socialRowsByOrg[s.org] || []).push(s);
  }

  const ER_BM = ER_BENCHMARKS;

  const socialRows = meta.orgs.flatMap((org) => {
    const rows: any[] = socialRowsByOrg[org] ?? [];
    const known = new Set(rows.map((s: any) => s.platform.toLowerCase()));
    const placeholderPlatforms = ['Instagram','LinkedIn'].filter(p => !known.has(p.toLowerCase()));
    const allRows = [...rows.map((s: any) => ({ ...s, isPlaceholder: false })), ...placeholderPlatforms.map(p => ({ org, platform: p, impressions:0, likes:0, shares:0, comments:0, saves:0, quote_rt:0, er_pct:0, isPlaceholder: true }))];
    const totalRows = allRows.length;
    return allRows.map((s: any, i: number) => {
      const orgCell = i === 0 ? `<td rowspan="${totalRows}">${s.org}</td>` : '';
      if (s.isPlaceholder) {
        const bm = ER_BM[s.platform.toLowerCase()] ?? '—';
        return `<tr style="opacity:0.45">${orgCell}<td>${s.platform} <span style="font-size:10px;color:var(--text-muted)">(handle not confirmed)</span></td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td style="font-size:12px;color:var(--text-muted)">${bm}</td><td>—</td></tr>`;
      }
      const bm = ER_BM[s.platform.toLowerCase()] ?? '—';
      const vs = bm !== '—' ? (s.er_pct >= parseFloat(bm) ? `<span class="good">▲</span>` : `<span class="warn">▼</span>`) : '—';
      const isYT = s.platform.toLowerCase().includes('youtube');
      const quoteRt = s.quote_rt ?? 0;
      return `<tr>${orgCell}
        <td>${s.platform}</td>
        <td class="highlight">${(s.impressions ?? 0).toLocaleString()}</td>
        <td style="color:var(--text-muted)">${isYT ? (s.impressions ?? 0).toLocaleString() : '—'}</td>
        <td>${(s.likes ?? 0).toLocaleString()}</td>
        <td>${(s.shares ?? 0) > 0 ? (s.shares ?? 0).toLocaleString() : '—'}</td>
        <td>${(s.comments ?? 0).toLocaleString()}</td>
        <td>${(s.saves ?? 0) > 0 ? (s.saves ?? 0).toLocaleString() : '—'}</td>
        <td>${quoteRt > 0 ? quoteRt.toLocaleString() : '—'}</td>
        <td class="highlight">${s.er_pct ?? 0}%</td>
        <td style="color:var(--text-muted);font-size:12px">${bm}</td>
        <td>${vs}</td>
      </tr>`;
    });
  }).join('');

  // Placeholder rows are now embedded in socialRowsByOrg grouping above

  // ── Media rows — outlet-by-outlet matrix ────────────────────────────────────
  // Build the full outlet list from all orgs' outlet_breakdown
  const allOutlets: string[] = [];
  for (const m of stats.media) {
    for (const ob of m.outlet_breakdown ?? []) {
      if (!allOutlets.includes(ob.outlet)) allOutlets.push(ob.outlet);
    }
  }
  // Fall back to meta.outlets if breakdown is missing
  const matrixOutlets = allOutlets.length > 0 ? allOutlets : (meta.outlets ?? []);

  const mediaMatrixRows = stats.media.map((m: any) => {
    const byOutlet: Record<string,any> = {};
    for (const ob of m.outlet_breakdown ?? []) byOutlet[ob.outlet] = ob;
    const outletCells = matrixOutlets.map((outlet) => {
      const ob = byOutlet[outlet];
      if (!ob || ob.mentions === 0) {
        return `<td style="color:var(--text-muted)">—</td><td style="color:var(--text-muted)">—</td><td style="color:var(--text-muted)">—</td><td style="color:var(--text-muted)">—</td>`;
      }
      const toneBadge = ob.tone === "A"
        ? `<span class="badge tone-auth">A</span>`
        : `<span class="badge tone-neutral">N</span>`;
      return `<td class="highlight">${ob.mentions}</td><td>${ob.dofollow}</td><td>${ob.direct_cites}</td><td>${toneBadge}</td>`;
    }).join("");
    const totalsCell = `<td style="font-size:12px;color:var(--text-muted);white-space:nowrap">${m.total_mentions} | Do:${m.dofollow_links} | No:${m.nofollow_links} | DC:${m.direct_cites}</td>`;
    return `<tr><td><strong>${m.org}</strong></td>${outletCells}${totalsCell}</tr>`;
  }).join("");

  // Build matrix header
  const outletGroupHeaders = matrixOutlets.map((o) => `<th colspan="4" class="th-group">${o}</th>`).join("");
  const outletSubHeaders   = matrixOutlets.map(() => `<th>Mentions</th><th>Dofollow</th><th>Direct Cites</th><th>Tone</th>`).join("");

  // Summary rows (existing aggregated view — kept below matrix for quick scan)
  const mediaRows = stats.media.map((m) => `
      <tr>
        <td>${m.org}</td>
        <td>${m.total_mentions}</td>
        <td>${m.dofollow_links}</td>
        <td>${m.nofollow_links}</td>
        <td>${m.direct_cites}</td>
        <td class="${m.aligned_tone_pct >= 60 ? "good" : "warn"}">${m.aligned_tone_pct}%</td>
        <td>${m.top_outlets.map((o: any) => `${o.outlet} (${o.mentions})`).join(", ")}</td>
      </tr>`).join("");


  // ── AEO rows — rowspan org name, X/20 format + letter grade ─────────────────
  // AEO-appropriate grading: scores of 0-100 where 0 is extremely common
  // (most orgs score <25) — use a generous scale so results look actionable
  const aeoLetterGrade = (score: number): { grade: string; cls: string; label: string } => {
    if (score >= 65) return { grade: "S", cls: "tier-high",     label: "Sector Leader" };
    if (score >= 45) return { grade: "A", cls: "tier-high",     label: "Strong Visibility" };
    if (score >= 28) return { grade: "B", cls: "tier-moderate", label: "Good Visibility" };
    if (score >= 12) return { grade: "C", cls: "tier-moderate", label: "Developing" };
    if (score >= 3)  return { grade: "D", cls: "tier-low",      label: "Limited Visibility" };
    return               { grade: "E", cls: "tier-low",      label: "Not Yet Visible" };
  };

  const aeoByOrg: Record<string, typeof stats.aeo> = {};
  for (const a of stats.aeo) (aeoByOrg[a.org] = aeoByOrg[a.org] || []).push(a);
  const aeoRows = meta.orgs.flatMap((org) => {
    const rows = aeoByOrg[org] ?? [];
    return rows.map((a, i) => {
      const orgCell = i === 0 ? `<td rowspan="${rows.length}">${a.org}</td>` : '';
      const mentionDisplay = `${a.mention_count}/20 (${a.mention_rate_pct}%)`;
      const tierClass = a.visibility_tier === "High" ? "tier-high" : a.visibility_tier === "Moderate" ? "tier-moderate" : "tier-low";
      const grade = aeoLetterGrade(a.visibility_score);
      return `<tr>${orgCell}
        <td>${a.llm}</td>
        <td class="highlight">${mentionDisplay}</td>
        <td>${a.avg_position > 0 ? a.avg_position : "—"}</td>
        <td>${a.citation_type}</td>
        <td>${a.direct_links}</td>
        <td><span class="badge ${grade.cls}" title="${grade.label} (raw score: ${a.visibility_score}/100)">${grade.grade}</span></td>
        <td><span class="badge ${tierClass}">${a.visibility_tier}</span></td>
      </tr>`;
    });
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
      // For Perplexity: check if there's a direct link indicator
      const isPerplexity = llm.toLowerCase().includes("perplexity");
      const linkBadge = isPerplexity && r.mentioned
        ? ` <span style="font-size:9px;color:var(--emerald);border:1px solid rgba(0,179,126,0.4);border-radius:3px;padding:0 3px">link</span>`
        : "";
      return `<td class="good">✓${pos}${linkBadge}</td>`;
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

  // ── Action Matrix — rowspan org name ────────────────────────────────────────
  const ACTION_META: Record<string, { css: string; emoji: string; label: string }> = {
    "Fix Now":  { css: "fix-now",  emoji: "🟠", label: "Fix Now — act this week" },
    "Leverage": { css: "leverage", emoji: "🟢", label: "Leverage — double down" },
    "Optimise": { css: "optimise", emoji: "🔵", label: "Optimise — 4–8 weeks" },
    "Invest":   { css: "invest",   emoji: "🔴", label: "Invest — platform gap" },
  };

  const actionByOrg: Record<string, typeof stats.action_matrix> = {};
  for (const a of stats.action_matrix) (actionByOrg[a.org] = actionByOrg[a.org] || []).push(a);
  const actionRows = meta.orgs.flatMap((org) => {
    const rows = actionByOrg[org] ?? [];
    return rows.map((a, i) => {
      const orgCell = i === 0 ? `<td rowspan="${rows.length}">${a.org}</td>` : '';
      const meta = ACTION_META[a.priority];
      return `<tr>${orgCell}
        <td><span class="badge action-${meta.css}">${meta.emoji} ${meta.label}</span></td>
        <td>${a.area}</td>
        <td>${a.action}</td>
        <td>${a.rationale}</td>
      </tr>`;
    });
  }).join("");

  // ── Stub badges ─────────────────────────────────────────────────────────────
  const stubBadges = [];
  if (meta.api_costs?.some((c) => c.service === "ChatGPT" && c.requests === 0)) {
    stubBadges.push(`<span class="source-badge source-stub">● ChatGPT data stub</span>`);
  }
  // ...add more stub badges as needed
  const stubBadgesHtml = stubBadges.length ? `<div style="margin-bottom:10px">${stubBadges.join(" ")}</div>` : "";

  // ── Comment Sentiment section ─────────────────────────────────────────────
  const commentSentimentSection = isEnabled("comment_sentiment") && sentimentData.length > 0 ? `
<div id="comment-sentiment" class="section">
  <h2 class="section-title">${getTitle("comment_sentiment","Comment Sentiment")}
    <span class="source-badge source-real" style="background:rgba(0,179,126,0.1);color:var(--good);border-color:rgba(0,179,126,0.25)">● GPT-4o-mini</span>
  </h2>
  <p class="section-desc">${getDesc("comment_sentiment","YouTube comment sentiment analysis via GPT-4o-mini. Classified as Positive, Neutral, or Negative toward each organisation.")}</p>
  ${sentimentCards}
</div>` : "";

  // ── Client badge ────────────────────────────────────────────────────────────
  const clientBadge = clientName ? `<span class="client-badge">${clientName}</span>` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Syne:wght@400;700;800&display=swap');
:root {
  --bg: #0d1117; --surface: #161b22; --surface2: #1c2128;
  --border: #30363d; --text: #e6edf3; --text-muted: #8b949e;
  --emerald: #00b37e; --emerald-dim: #00b37e33;
  --good: #3fb950; --warn: #d29922; --bad: #f85149;
  --accent: #58a6ff; --accent2: #a371f7;
}
* { box-sizing: border-box; }
body { font-family: 'Inter', sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 0; line-height: 1.6; }
.container { max-width: 1200px; margin: 0 auto; padding: 40px 20px; }
.header { text-align: center; padding: 40px 0 20px; border-bottom: 1px solid var(--border); margin-bottom: 30px; }
h1 { font-family: 'Syne', sans-serif; font-size: 32px; font-weight: 800; margin: 0 0 8px; color: var(--text); }
.subtitle { color: var(--text-muted); font-size: 14px; margin-bottom: 16px; }
.client-badge { display: inline-block; background: var(--emerald-dim); color: var(--emerald); border: 1px solid var(--emerald); border-radius: 6px; padding: 4px 12px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; }
.section { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 28px; margin-bottom: 24px; }
.section-title { font-family: 'Syne', sans-serif; font-size: 20px; font-weight: 700; margin: 0 0 8px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.section-desc { color: var(--text-muted); font-size: 13px; margin: 0 0 20px; }
.metric-note { background: var(--surface2); border-left: 3px solid var(--accent); padding: 12px 16px; border-radius: 6px; font-size: 13px; color: var(--text-muted); margin-bottom: 20px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 16px; }
th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid var(--border); }
th { font-weight: 600; color: var(--text-muted); text-transform: uppercase; font-size: 11px; letter-spacing: 0.06em; background: var(--surface2); }
.th-group { border-bottom: 2px solid var(--border); text-align: center; }
td { vertical-align: top; }
.highlight { color: var(--emerald); font-weight: 600; }
.good { color: var(--good); }
.warn { color: var(--warn); }
.bad { color: var(--bad); }
.badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
.tone-auth { background: rgba(0,179,126,0.12); color: var(--emerald); border: 1px solid rgba(0,179,126,0.3); }
.tone-neutral { background: rgba(139,148,158,0.12); color: var(--text-muted); border: 1px solid rgba(139,148,158,0.3); }
.tier-high { background: rgba(0,179,126,0.12); color: var(--emerald); border: 1px solid rgba(0,179,126,0.3); }
.tier-moderate { background: rgba(210,153,34,0.12); color: var(--warn); border: 1px solid rgba(210,153,34,0.3); }
.tier-low { background: rgba(248,81,73,0.12); color: var(--bad); border: 1px solid rgba(248,81,73,0.3); }
.action-fix-now { background: rgba(210,153,34,0.12); color: var(--warn); border: 1px solid rgba(210,153,34,0.3); }
.action-leverage { background: rgba(0,179,126,0.12); color: var(--emerald); border: 1px solid rgba(0,179,126,0.3); }
.action-optimise { background: rgba(88,166,255,0.12); color: var(--accent); border: 1px solid rgba(88,166,255,0.3); }
.action-invest { background: rgba(248,81,73,0.12); color: var(--bad); border: 1px solid rgba(248,81,73,0.3); }
.source-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; margin-left: auto; }
.source-real { background: rgba(0,179,126,0.1); color: var(--emerald); border: 1px solid rgba(0,179,126,0.25); }
.source-stub { background: rgba(139,148,158,0.1); color: var(--text-muted); border: 1px solid rgba(139,148,158,0.25); }
.source-fallback { background: rgba(210,153,34,0.1); color: var(--warn); border: 1px solid rgba(210,153,34,0.25); }
.scorecards-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
.scorecard-card { background: var(--surface2); border: 1px solid var(--border); border-radius: 10px; padding: 20px; text-align: center; }
.sc-org { font-family: 'Syne', sans-serif; font-size: 15px; font-weight: 700; margin-bottom: 8px; }
.sc-grade { font-family: 'Syne', sans-serif; font-size: 48px; font-weight: 800; margin-bottom: 4px; }
.sc-overall { font-size: 14px; color: var(--text-muted); margin-bottom: 12px; }
.sc-breakdown { display: flex; justify-content: center; gap: 16px; font-size: 12px; color: var(--text-muted); }
.grade-a .sc-grade { color: var(--good); }
.grade-b .sc-grade { color: var(--accent); }
.grade-c .sc-grade { color: var(--warn); }
.grade-d .sc-grade { color: #f0883e; }
.grade-f .sc-grade { color: var(--bad); }
.yt-channel-card { background: var(--surface2); border: 1px solid var(--border); border-radius: 10px; padding: 20px; margin-bottom: 16px; }
.yt-channel-header { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
.yt-icon { font-size: 24px; color: var(--bad); }
.yt-channel-title { font-family: 'Syne', sans-serif; font-size: 15px; font-weight: 700; }
.yt-channel-link { font-size: 11px; color: var(--text-muted); text-decoration: none; }
.yt-stats-row { display: flex; gap: 24px; margin-bottom: 14px; flex-wrap: wrap; }
.yt-stat { text-align: center; }
.yt-stat-label { font-size: 10px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 4px; }
.yt-stat-value { font-family: 'Syne', sans-serif; font-size: 20px; font-weight: 700; }
.yt-top-title { font-size: 12px; color: var(--text-muted); font-weight: 600; margin-bottom: 8px; }
.footer { text-align: center; padding: 30px; color: var(--text-muted); font-size: 12px; border-top: 1px solid var(--border); margin-top: 20px; }
.subsection-title { font-family: 'Syne', sans-serif; font-size: 14px; font-weight: 700; margin: 20px 0 12px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.08em; }
@media print { body { background: #fff; color: #000; } .section { background: #fff; border-color: #ddd; } }
</style>
</head>
<body>
<div class="container">

<div class="header">
  <h1>${title}</h1>
  <div class="subtitle">${subtitle}</div>
  ${clientBadge}
  ${stubBadgesHtml}
</div>

<!-- ══ METHODOLOGY ════════════════════════════════════════════════════════════ -->
${isEnabled("methodology") ? `<div id="methodology" class="section">
  <h2 class="section-title">${getTitle("methodology","Methodology")}</h2>
  <p class="section-desc">${getDesc("methodology","How data was collected, filtered, and analysed.")}</p>
</div>` : ""}

<!-- ══ SOCIAL MEDIA ═══════════════════════════════════════════════════════════ -->
${isEnabled("social") ? `<div id="social" class="section">
  <h2 class="section-title">${getTitle("social","Social Media Engagement")}
    <span class="source-badge source-real">● YouTube OAuth2</span>
    <span class="source-badge source-real">● X API (Serper fallback)</span>
  </h2>
  <p class="section-desc">${getDesc("social","Reach and engagement across YouTube (Long-form + Shorts) and X. Benchmarks = Rival IQ 2025 Nonprofit medians.")}</p>
  <div class="metric-note">
    <strong>Engagement Rate</strong> = (likes + shares + comments + saves) / impressions × 100. YouTube Long-form benchmark = 1.72%, Shorts = 6.2%, X = 2.44% (Rival IQ 2025). ▲ = above benchmark, ▼ = below.
  </div>
  <table>
    <thead><tr>
      <th>Organisation</th><th>Platform</th>
      <th>Impressions</th><th>Reach</th><th>Likes</th><th>Shares</th><th>Comments</th><th>Saves</th><th>Quote RT</th>
      <th>ER %</th><th>Benchmark</th><th>vs BM</th>
    </tr></thead>
    <tbody>${socialRows}</tbody>
  </table>
  <div class="subsection-title">YouTube Channels</div>
  ${ytChannelCards}
  ${commentSentimentSection}
</div>` : ""}

<!-- ══ MEDIA COVERAGE ═══════════════════════════════════════════════════════════ -->
${isEnabled("media") ? `<div id="media" class="section">
  <h2 class="section-title">${getTitle("media","Media Coverage")}
    <span class="source-badge source-real">● Serper News API</span>
  </h2>
  <p class="section-desc">${getDesc("media","News mentions, dofollow links, direct citations, and journalist tone across tracked outlets. AQ content only.")}</p>
  <div class="metric-note">
    <strong>Tone</strong> — A = Authoritative (org cited as primary expert / quoted directly); N = Neutral (org mentioned among peers, not as lead). This is NOT positive vs negative sentiment.<br>
    <strong>Direct Cites</strong> = articles where the org is explicitly named as the source or researcher. <strong>Dofollow</strong> = links that pass SEO authority.
  </div>

  <div class="subsection-title">Outlet-by-Outlet Matrix</div>
  <table>
    <thead><tr><th>Org</th>${outletGroupHeaders}<th style="font-size:10px">Totals</th></tr></thead>
    <thead><tr><th></th>${outletSubHeaders}<th></th></tr></thead>
    <tbody>${mediaMatrixRows}</tbody>
  </table>

  <div class="subsection-title">Summary</div>
  <table>
    <thead><tr>
      <th>Organisation</th><th>Total Mentions</th><th>Dofollow</th><th>Nofollow</th><th>Direct Cites</th><th>Auth. Tone %</th><th>Top Outlets</th>
    </tr></thead>
    <tbody>${mediaRows}</tbody>
  </table>
</div>` : ""}

<!-- ══ TV CHANNEL COVERAGE ════════════════════════════════════════════════════ -->
${isEnabled("tv_coverage") ? (() => {
  const TV_ENG = ["NDTV", "News18", "India Today"];
  const TV_HIN = ["Aaj Tak", "India TV", "ABP News"];
  const ALL_TV  = [...TV_ENG, ...TV_HIN];
  // Filter media stats to only TV outlets
  const tvMedia = stats.media.map((m) => ({
    ...m,
    outlet_breakdown: (m.outlet_breakdown ?? []).filter((ob) => ALL_TV.includes(ob.outlet)),
  })).filter((m) => m.outlet_breakdown.length > 0 || stats.media.some(mm => mm.org === m.org));

  const tvOutlets = [...new Set(
    stats.media.flatMap((m) => (m.outlet_breakdown ?? []).map((ob) => ob.outlet))
  )].filter((o) => ALL_TV.includes(o));

  if (tvOutlets.length === 0) return `<div id="tv-coverage" class="section">
  <h2 class="section-title">${getTitle("tv_coverage","TV Channel Coverage")}</h2>
  <p class="section-desc">${getDesc("tv_coverage","Coverage across English and Hindi TV channels.")}</p>
  <p style="color:var(--text-muted);font-size:13px">No TV channel coverage found in this report period. Ensure TV channels (NDTV, News18, India Today, Aaj Tak, India TV, ABP News) are included in the outlet list.</p>
</div>`;

  const tvEngOutlets = tvOutlets.filter((o) => TV_ENG.includes(o));
  const tvHinOutlets = tvOutlets.filter((o) => TV_HIN.includes(o));

  const buildTvTable = (outlets: string[], label: string) => {
    if (outlets.length === 0) return "";
    const grpHdrs = outlets.map((o) => `<th colspan="3" class="th-group">${o}</th>`).join("");
    const subHdrs = outlets.map(() => `<th>Mentions</th><th>Direct Cites</th><th>Tone</th>`).join("");
    const rows = stats.media.map((m) => {
      const byOutlet: Record<string,any> = {};
      for (const ob of m.outlet_breakdown ?? []) byOutlet[ob.outlet] = ob;
      const cells = outlets.map((outlet) => {
        const ob = byOutlet[outlet];
        if (!ob || ob.mentions === 0) return `<td style="color:var(--text-muted)">—</td><td style="color:var(--text-muted)">—</td><td style="color:var(--text-muted)">—</td>`;
        const toneBadge = ob.tone === "A" ? `<span class="badge tone-auth">A</span>` : `<span class="badge tone-neutral">N</span>`;
        return `<td class="highlight">${ob.mentions}</td><td>${ob.direct_cites}</td><td>${toneBadge}</td>`;
      }).join("");
      const total = outlets.reduce((s, o) => s + ((byOutlet[o]?.mentions) ?? 0), 0);
      return `<tr><td><strong>${m.org}</strong></td>${cells}<td style="color:var(--text-muted);font-size:12px">${total}</td></tr>`;
    }).join("");
    return `<div class="subsection-title">${label}</div>
<table>
  <thead><tr><th>Organisation</th>${grpHdrs}<th style="font-size:10px">Total</th></tr></thead>
  <thead><tr><th></th>${subHdrs}<th></th></tr></thead>
  <tbody>${rows}</tbody>
</table>`;
  };

  return `<div id="tv-coverage" class="section">
  <h2 class="section-title">${getTitle("tv_coverage","TV Channel Coverage")}
    <span class="source-badge source-real">● Serper News API</span>
  </h2>
  <p class="section-desc">${getDesc("tv_coverage","Coverage across English and Hindi TV channels.")}</p>
  <div class="metric-note">
    <strong>Tone</strong> — A = Authoritative (org cited as primary expert/quoted directly); N = Neutral (org mentioned among peers). <strong>Direct Cites</strong> = articles naming this org as the source.
  </div>
  ${buildTvTable(tvEngOutlets, "English TV Channels")}
  ${buildTvTable(tvHinOutlets, "Hindi TV Channels")}
</div>`;
})() : ""}

<!-- ══ COVERAGE MOMENTUM ══════════════════════════════════════════════════════ -->
${isEnabled("coverage_momentum") ? (() => {
  // Split the report date range in half and compare article distribution
  const fromTs = meta.date_range?.from ? new Date(meta.date_range.from).getTime() : 0;
  const toTs   = meta.date_range?.to   ? new Date(meta.date_range.to).getTime()   : Date.now();
  const midTs  = (fromTs + toTs) / 2;
  const midDate = new Date(midTs).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const halfLabel1 = `${new Date(fromTs).toLocaleDateString("en-GB",{day:"numeric",month:"short"})} – ${midDate}`;
  const halfLabel2 = `${midDate} – ${new Date(toTs).toLocaleDateString("en-GB",{day:"numeric",month:"short"})}`;

  const citeEv = meta.citation_evidence ?? [];
  const toneEv = (meta.tone_evidence ?? []) as { org:string; article_date:string }[];
  // Combine both evidence arrays for coverage density
  const allEv: { org: string; date: string }[] = [
    ...citeEv.map((e) => ({ org: e.org, date: e.article_date })),
    ...toneEv.map((e) => ({ org: e.org, date: e.article_date })),
  ];

  // Deduplicate by org+date to avoid double-counting
  const seen = new Set<string>();
  const deduped = allEv.filter((e) => {
    const k = `${e.org}::${e.date}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const momentumByOrg: Record<string, { first: number; second: number }> = {};
  for (const org of meta.orgs) momentumByOrg[org] = { first: 0, second: 0 };
  for (const e of deduped) {
    if (!momentumByOrg[e.org]) momentumByOrg[e.org] = { first: 0, second: 0 };
    const ts = new Date(e.date).getTime();
    if (!isNaN(ts)) {
      if (ts < midTs) momentumByOrg[e.org].first++;
      else            momentumByOrg[e.org].second++;
    }
  }

  const momentumRows = meta.orgs.map((org) => {
    const { first, second } = momentumByOrg[org] ?? { first: 0, second: 0 };
    const total = first + second;
    if (total === 0) return `<tr><td>${org}</td><td style="color:var(--text-muted)">—</td><td style="color:var(--text-muted)">—</td><td style="color:var(--text-muted)">—</td><td><span class="badge tier-low">No data</span></td></tr>`;
    const pctFirst  = Math.round((first  / total) * 100);
    const pctSecond = Math.round((second / total) * 100);
    const change  = second - first;
    const changePct = first > 0 ? Math.round(((second - first) / first) * 100) : 100;
    let trendLabel: string; let trendClass: string; let trendIcon: string;
    if (change > 1 && changePct >= 20) {
      trendLabel = "Accelerating"; trendClass = "tier-high";  trendIcon = "▲";
    } else if (change < -1 && changePct <= -20) {
      trendLabel = "Decelerating"; trendClass = "tier-low";   trendIcon = "▼";
    } else {
      trendLabel = "Steady";      trendClass = "tier-moderate"; trendIcon = "→";
    }
    // Simple bar visualisation
    const barW1 = Math.round((first  / Math.max(first, second, 1)) * 80);
    const barW2 = Math.round((second / Math.max(first, second, 1)) * 80);
    const barHtml = `<div style="display:flex;gap:4px;align-items:center;margin-top:4px">
      <div style="display:flex;flex-direction:column;gap:2px;flex:1">
        <div style="display:flex;align-items:center;gap:6px">
          <div style="width:${barW1}px;height:8px;background:rgba(139,148,158,0.4);border-radius:2px"></div>
          <span style="font-size:10px;color:var(--text-muted)">${first} (${pctFirst}%)</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          <div style="width:${barW2}px;height:8px;background:var(--emerald);border-radius:2px;opacity:0.8"></div>
          <span style="font-size:10px;color:var(--emerald)">${second} (${pctSecond}%)</span>
        </div>
      </div>
    </div>`;
    return `<tr>
      <td><strong>${org}</strong></td>
      <td>${barHtml}</td>
      <td style="color:var(--text-muted);font-size:12px">${total}</td>
      <td class="${change > 0 ? "good" : change < 0 ? "warn" : ""}">${change > 0 ? "+" : ""}${change}</td>
      <td><span class="badge ${trendClass}">${trendIcon} ${trendLabel}</span></td>
    </tr>`;
  }).join("");

  return `<div id="coverage-momentum" class="section">
  <h2 class="section-title">${getTitle("coverage_momentum","Coverage Momentum")}
    <span class="source-badge source-real">● Serper News API</span>
  </h2>
  <p class="section-desc">${getDesc("coverage_momentum","Whether coverage is accelerating or decelerating across the report period.")}</p>
  <div class="metric-note">
    Compares article volume in the <strong>first half</strong> (${halfLabel1}) vs <strong>second half</strong> (${halfLabel2}) of the report window.
    Grey bar = first half · Green bar = second half. Derived from article evidence collected during media fetch — may undercount if coverage is thin.
  </div>
  <table>
    <thead><tr>
      <th>Organisation</th><th>Distribution (H1 → H2)</th><th>Total Articles</th><th>Change</th><th>Momentum</th>
    </tr></thead>
    <tbody>${momentumRows}</tbody>
  </table>
</div>`;
})() : ""}

<!-- ══ CITATION QUALITY ════════════════════════════════════════════════════════ -->
${isEnabled("citation_quality") ? (() => {
  const citEvidence = meta.citation_evidence ?? [];
  const citByOrg: Record<string, typeof citEvidence> = {};
  for (const e of citEvidence) {
    (citByOrg[e.org] = citByOrg[e.org] ?? []).push(e);
  }

  const cqRows = stats.media.map((m) => {
    const dataCited   = m.direct_cites;
    const namedMention = Math.max(0, m.total_mentions - m.direct_cites);
    const notMentioned = 0; // In current impl all found articles count as mentions
    const total = m.total_mentions;
    const dataPct = total > 0 ? Math.round((dataCited / total) * 100) : 0;

    const evidenceItems = (citByOrg[m.org] ?? []).slice(0, 5);
    const evidenceCell = evidenceItems.length > 0
      ? evidenceItems.map((e) =>
          `<div style="margin-bottom:6px">
            <a href="${e.article_link}" target="_blank" style="color:var(--emerald);text-decoration:none;font-size:12px">${e.article_title}</a>
            <span style="color:var(--text-muted);font-size:11px"> · ${e.outlet} · ${e.article_date}</span>
            ${e.snippet ? `<div style="font-size:11px;color:var(--text-muted);margin-top:2px;line-height:1.4;font-style:italic">"${e.snippet}…"</div>` : ""}
          </div>`
        ).join("")
      : `<span style="color:var(--text-muted);font-size:12px">—</span>`;

    return `<tr>
      <td>${m.org}</td>
      <td>${total}</td>
      <td class="${dataCited > 0 ? "highlight" : ""}">${dataCited} <span style="color:var(--text-muted);font-size:11px">(${dataPct}%)</span></td>
      <td>${namedMention}</td>
      <td style="color:var(--text-muted)">${notMentioned}</td>
      <td>${evidenceCell}</td>
    </tr>`;
  }).join("");

  return `<div id="citation-quality" class="section">
  <h2 class="section-title">${getTitle("citation_quality","Citation Quality")}
    <span class="source-badge source-real">● Serper News API</span>
  </h2>
  <p class="section-desc">${getDesc("citation_quality","How each org is cited: specific data/statistics cited vs. named in passing. Evidence links for every data citation.")}</p>
  <div class="metric-note">
    <strong>Data Cited</strong> = a specific number, statistic, report, or direct quote from this org appears in the article. <strong>Named Mention</strong> = org is named in the article but no specific data or quote from them is cited. These categories are mutually exclusive — each article falls into exactly one.
  </div>
  <table>
    <thead><tr>
      <th>Organisation</th><th>Total Mentions</th><th>Data Cited</th><th>Named Mention</th><th>Not Mentioned</th><th>Evidence (Data Cited Articles)</th>
    </tr></thead>
    <tbody>${cqRows}</tbody>
  </table>
</div>`;
})() : ""}

<!-- ══ EMERGING NARRATIVES ════════════════════════════════════════════════════ -->
${isEnabled("emerging_narratives") ? (() => {
  const narratives = meta.emerging_narratives ?? [];
  if (narratives.length === 0) return "";

  // Group by org
  const byOrg: Record<string, typeof narratives> = {};
  for (const n of narratives) (byOrg[n.org] = byOrg[n.org] ?? []).push(n);

  const orgBlocks = meta.orgs.flatMap((org) => {
    const items = byOrg[org] ?? [];
    if (items.length === 0) return [];
    const cards = items.map((n) => {
      const articleLinks = (n.articles ?? []).map((a) =>
        `<div style="margin-bottom:5px">
          <a href="${a.link}" target="_blank"
             style="color:var(--emerald);text-decoration:none;font-size:12px;line-height:1.5">${a.title}</a>
          ${a.outlet || a.date ? `<span style="color:var(--text-muted);font-size:11px"> · ${[a.outlet,a.date].filter(Boolean).join(" · ")}</span>` : ""}
        </div>`
      ).join("");
      const count = n.articles?.length ?? 0;
      return `<div style="background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:18px 20px;margin-bottom:12px">
        <div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:10px;flex-wrap:wrap">
          <div style="font-family:'Syne',sans-serif;font-size:14px;font-weight:700;flex:1">${n.topic}</div>
          <span style="background:rgba(88,166,255,0.12);color:var(--accent);border:1px solid rgba(88,166,255,0.3);border-radius:4px;padding:2px 8px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;white-space:nowrap">INFERENCE</span>
          ${count > 0 ? `<span style="background:rgba(0,179,126,0.15);color:var(--emerald);border:1px solid rgba(0,179,126,0.3);border-radius:12px;padding:2px 10px;font-size:11px;font-weight:700">${count} article${count !== 1 ? "s" : ""}</span>` : ""}
        </div>
        <div style="font-size:12px;color:var(--text-muted);line-height:1.55;margin-bottom:12px;font-style:italic">${n.inference}</div>
        ${count > 0 ? `<div style="border-top:1px solid var(--border);padding-top:10px;margin-top:2px">${articleLinks}</div>` : ""}
      </div>`;
    }).join("");
    return [`<div style="margin-bottom:20px">
      <div class="subsection-title">${org}</div>
      ${cards}
    </div>`];
  }).join("");

  if (!orgBlocks) return "";
  return `<div id="emerging-narratives" class="section">
  <h2 class="section-title">${getTitle("emerging_narratives","Emerging Narratives")}
    <span class="source-badge source-real" style="background:rgba(88,166,255,0.1);color:var(--accent);border-color:rgba(88,166,255,0.25)">● AI Inference</span>
  </h2>
  <p class="section-desc">${getDesc("emerging_narratives","AI-inferred topic clusters appearing repeatedly across coverage — topics gaining momentum distinct from each org's established focus.")}</p>
  <div class="metric-note">
    <strong>What is INFERENCE?</strong> These topics were not supplied as inputs — they were identified by the AI by pattern-matching across article titles and snippets collected during the media fetch.
    A topic is flagged as "emerging" when it appears across multiple outlets or articles in a concentrated time window, suggesting growing journalistic interest.<br><br>
    <strong>What do the article links mean?</strong> Each link is a real article fetched from a tracked outlet whose title or content matches the inferred topic. They are the evidence base — click to read the original coverage.
    Because this is AI inference over limited article data, treat these as signals to investigate, not definitive conclusions.
  </div>
  ${orgBlocks}
</div>`;
})() : ""}

<!-- ══ WIKIPEDIA CONTEXT ════════════════════════════════════════════════════════ -->
${isEnabled("wikipedia") && wikiSection ? wikiSection : ""}

<!-- ══ AEO / LLM VISIBILITY ═══════════════════════════════════════════════════ -->
${isEnabled("aeo") ? `<div id="aeo" class="section">
  <h2 class="section-title">${getTitle("aeo","AEO / LLM Visibility")}
    <span class="source-badge source-real">● ChatGPT gpt-4o-mini</span>
    <span class="source-badge source-real">● Perplexity sonar-small</span>
    <span class="source-badge source-real">● Gemini 1.5-flash</span>
  </h2>
  <p class="section-desc">${getDesc("aeo","How often each organisation appears in LLM responses to generic air-quality discovery queries. 5 queries per LLM, scored out of 20.")}</p>
  <div class="metric-note">
    <strong>Grade</strong> = composite of mention rate (40%), position (30%), and citation type (30%). S = Sector Leader · A = Strong · B = Good · C = Developing · D = Limited · E = Not yet visible. Hover grade for raw score. Queries are generic — they measure whether the org is mentioned <em>unprompted</em>, not when asked about it directly.
  </div>
  <table>
    <thead><tr>
      <th>Organisation</th><th>LLM</th><th>Mentions</th><th>Avg Position</th><th>Citation</th><th>Direct Links</th><th>Grade</th><th>Tier</th>
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
</div>` : ""}

<!-- ══ SCORECARDS ═════════════════════════════════════════════════════════════ -->
${isEnabled("scorecards") ? `<div id="scorecards" class="section">
  <h2 class="section-title">${getTitle("scorecards","Organisation Scorecards")}</h2>
  <p class="section-desc">${getDesc("scorecards","Weighted composite: Social 30% · Media 40% · AEO 30% &nbsp;|&nbsp; A ≥80 · B 65–79 · C 50–64 · D 35–49 · F &lt;35")}</p>
  <div class="scorecards-grid">${scorecardCards}</div>
</div>` : ""}

<!-- ══ ACTION MATRIX ══════════════════════════════════════════════════════════ -->
${isEnabled("action_matrix") ? `<div id="action-matrix" class="section">
  <h2 class="section-title">${getTitle("action_matrix","AI Insights — Action Matrix")}</h2>
  <p class="section-desc">${getDesc("action_matrix","Every insight references specific numbers from Tables 1–3. Rows = organisations (scalable). Columns = priority type.")}</p>
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
</div>` : ""}

<footer class="footer">
  Generated by <strong>Emerald AI</strong> · Air Quality Media Intelligence Platform · ${new Date(generatedAt).toUTCString()} · <strong>CONFIDENTIAL</strong>
</footer>

</div>
</body>
</html>`;
}
