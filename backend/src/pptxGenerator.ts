// pptxGenerator.ts — generates an editable PowerPoint from report data
// Matches baseline PPT structure: Cover → Methodology → Social → Media → AEO → Scorecards → Action Matrix
import PptxGenJS from "pptxgenjs";
import type { ReportMeta } from "./htmlGenerator";
import type { CalcResult } from "./calculator";

// ── Design tokens ─────────────────────────────────────────────────────────────
const C = {
  bg:      "0D1117",
  surface: "161B22",
  surface2:"21262D",
  emerald: "00B37E",
  text:    "E6EDF3",
  muted:   "8B949E",
  good:    "3FB950",
  warn:    "D29922",
  bad:     "F85149",
  blue:    "79C0FF",
  white:   "FFFFFF",
  border:  "30363D",
};

const FONT = "Calibri";

// ── Helpers ───────────────────────────────────────────────────────────────────
function darkSlide(prs: PptxGenJS): PptxGenJS.Slide {
  const slide = prs.addSlide();
  slide.background = { color: C.bg };
  return slide;
}

function addTitle(slide: PptxGenJS.Slide, text: string, y = 0.3) {
  slide.addText(text, {
    x: 0.4, y, w: 9.2, h: 0.55,
    fontSize: 22, bold: true, color: C.white, fontFace: FONT,
  });
  slide.addShape("rect", {
    x: 0.4, y: y + 0.57, w: 9.2, h: 0.03,
    fill: { color: C.emerald }, line: { color: C.emerald, pt: 0 },
  });
}

function addSubtitle(slide: PptxGenJS.Slide, text: string, y = 1.0) {
  slide.addText(text, {
    x: 0.4, y, w: 9.2, h: 0.3,
    fontSize: 10, color: C.muted, fontFace: FONT,
  });
}

// Build a TableRow (= TableCell[]) from cell specs
function row(cells: { t: string; color?: string; bold?: boolean; size?: number; italic?: boolean; fill?: string }[]): PptxGenJS.TableRow {
  return cells.map((c) => ({
    text: c.t,
    options: {
      color: c.color ?? C.text,
      bold: c.bold ?? false,
      italic: c.italic ?? false,
      fontSize: c.size ?? 9.5,
      fontFace: FONT,
      fill: c.fill ? { color: c.fill } : undefined,
      border: [
        { type: "solid", color: C.border, pt: 0.4 },
        { type: "solid", color: C.border, pt: 0.4 },
        { type: "solid", color: C.border, pt: 0.4 },
        { type: "solid", color: C.border, pt: 0.4 },
      ],
    },
  })) as PptxGenJS.TableRow;
}

function headerRow(labels: string[]): PptxGenJS.TableRow {
  return row(labels.map((t) => ({ t, color: C.muted, bold: true, size: 9, fill: C.surface2 })));
}

function addTable(
  slide: PptxGenJS.Slide,
  rows: PptxGenJS.TableRow[],
  y: number,
  colW: number[],
) {
  slide.addTable(rows, {
    x: 0.4, y, w: 9.2, colW, fontFace: FONT,
    border: { type: "solid", color: C.border, pt: 0.4 },
    fill: { color: C.surface },
  });
}

// ── Slide builders ────────────────────────────────────────────────────────────

function buildCover(prs: PptxGenJS, meta: ReportMeta) {
  const slide = darkSlide(prs);

  // Emerald top bar
  slide.addShape("rect", { x: 0, y: 0, w: 10, h: 0.1, fill: { color: C.emerald }, line: { color: C.emerald, pt: 0 } });

  // Logo label
  slide.addText("Emerald AI  ·  AIR QUALITY INTELLIGENCE  ·  BASELINE REPORT  ·  CONFIDENTIAL", {
    x: 0.4, y: 0.22, w: 9.2, h: 0.28,
    fontSize: 8.5, bold: true, color: C.emerald, fontFace: FONT, charSpacing: 1.5,
  });

  // Main title
  slide.addText("Air Quality\nMedia Intelligence Report", {
    x: 0.4, y: 0.6, w: 9.2, h: 1.6,
    fontSize: 38, bold: true, color: C.white, fontFace: FONT, lineSpacingMultiple: 1.1,
  });

  // Org & date
  slide.addText(`${meta.orgs.join("  ·  ")}  ·  AQ Content Only`, {
    x: 0.4, y: 2.3, w: 9.2, h: 0.35,
    fontSize: 14, color: C.muted, fontFace: FONT,
  });
  slide.addText(`Baseline period:  ${meta.date_range.from}  →  ${meta.date_range.to}`, {
    x: 0.4, y: 2.68, w: 9.2, h: 0.3,
    fontSize: 12, color: C.muted, fontFace: FONT,
  });

  // Meta cards
  const cards = [
    { label: "Organisations", value: meta.orgs.join(", ") },
    { label: "Prepared by",   value: "Emerald AI" },
    { label: "Prepared for",  value: meta.client_name ?? "—" },
    { label: "Outlets",       value: meta.outlets.join(", ") },
    { label: "LLMs",          value: meta.llms.join(", ") },
  ];
  const cardW = 1.76;
  cards.forEach((c, i) => {
    const x = 0.4 + i * (cardW + 0.12);
    const y = 3.1;
    slide.addShape("roundRect", {
      x, y, w: cardW, h: 0.82,
      fill: { color: "1C2128" }, line: { color: C.border, pt: 0.6 },
    });
    slide.addText(c.label.toUpperCase(), {
      x: x + 0.1, y: y + 0.07, w: cardW - 0.2, h: 0.22,
      fontSize: 7, color: C.muted, fontFace: FONT, charSpacing: 1,
    });
    slide.addText(c.value, {
      x: x + 0.1, y: y + 0.34, w: cardW - 0.2, h: 0.4,
      fontSize: 9.5, bold: true, color: C.white, fontFace: FONT,
    });
  });

  // Benchmark footnote
  slide.addText(
    "Benchmarks: Rival IQ 2025 · Hootsuite 2025 · Sprout Social 2025 · Metricool/Statista 2024  ·  All data covers the same period. Benchmarks use medians — resistant to viral outliers.",
    { x: 0.4, y: 4.62, w: 9.2, h: 0.28, fontSize: 7.5, color: C.muted, fontFace: FONT },
  );
}

function buildMethodology(prs: PptxGenJS) {
  const slide = darkSlide(prs);
  addTitle(slide, "How to read this report");
  addSubtitle(slide, "Methodology · Definitions · Benchmark Sources", 1.0);

  const tables: { label: string; title: string; bullets: string[] }[] = [
    {
      label: "Table 1",
      title: "Social Media Engagement",
      bullets: [
        "Platforms: YouTube (Long-form + Shorts), X, Instagram, LinkedIn — where confirmed handles exist.",
        "Reach metrics = impressions, views, likes. Engagement metrics = shares, reposts, comments, saves, quote tweets.",
        "Engagement Rate = engagement ÷ impressions × 100.",
        "Benchmarks: Rival IQ 2025 Nonprofit Report — medians across 150+ nonprofits.",
      ],
    },
    {
      label: "Table 2",
      title: "Media Coverage (Serper News API)",
      bullets: [
        "Outlets = columns; Organisations = rows. Per outlet: Mentions · Dofollow links · Direct citations · Tone.",
        "Tone: A = Authoritative (org is primary expert source, researcher quoted directly). N = Neutral (org cited among peers). NOT positive/negative.",
        "Dofollow links pass domain authority — boosting Google ranking and LLM citation probability.",
      ],
    },
    {
      label: "Table 3",
      title: "LLM / AEO Visibility",
      bullets: [
        "5 generic AQ discovery queries run live per LLM (ChatGPT, Perplexity, Gemini). Queries are non-org-specific — measures unprompted mentions.",
        "Mention rate expressed as X/20 (e.g. 15/20 = 75%). Position = rank of first mention. Direct links from Perplexity.",
        "AI Visibility Scale is Emerald AI v1.0 — no universal industry standard as of 2025.",
        "Methodology: Aggarwal et al. (2023) GEO: Generative Engine Optimisation — arxiv.org/abs/2311.09735",
      ],
    },
  ];

  tables.forEach((t, i) => {
    const y = 1.3 + i * 1.35;
    slide.addShape("roundRect", {
      x: 0.4, y, w: 9.2, h: 1.22,
      fill: { color: C.surface }, line: { color: C.border, pt: 0.6 },
    });
    slide.addText(t.label, {
      x: 0.5, y: y + 0.08, w: 0.8, h: 0.25,
      fontSize: 8, bold: true, color: C.emerald, fontFace: FONT,
    });
    slide.addText(t.title, {
      x: 1.3, y: y + 0.08, w: 8.0, h: 0.25,
      fontSize: 10.5, bold: true, color: C.white, fontFace: FONT,
    });
    t.bullets.forEach((b, j) => {
      slide.addText(`· ${b}`, {
        x: 0.55, y: y + 0.38 + j * 0.21, w: 8.9, h: 0.22,
        fontSize: 9, color: C.text, fontFace: FONT,
      });
    });
  });
}

function buildSocialTable(prs: PptxGenJS, meta: ReportMeta, stats: CalcResult) {
  const slide = darkSlide(prs);
  addTitle(slide, "Table 1 — Social Media Engagement");
  addSubtitle(slide, "Reach & engagement sub-columns  ·  AQ content only  ·  vs Rival IQ 2025 Nonprofit medians");

  const ER_BM: Record<string, string> = {
    "youtube long-form": "1.72%", youtube: "1.72%",
    "youtube shorts": "6.2%", x: "2.44%", instagram: "0.56%", linkedin: "6.5%",
  };

  const head = headerRow(["Org", "Platform", "Impressions", "Engagement", "ER %", "Benchmark", "vs Bench", "Likes", "Comments", "Saves"]);
  const dataRows = stats.social.map((s) => {
    const bm = ER_BM[s.platform.toLowerCase()] ?? "—";
    const bmVal = parseFloat(bm) || 0;
    const above = s.er_pct >= bmVal;
    return row([
      { t: s.org },
      { t: s.platform },
      { t: s.impressions.toLocaleString() },
      { t: s.total_engagement.toLocaleString() },
      { t: `${s.er_pct}%`, color: C.emerald, bold: true },
      { t: bm, color: C.muted, size: 9 },
      { t: bm !== "—" ? (above ? "▲" : "▼") : "—", color: above ? C.good : C.warn, bold: true },
      { t: s.likes.toLocaleString() },
      { t: s.comments.toLocaleString() },
      { t: s.saves > 0 ? s.saves.toLocaleString() : "—", color: C.muted },
    ]);
  });

  // Placeholder rows
  const knownPlatforms = new Set(stats.social.map((s) => s.platform.toLowerCase()));
  const placeholders: PptxGenJS.TableRow[] = [];
  for (const [p, bm] of [["Instagram", "0.56%"], ["LinkedIn", "6.5%"]] as const) {
    if (!knownPlatforms.has(p.toLowerCase())) {
      placeholders.push(row([
        { t: meta.orgs[0] ?? "—", color: C.muted },
        { t: `${p} (handle not confirmed)`, color: C.muted, italic: true },
        { t: "—", color: C.muted }, { t: "—", color: C.muted }, { t: "—", color: C.muted },
        { t: bm, color: C.muted, size: 9 },
        { t: "—", color: C.muted }, { t: "—", color: C.muted }, { t: "—", color: C.muted }, { t: "—", color: C.muted },
      ]));
    }
  }

  addTable(slide, [head, ...dataRows, ...placeholders], 1.3, [1.2, 1.3, 1.0, 1.0, 0.7, 0.85, 0.65, 0.8, 0.85, 0.7]);

  // Comment Sentiment
  const sentiment = meta.comment_sentiment ?? [];
  if (sentiment.length > 0) {
    const sY = 1.3 + 0.32 * (dataRows.length + placeholders.length + 1) + 0.25;
    slide.addText("Comment Sentiment Analysis  ·  YouTube  ·  GPT-4o-mini", {
      x: 0.4, y: sY, w: 9.2, h: 0.28, fontSize: 11, bold: true, color: C.emerald, fontFace: FONT,
    });
    const sHead = headerRow(["Organisation", "Positive", "Neutral", "Negative", "Relevant / Fetched", "Negative Topics", "Verdict"]);
    const sRows = sentiment.map((s) => {
      const tot = s.total_relevant || 1;
      const pp = Math.round((s.positive / tot) * 100);
      const np = Math.round((s.negative / tot) * 100);
      return row([
        { t: s.org },
        { t: `${s.positive} (${pp}%)`, color: C.good, bold: true },
        { t: `${s.neutral}`, color: C.muted },
        { t: `${s.negative} (${np}%)`, color: C.bad, bold: true },
        { t: `${s.total_relevant} / ${s.total_fetched}`, color: C.muted },
        { t: s.negative_topics?.join(", ") || "—", color: C.warn },
        { t: s.verdict, color: C.muted, italic: true, size: 8.5 },
      ]);
    });
    addTable(slide, [sHead, ...sRows], sY + 0.3, [1.3, 0.85, 0.75, 0.85, 1.1, 1.5, 2.75]);
  }
}

function buildMediaTable(prs: PptxGenJS, meta: ReportMeta, stats: CalcResult) {
  const slide = darkSlide(prs);
  addTitle(slide, "Table 2 — Media Coverage");
  addSubtitle(slide, "Outlets tracked via Serper News API  ·  Tone: A = Authoritative, N = Neutral  ·  AQ content only");

  const head = headerRow(["Organisation", "Total Mentions", "Dofollow Links", "Direct Cites", "Auth. Tone %", "Top Outlets"]);
  const dataRows = stats.media.map((m) =>
    row([
      { t: m.org },
      { t: String(m.total_mentions) },
      { t: String(m.dofollow_links), color: C.emerald, bold: true },
      { t: String(m.direct_cites) },
      { t: `${m.aligned_tone_pct}%`, color: m.aligned_tone_pct >= 60 ? C.good : C.warn, bold: true },
      { t: m.top_outlets.slice(0, 3).map((o) => `${o.outlet} (${o.mentions})`).join(", "), color: C.muted, size: 9 },
    ])
  );
  addTable(slide, [head, ...dataRows], 1.3, [1.7, 1.2, 1.2, 1.1, 1.1, 2.9]);

  // Journalist Tone Evidence
  const evidence = (meta.tone_evidence ?? []).slice(0, 8);
  if (evidence.length > 0) {
    const eY = 1.3 + 0.32 * (dataRows.length + 1) + 0.3;
    slide.addText("Journalist Tone Evidence  ·  Representative Articles", {
      x: 0.4, y: eY, w: 9.2, h: 0.28, fontSize: 11, bold: true, color: C.emerald, fontFace: FONT,
    });
    slide.addText("Every tone classification is traceable to a source article returned by Serper News API.", {
      x: 0.4, y: eY + 0.3, w: 9.2, h: 0.22, fontSize: 9, color: C.muted, fontFace: FONT,
    });
    const eHead = headerRow(["Organisation", "Outlet", "Tone", "Representative Article", "Date"]);
    const eRows = evidence.map((e) =>
      row([
        { t: e.org },
        { t: e.outlet },
        { t: e.tone === "A" ? "Authoritative" : "Neutral", color: e.tone === "A" ? C.emerald : C.muted, bold: true },
        { t: e.article_title, color: C.blue },
        { t: e.article_date, color: C.muted },
      ])
    );
    addTable(slide, [eHead, ...eRows], eY + 0.55, [1.3, 1.2, 1.3, 4.2, 1.2]);
  }
}

function buildAeoTable(prs: PptxGenJS, meta: ReportMeta, stats: CalcResult) {
  const slide = darkSlide(prs);
  addTitle(slide, "Table 3 — LLM / AEO Visibility");
  addSubtitle(slide, "ChatGPT · Perplexity AI · Google Gemini  ·  5 generic AQ queries per LLM  ·  Mention rate = X/20");

  // Visibility Scale
  slide.addText(
    "High: >65% (13+/20) AND avg pos ≤2.0     Moderate: 40–65% (8–13/20) OR pos 2.0–3.0     Low: <40% (<8/20) AND pos >3.0     Emerald AI Visibility Scale v1.0",
    { x: 0.4, y: 1.05, w: 9.2, h: 0.22, fontSize: 8.5, color: C.muted, fontFace: FONT },
  );

  const TIER_COLOR: Record<string, string> = { High: C.good, Moderate: C.warn, Low: C.bad };

  const head = headerRow(["Organisation", "LLM", "Mention Rate", "Avg Position", "Citation Type", "Direct Links", "Visibility Score", "Tier"]);
  const dataRows = stats.aeo.map((a) =>
    row([
      { t: a.org },
      { t: a.llm },
      { t: `${a.mention_count}/20 (${a.mention_rate_pct}%)`, color: C.emerald, bold: true },
      { t: a.avg_position > 0 ? String(a.avg_position) : "—" },
      { t: a.citation_type },
      { t: String(a.direct_links) },
      { t: `${a.visibility_score}/100` },
      { t: a.visibility_tier, color: TIER_COLOR[a.visibility_tier] ?? C.muted, bold: true },
    ])
  );
  addTable(slide, [head, ...dataRows], 1.32, [1.3, 1.1, 1.35, 0.95, 1.1, 0.85, 1.2, 0.85]);

  // Sample Query Performance
  const qr = meta.llm_query_results ?? [];
  const uniqueQueries = [...new Set(qr.map((q) => q.query))].slice(0, 5);
  const orgLlmCols = [...new Set(qr.map((q) => `${q.org}|${q.llm}`))];

  if (uniqueQueries.length > 0) {
    const qY = 1.32 + 0.32 * (dataRows.length + 1) + 0.3;
    slide.addText("Sample Query Performance  (showing exact queries sent to each LLM)", {
      x: 0.4, y: qY, w: 9.2, h: 0.28, fontSize: 11, bold: true, color: C.emerald, fontFace: FONT,
    });

    const qHead = headerRow([
      "Query (sent verbatim — generic, non-org-specific)",
      ...orgLlmCols.map((k) => { const [o, l] = k.split("|"); return `${o}\n${l}`; }),
    ]);
    const qRows = uniqueQueries.map((query) =>
      row([
        { t: query, size: 9 },
        ...orgLlmCols.map((key) => {
          const [org, llm] = key.split("|");
          const r = qr.find((x) => x.query === query && x.org === org && x.llm === llm);
          if (!r) return { t: "—", color: C.muted };
          if (!r.mentioned) return { t: "✗", color: C.bad, bold: true };
          const pos = r.position != null ? ` #${r.position}` : "";
          return { t: `✓${pos}`, color: C.good, bold: true };
        }),
      ])
    );

    const remW = 9.2 - 3.5;
    const colW = [3.5, ...orgLlmCols.map(() => remW / orgLlmCols.length)];
    addTable(slide, [qHead, ...qRows], qY + 0.3, colW);
  }
}

function buildScorecards(prs: PptxGenJS, stats: CalcResult) {
  const slide = darkSlide(prs);
  addTitle(slide, "Organisation Scorecards");
  addSubtitle(slide, "Weighted composite: Social 30%  ·  Media 40%  ·  AEO 30%    |    A ≥80  ·  B 65–79  ·  C 50–64  ·  D 35–49  ·  F <35");

  const GRADE_COLOR: Record<string, string> = { A: C.good, B: C.blue, C: C.warn, D: "FFA657", F: C.bad };
  const n = stats.scorecards.length;
  const perRow = Math.min(n, 4);
  const cardW = (9.2 - (perRow - 1) * 0.15) / perRow;

  stats.scorecards.forEach((sc, i) => {
    const col = i % perRow;
    const rowIdx = Math.floor(i / perRow);
    const x = 0.4 + col * (cardW + 0.15);
    const y = 1.3 + rowIdx * 2.3;
    const gc = GRADE_COLOR[sc.grade] ?? C.muted;

    slide.addShape("roundRect", {
      x, y, w: cardW, h: 2.1,
      fill: { color: C.surface }, line: { color: C.border, pt: 0.8 },
    });
    slide.addText(sc.grade, {
      x, y: y + 0.12, w: cardW, h: 1.0,
      fontSize: 58, bold: true, color: gc, fontFace: FONT, align: "center",
    });
    slide.addText(sc.org.toUpperCase(), {
      x, y: y + 1.1, w: cardW, h: 0.28,
      fontSize: 9, color: C.muted, fontFace: FONT, align: "center",
    });
    slide.addText(`${sc.overall_score}/100`, {
      x, y: y + 1.42, w: cardW, h: 0.32,
      fontSize: 15, bold: true, color: C.white, fontFace: FONT, align: "center",
    });
    slide.addText(`Social ${sc.social_score}  ·  Media ${sc.media_score}  ·  AEO ${sc.aeo_score}`, {
      x, y: y + 1.76, w: cardW, h: 0.28,
      fontSize: 8.5, color: C.muted, fontFace: FONT, align: "center",
    });
  });
}

function buildActionMatrix(prs: PptxGenJS, stats: CalcResult) {
  const slide = darkSlide(prs);
  addTitle(slide, "AI Insights — Action Matrix");
  addSubtitle(slide, "Rows = organisations (scalable)  ·  Every insight references specific numbers from Tables 1–3");

  slide.addText(
    "🟠 Fix Now — urgent risk, act this week     🟢 Leverage — highest-value asset, double down     🔵 Optimise — structural fix, 4–8 weeks     🔴 Invest — platform gap vs benchmark",
    { x: 0.4, y: 1.05, w: 9.2, h: 0.25, fontSize: 9, color: C.muted, fontFace: FONT },
  );

  const PRIORITY_COLOR: Record<string, string> = {
    "Fix Now": "FFA657", Leverage: C.good, Optimise: C.blue, Invest: C.bad,
  };
  const PRIORITY_EMOJI: Record<string, string> = {
    "Fix Now": "🟠 ", Leverage: "🟢 ", Optimise: "🔵 ", Invest: "🔴 ",
  };

  const head = headerRow(["Organisation", "Priority", "Area", "Action", "Rationale (data-anchored)"]);
  const dataRows = stats.action_matrix.map((a) =>
    row([
      { t: a.org },
      { t: (PRIORITY_EMOJI[a.priority] ?? "") + a.priority, color: PRIORITY_COLOR[a.priority] ?? C.muted, bold: true },
      { t: a.area },
      { t: a.action, size: 9 },
      { t: a.rationale, color: C.muted, size: 8.5 },
    ])
  );
  addTable(slide, [head, ...dataRows], 1.38, [1.3, 1.15, 0.8, 2.65, 3.1]);
}

// ── Main export ───────────────────────────────────────────────────────────────
export async function generatePPTX(meta: ReportMeta, stats: CalcResult): Promise<Buffer> {
  const prs = new PptxGenJS();
  prs.layout  = "LAYOUT_WIDE"; // 13.33" × 7.5"
  prs.author  = "Emerald AI";
  prs.company = "Emerald AI";
  prs.subject = "Air Quality Media Intelligence Report";
  prs.title   = `AQ Report — ${meta.orgs.join(", ")}`;

  buildCover(prs, meta);
  buildMethodology(prs);
  buildSocialTable(prs, meta, stats);
  buildMediaTable(prs, meta, stats);
  buildAeoTable(prs, meta, stats);
  buildScorecards(prs, stats);
  buildActionMatrix(prs, stats);

  return await prs.write({ outputType: "nodebuffer" }) as Buffer;
}
