// htmlGenerator.ts — generates a self-contained HTML report
import type { CalcResult } from "./calculator";

export interface ReportMeta {
  orgs: string[];
  date_range: { from: string; to: string };
  outlets: string[];
  llms: string[];
  client_name?: string;
}

export function generateHTMLReport(meta: ReportMeta, stats: CalcResult): string {
  const title = `Air Quality Media Intelligence Report`;
  const subtitle = `${meta.orgs.join(", ")} · ${meta.date_range.from} to ${meta.date_range.to}`;
  const generatedAt = new Date().toISOString();

  // Build sections
  const socialRows = stats.social
    .map(
      (s) => `
      <tr>
        <td>${s.org}</td><td>${s.platform}</td>
        <td>${s.impressions.toLocaleString()}</td>
        <td>${s.total_engagement.toLocaleString()}</td>
        <td class="highlight">${s.er_pct}%</td>
        <td>${s.likes.toLocaleString()}</td>
        <td>${s.shares.toLocaleString()}</td>
        <td>${s.comments.toLocaleString()}</td>
      </tr>`
    )
    .join("");

  const mediaRows = stats.media
    .map(
      (m) => `
      <tr>
        <td>${m.org}</td>
        <td>${m.total_mentions}</td>
        <td>${m.dofollow_links}</td>
        <td>${m.direct_cites}</td>
        <td class="${m.aligned_tone_pct >= 60 ? "good" : "warn"}">${m.aligned_tone_pct}%</td>
        <td>${m.top_outlets.map((o) => `${o.outlet} (${o.mentions})`).join(", ")}</td>
      </tr>`
    )
    .join("");

  const aeoRows = stats.aeo
    .map(
      (a) => `
      <tr>
        <td>${a.org}</td><td>${a.llm}</td>
        <td>${a.mention_rate_pct}%</td>
        <td>${a.avg_position}</td>
        <td>${a.citation_type}</td>
        <td>${a.direct_links}</td>
        <td class="highlight">${a.visibility_score}/100</td>
      </tr>`
    )
    .join("");

  const scorecardCards = stats.scorecards
    .map(
      (sc) => `
      <div class="scorecard-card grade-${sc.grade.toLowerCase()}">
        <div class="sc-org">${sc.org}</div>
        <div class="sc-grade">${sc.grade}</div>
        <div class="sc-overall">${sc.overall_score}/100</div>
        <div class="sc-breakdown">
          <span>Social: ${sc.social_score}</span>
          <span>Media: ${sc.media_score}</span>
          <span>AEO: ${sc.aeo_score}</span>
        </div>
      </div>`
    )
    .join("");

  const actionRows = stats.action_matrix
    .map(
      (a) => `
      <tr class="priority-${a.priority.toLowerCase()}">
        <td>${a.org}</td>
        <td><span class="badge priority-${a.priority.toLowerCase()}">${a.priority}</span></td>
        <td>${a.area}</td>
        <td>${a.action}</td>
        <td>${a.rationale}</td>
      </tr>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
  :root {
    --emerald: #00b37e;
    --emerald-dark: #007a55;
    --bg: #0d1117;
    --surface: #161b22;
    --surface2: #21262d;
    --border: #30363d;
    --text: #e6edf3;
    --text-muted: #8b949e;
    --good: #3fb950;
    --warn: #d29922;
    --bad: #f85149;
    --grade-a: #3fb950;
    --grade-b: #79c0ff;
    --grade-c: #d29922;
    --grade-d: #ffa657;
    --grade-f: #f85149;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: 'Segoe UI', system-ui, sans-serif; font-size: 14px; line-height: 1.6; }
  
  /* Cover */
  .cover { background: linear-gradient(135deg, #0d1117 0%, #0a2e1e 50%, #0d1117 100%); padding: 60px 40px; border-bottom: 1px solid var(--border); }
  .cover-logo { font-size: 13px; font-weight: 700; letter-spacing: 0.15em; color: var(--emerald); text-transform: uppercase; margin-bottom: 32px; }
  .cover-title { font-size: 36px; font-weight: 700; margin-bottom: 12px; background: linear-gradient(90deg, #fff, var(--emerald)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
  .cover-subtitle { font-size: 16px; color: var(--text-muted); margin-bottom: 24px; }
  .cover-meta { display: flex; gap: 24px; flex-wrap: wrap; }
  .cover-meta-item { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; }
  .cover-meta-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--text-muted); }
  .cover-meta-value { font-size: 14px; font-weight: 600; margin-top: 4px; }

  /* Nav */
  .nav { background: var(--surface); border-bottom: 1px solid var(--border); padding: 0 40px; position: sticky; top: 0; z-index: 100; display: flex; gap: 0; overflow-x: auto; }
  .nav a { display: block; padding: 14px 18px; color: var(--text-muted); text-decoration: none; font-size: 13px; font-weight: 500; white-space: nowrap; border-bottom: 2px solid transparent; transition: all 0.2s; }
  .nav a:hover { color: var(--emerald); border-bottom-color: var(--emerald); }

  /* Sections */
  .section { padding: 40px; border-bottom: 1px solid var(--border); }
  .section-title { font-size: 22px; font-weight: 700; margin-bottom: 6px; display: flex; align-items: center; gap: 10px; }
  .section-title::before { content: ''; display: inline-block; width: 4px; height: 24px; background: var(--emerald); border-radius: 2px; }
  .section-desc { color: var(--text-muted); margin-bottom: 24px; font-size: 13px; }

  /* Tables */
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { background: var(--surface2); padding: 10px 12px; text-align: left; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-muted); border-bottom: 1px solid var(--border); }
  td { padding: 10px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
  tr:hover td { background: var(--surface2); }
  .highlight { color: var(--emerald); font-weight: 600; }
  .good { color: var(--good); font-weight: 600; }
  .warn { color: var(--warn); font-weight: 600; }
  .bad { color: var(--bad); }

  /* Scorecards */
  .scorecards-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 16px; }
  .scorecard-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 24px; text-align: center; }
  .sc-org { font-size: 13px; font-weight: 600; color: var(--text-muted); margin-bottom: 12px; }
  .sc-grade { font-size: 56px; font-weight: 900; line-height: 1; margin-bottom: 4px; }
  .sc-overall { font-size: 20px; font-weight: 700; margin-bottom: 12px; }
  .sc-breakdown { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-muted); }
  .grade-a .sc-grade { color: var(--grade-a); }
  .grade-b .sc-grade { color: var(--grade-b); }
  .grade-c .sc-grade { color: var(--grade-c); }
  .grade-d .sc-grade { color: var(--grade-d); }
  .grade-f .sc-grade { color: var(--grade-f); }

  /* Badges */
  .badge { display: inline-block; padding: 2px 8px; border-radius: 20px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; }
  .badge.priority-high { background: rgba(248,81,73,0.15); color: var(--bad); }
  .badge.priority-medium { background: rgba(210,153,34,0.15); color: var(--warn); }
  .badge.priority-low { background: rgba(63,185,80,0.15); color: var(--good); }

  /* Sanity warnings */
  .sanity-box { background: rgba(210,153,34,0.1); border: 1px solid rgba(210,153,34,0.3); border-radius: 8px; padding: 16px; margin-bottom: 24px; }
  .sanity-box h4 { color: var(--warn); margin-bottom: 8px; font-size: 13px; }
  .sanity-box ul { padding-left: 16px; color: var(--text-muted); font-size: 12px; }

  /* Footer */
  .footer { padding: 24px 40px; text-align: center; color: var(--text-muted); font-size: 12px; }
  .footer strong { color: var(--emerald); }
</style>
</head>
<body>

<div class="cover">
  <div class="cover-logo">Emerald AI · Air Quality Intelligence</div>
  <h1 class="cover-title">${title}</h1>
  <p class="cover-subtitle">${subtitle}</p>
  <div class="cover-meta">
    ${meta.client_name ? `<div class="cover-meta-item"><div class="cover-meta-label">Client</div><div class="cover-meta-value">${meta.client_name}</div></div>` : ""}
    <div class="cover-meta-item"><div class="cover-meta-label">Organisations</div><div class="cover-meta-value">${meta.orgs.join(", ")}</div></div>
    <div class="cover-meta-item"><div class="cover-meta-label">Date Range</div><div class="cover-meta-value">${meta.date_range.from} → ${meta.date_range.to}</div></div>
    <div class="cover-meta-item"><div class="cover-meta-label">Outlets Tracked</div><div class="cover-meta-value">${meta.outlets.length}</div></div>
    <div class="cover-meta-item"><div class="cover-meta-label">LLMs Monitored</div><div class="cover-meta-value">${meta.llms.join(", ")}</div></div>
    <div class="cover-meta-item"><div class="cover-meta-label">Generated</div><div class="cover-meta-value">${new Date(generatedAt).toLocaleString()}</div></div>
  </div>
</div>

<nav class="nav">
  <a href="#social">Social</a>
  <a href="#media">Media</a>
  <a href="#aeo">AEO / LLM</a>
  <a href="#scorecards">Scorecards</a>
  <a href="#action-matrix">Action Matrix</a>
</nav>

${
  stats.sanity_errors && stats.sanity_errors.length > 0
    ? `<div class="section">
    <div class="sanity-box">
      <h4>⚠ Data Quality Warnings</h4>
      <ul>${stats.sanity_errors.map((e) => `<li>${e}</li>`).join("")}</ul>
    </div>
  </div>`
    : ""
}

<div id="social" class="section">
  <h2 class="section-title">Social Media Performance</h2>
  <p class="section-desc">Engagement rates and reach across platforms for tracked organisations.</p>
  <table>
    <thead><tr>
      <th>Organisation</th><th>Platform</th><th>Impressions</th><th>Engagement</th>
      <th>ER %</th><th>Likes</th><th>Shares</th><th>Comments</th>
    </tr></thead>
    <tbody>${socialRows}</tbody>
  </table>
</div>

<div id="media" class="section">
  <h2 class="section-title">Media Coverage</h2>
  <p class="section-desc">News mentions, dofollow links, direct citations, and sentiment across tracked outlets.</p>
  <table>
    <thead><tr>
      <th>Organisation</th><th>Total Mentions</th><th>Dofollow Links</th>
      <th>Direct Cites</th><th>Aligned Tone %</th><th>Top Outlets</th>
    </tr></thead>
    <tbody>${mediaRows}</tbody>
  </table>
</div>

<div id="aeo" class="section">
  <h2 class="section-title">AEO / LLM Visibility</h2>
  <p class="section-desc">How often organisations appear in AI-generated answers, and where.</p>
  <table>
    <thead><tr>
      <th>Organisation</th><th>LLM</th><th>Mention Rate</th><th>Avg Position</th>
      <th>Citation Type</th><th>Direct Links</th><th>Visibility Score</th>
    </tr></thead>
    <tbody>${aeoRows}</tbody>
  </table>
</div>

<div id="scorecards" class="section">
  <h2 class="section-title">Organisation Scorecards</h2>
  <p class="section-desc">Weighted composite scores: Social 30% · Media 40% · AEO 30%</p>
  <div class="scorecards-grid">${scorecardCards}</div>
</div>

<div id="action-matrix" class="section">
  <h2 class="section-title">Action Matrix</h2>
  <p class="section-desc">Prioritised recommendations based on score gaps and data signals.</p>
  <table>
    <thead><tr>
      <th>Organisation</th><th>Priority</th><th>Area</th><th>Action</th><th>Rationale</th>
    </tr></thead>
    <tbody>${actionRows}</tbody>
  </table>
</div>

<footer class="footer">
  Generated by <strong>Emerald AI</strong> · Air Quality Media Intelligence Platform · ${new Date(generatedAt).toUTCString()}
</footer>

</body>
</html>`;
}
