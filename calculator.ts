// calculator.ts — pure computation, no side effects

export interface RawInput {
  meta: {
    orgs: string[];
    date_range: { from: string; to: string };
    outlets: string[];
    llms: string[];
  };
  raw: {
    social: SocialRaw[];
    media: MediaRaw[];
    aeo: AeoRaw[];
    queries: QueryRaw[];
  };
}

export interface SocialRaw {
  org: string;
  platform: string;
  impressions: number;
  likes: number;
  shares: number;
  comments: number;
  saves: number;
  quote_rt: number;
}

export interface MediaRaw {
  org: string;
  outlet: string;
  mentions: number;
  dofollow: number;
  direct_cites: number;
  tone: "A" | "N"; // Aligned / Negative
}

export interface AeoRaw {
  org: string;
  llm: string;
  mention_count: number;
  avg_position: number;
  citation_type: "Direct" | "Passing" | "None";
  direct_links: number;
}

export interface QueryRaw {
  query: string;
  org: string;
  llm: string;
  mentioned: boolean;
  position?: number;
}

export interface CalcResult {
  success: boolean;
  error?: string;
  sanity_errors?: string[];
  social: SocialStats[];
  media: MediaStats[];
  aeo: AeoStats[];
  scorecards: OrgScorecard[];
  action_matrix: ActionItem[];
}

export interface SocialStats {
  org: string;
  platform: string;
  impressions: number;
  total_engagement: number;
  er_pct: number; // engagement rate %
  likes: number;
  shares: number;
  comments: number;
  saves: number;
}

export interface MediaStats {
  org: string;
  total_mentions: number;
  dofollow_links: number;
  direct_cites: number;
  aligned_tone_pct: number;
  top_outlets: { outlet: string; mentions: number }[];
}

export interface AeoStats {
  org: string;
  llm: string;
  mention_rate_pct: number;
  avg_position: number;
  citation_type: string;
  direct_links: number;
  visibility_score: number; // 0–100
}

export interface OrgScorecard {
  org: string;
  social_score: number;    // 0–100
  media_score: number;     // 0–100
  aeo_score: number;       // 0–100
  overall_score: number;   // weighted average
  grade: "A" | "B" | "C" | "D" | "F";
}

export interface ActionItem {
  org: string;
  priority: "High" | "Medium" | "Low";
  area: "Social" | "Media" | "AEO";
  action: string;
  rationale: string;
}

export function runCalculations(input: RawInput): CalcResult {
  const sanity_errors: string[] = [];

  // --- Social ---
  const social: SocialStats[] = input.raw.social.map((s) => {
    const total_engagement = s.likes + s.shares + s.comments + s.saves + s.quote_rt;
    const er_pct =
      s.impressions > 0
        ? parseFloat(((total_engagement / s.impressions) * 100).toFixed(2))
        : 0;

    if (s.impressions < 0) sanity_errors.push(`Negative impressions for ${s.org} on ${s.platform}`);
    if (er_pct > 50) sanity_errors.push(`Unrealistic ER (${er_pct}%) for ${s.org} on ${s.platform}`);

    return {
      org: s.org,
      platform: s.platform,
      impressions: s.impressions,
      total_engagement,
      er_pct,
      likes: s.likes,
      shares: s.shares,
      comments: s.comments,
      saves: s.saves,
    };
  });

  // --- Media ---
  const mediaByOrg: Record<string, MediaRaw[]> = {};
  for (const m of input.raw.media) {
    if (!mediaByOrg[m.org]) mediaByOrg[m.org] = [];
    mediaByOrg[m.org].push(m);
  }

  const media: MediaStats[] = Object.entries(mediaByOrg).map(([org, rows]) => {
    const total_mentions = rows.reduce((s, r) => s + r.mentions, 0);
    const dofollow_links = rows.reduce((s, r) => s + r.dofollow, 0);
    const direct_cites = rows.reduce((s, r) => s + r.direct_cites, 0);
    const aligned = rows.filter((r) => r.tone === "A").length;
    const aligned_tone_pct =
      rows.length > 0
        ? parseFloat(((aligned / rows.length) * 100).toFixed(1))
        : 0;

    const top_outlets = rows
      .sort((a, b) => b.mentions - a.mentions)
      .slice(0, 5)
      .map((r) => ({ outlet: r.outlet, mentions: r.mentions }));

    return { org, total_mentions, dofollow_links, direct_cites, aligned_tone_pct, top_outlets };
  });

  // --- AEO ---
  const aeo: AeoStats[] = input.raw.aeo.map((a) => {
    // Visibility score: weighted composite
    // mention_count (max ~20 → 40pts), position (lower=better → 30pts), citation type (30pts)
    const mentionScore = Math.min(40, (a.mention_count / 20) * 40);
    const positionScore = Math.max(0, 30 - (a.avg_position - 1) * 10);
    const citationScore =
      a.citation_type === "Direct" ? 30 : a.citation_type === "Passing" ? 15 : 0;
    const visibility_score = parseFloat(
      (mentionScore + positionScore + citationScore).toFixed(1)
    );
    const mention_rate_pct = parseFloat(((a.mention_count / 20) * 100).toFixed(1));

    return {
      org: a.org,
      llm: a.llm,
      mention_rate_pct,
      avg_position: a.avg_position,
      citation_type: a.citation_type,
      direct_links: a.direct_links,
      visibility_score,
    };
  });

  // --- Scorecards ---
  const scorecards: OrgScorecard[] = input.meta.orgs.map((org) => {
    const orgSocial = social.filter((s) => s.org === org);
    const orgMedia = media.find((m) => m.org === org);
    const orgAeo = aeo.filter((a) => a.org === org);

    // Social score: avg ER across platforms, normalised to 100 (benchmark ER = 3%)
    const avgER =
      orgSocial.length > 0
        ? orgSocial.reduce((s, r) => s + r.er_pct, 0) / orgSocial.length
        : 0;
    const social_score = Math.min(100, parseFloat(((avgER / 3) * 100).toFixed(1)));

    // Media score: mentions (50) + dofollow (30) + tone (20)
    const mentionNorm = orgMedia ? Math.min(50, (orgMedia.total_mentions / 100) * 50) : 0;
    const dofollowNorm = orgMedia ? Math.min(30, (orgMedia.dofollow_links / 50) * 30) : 0;
    const toneNorm = orgMedia ? (orgMedia.aligned_tone_pct / 100) * 20 : 0;
    const media_score = parseFloat((mentionNorm + dofollowNorm + toneNorm).toFixed(1));

    // AEO score: avg visibility across LLMs
    const aeo_score =
      orgAeo.length > 0
        ? parseFloat(
            (orgAeo.reduce((s, r) => s + r.visibility_score, 0) / orgAeo.length).toFixed(1)
          )
        : 0;

    // Weighted overall: social 30%, media 40%, aeo 30%
    const overall_score = parseFloat(
      (social_score * 0.3 + media_score * 0.4 + aeo_score * 0.3).toFixed(1)
    );

    const grade: OrgScorecard["grade"] =
      overall_score >= 80 ? "A"
      : overall_score >= 65 ? "B"
      : overall_score >= 50 ? "C"
      : overall_score >= 35 ? "D"
      : "F";

    return { org, social_score, media_score, aeo_score, overall_score, grade };
  });

  // --- Action Matrix ---
  const action_matrix: ActionItem[] = [];
  for (const sc of scorecards) {
    if (sc.social_score < 40) {
      action_matrix.push({
        org: sc.org,
        priority: "High",
        area: "Social",
        action: "Launch engagement campaign on underperforming platforms",
        rationale: `Social score ${sc.social_score}/100 — ER below benchmark`,
      });
    }
    if (sc.media_score < 40) {
      action_matrix.push({
        org: sc.org,
        priority: "High",
        area: "Media",
        action: "Proactive media outreach to key outlets",
        rationale: `Media score ${sc.media_score}/100 — low mentions/links`,
      });
    }
    if (sc.aeo_score < 40) {
      action_matrix.push({
        org: sc.org,
        priority: "Medium",
        area: "AEO",
        action: "Optimise web content for LLM citation eligibility",
        rationale: `AEO score ${sc.aeo_score}/100 — low LLM visibility`,
      });
    }
    if (sc.overall_score >= 65) {
      action_matrix.push({
        org: sc.org,
        priority: "Low",
        area: "Media",
        action: "Maintain momentum — sustain outreach cadence",
        rationale: `Strong overall score ${sc.overall_score}/100`,
      });
    }
  }

  return {
    success: true,
    sanity_errors: sanity_errors.length > 0 ? sanity_errors : undefined,
    social,
    media,
    aeo,
    scorecards,
    action_matrix,
  };
}
