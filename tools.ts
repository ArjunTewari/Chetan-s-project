// tools.ts — Serper uses real API; YouTube, X, SEMrush, LLM visibility are stubs.
// Replace stubs one by one as you obtain API keys.
import { logger } from "./logger";

export interface FetchSerperInput {
  orgs: string[];
  outlets: string[];
  date_range: { from: string; to: string };
  query_keywords: string[];
}

export interface FetchYouTubeInput {
  handles: string[];
  date_range: { from: string; to: string };
}

export interface FetchXApiInput {
  handles: string[];
  date_range: { from: string; to: string };
}

export interface FetchSemrushInput {
  domains: string[];
  target_orgs: string[];
}

export interface FetchLLMVisibilityInput {
  orgs: string[];
  queries: string[];
  llms: string[];
}

// ---------------------------------------------------------------------------
// REAL: fetch_serper — Serper News API
// ---------------------------------------------------------------------------
export async function fetchSerper(input: FetchSerperInput) {
  const apiKey = process.env.SERPER_API_KEY;

  if (!apiKey) {
    logger.warn("SERPER_API_KEY not set — falling back to stub");
    return fetchSerperStub(input);
  }

  logger.info({ input }, "fetchSerper REAL called");

  const results: Record<
    string,
    Record<
      string,
      {
        mentions: number;
        dofollow: number;
        direct_cites: number;
        tone: string;
        articles: { title: string; link: string; date: string; snippet: string }[];
      }
    >
  > = {};

  for (const org of input.orgs) {
    results[org] = {};

    for (const outlet of input.outlets) {
      // Build a targeted query: org + outlet + keywords
      const keywordStr = input.query_keywords.slice(0, 3).join(" ");
      const query = `${org} ${keywordStr} site:${outletToDomain(outlet)}`;

      try {
        const response = await fetch("https://google.serper.dev/news", {
          method: "POST",
          headers: {
            "X-API-KEY": apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            q: query,
            num: 20,
            tbs: buildSerperDateRange(input.date_range.from, input.date_range.to),
          }),
        });

        if (!response.ok) {
          logger.error({ status: response.status, outlet, org }, "Serper API error");
          results[org][outlet] = emptySerperResult();
          continue;
        }

        const data = (await response.json()) as {
          news?: {
            title: string;
            link: string;
            date: string;
            snippet: string;
          }[];
        };

        const articles = data.news ?? [];
        const mentions = articles.length;

        // Estimate dofollow: treat links from major outlets as dofollow-likely
        const dofollow = Math.floor(mentions * 0.6);
        const direct_cites = articles.filter((a) =>
          a.snippet?.toLowerCase().includes(org.toLowerCase())
        ).length;

        // Naive tone: positive if no negative keywords in snippets
        const negativeKeywords = ["fail", "crisis", "pollution spike", "violat", "warn", "risk"];
        const negCount = articles.filter((a) =>
          negativeKeywords.some((kw) => a.snippet?.toLowerCase().includes(kw))
        ).length;
        const tone = negCount > mentions * 0.3 ? "N" : "A";

        results[org][outlet] = {
          mentions,
          dofollow,
          direct_cites,
          tone,
          articles: articles.slice(0, 5).map((a) => ({
            title: a.title,
            link: a.link,
            date: a.date,
            snippet: a.snippet,
          })),
        };

        logger.info({ org, outlet, mentions }, "Serper fetch complete");
      } catch (err) {
        logger.error({ err, org, outlet }, "Serper fetch threw");
        results[org][outlet] = emptySerperResult();
      }
    }
  }

  return { stub: false, data: results, date_range: input.date_range };
}

function emptySerperResult() {
  return { mentions: 0, dofollow: 0, direct_cites: 0, tone: "N", articles: [] };
}

/** Convert outlet name to a rough domain for site: queries */
function outletToDomain(outlet: string): string {
  const map: Record<string, string> = {
    "The Guardian": "theguardian.com",
    Guardian: "theguardian.com",
    BBC: "bbc.co.uk",
    Reuters: "reuters.com",
    "AP News": "apnews.com",
    "New York Times": "nytimes.com",
    NYT: "nytimes.com",
    Bloomberg: "bloomberg.com",
    "Washington Post": "washingtonpost.com",
    CNN: "cnn.com",
    Forbes: "forbes.com",
    "The Independent": "independent.co.uk",
    "The Times": "thetimes.co.uk",
    Telegraph: "telegraph.co.uk",
  };
  return map[outlet] ?? outlet.toLowerCase().replace(/\s+/g, "") + ".com";
}

/** Build Serper tbs (time-based search) param from ISO dates */
function buildSerperDateRange(from: string, to: string): string {
  // Serper accepts: cdr:1,cd_min:MM/DD/YYYY,cd_max:MM/DD/YYYY
  const fmt = (iso: string) => {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
  };
  return `cdr:1,cd_min:${fmt(from)},cd_max:${fmt(to)}`;
}

/** Stub fallback when no API key */
function fetchSerperStub(input: FetchSerperInput) {
  logger.info({ input }, "fetchSerper STUB called");
  const results: Record<
    string,
    Record<string, { mentions: number; dofollow: number; direct_cites: number; tone: string }>
  > = {};
  for (const org of input.orgs) {
    results[org] = {};
    for (const outlet of input.outlets) {
      const mentions = Math.floor(Math.random() * 30) + 1;
      const dofollow = Math.floor(Math.random() * mentions);
      results[org][outlet] = {
        mentions,
        dofollow,
        direct_cites: Math.floor(Math.random() * Math.min(dofollow, 5)),
        tone: Math.random() > 0.4 ? "A" : "N",
      };
    }
  }
  return { stub: true, data: results, date_range: input.date_range };
}

// ---------------------------------------------------------------------------
// STUB: fetch_youtube
// ---------------------------------------------------------------------------
export async function fetchYouTube(input: FetchYouTubeInput) {
  logger.info({ input }, "fetchYouTube STUB called");
  const results: Record<
    string,
    {
      platform: string;
      impressions: number;
      likes: number;
      shares: number;
      comments: number;
      saves: number;
      quote_rt: number;
    }
  > = {};
  for (const handle of input.handles) {
    const impressions = Math.floor(Math.random() * 500_000) + 50_000;
    const er = 0.02 + Math.random() * 0.05;
    const engagement = Math.floor(impressions * er);
    results[handle] = {
      platform: "YT Long-form",
      impressions,
      likes: Math.floor(engagement * 0.6),
      shares: Math.floor(engagement * 0.15),
      comments: Math.floor(engagement * 0.15),
      saves: Math.floor(engagement * 0.08),
      quote_rt: Math.floor(engagement * 0.02),
    };
  }
  return { stub: true, data: results };
}

// ---------------------------------------------------------------------------
// STUB: fetch_x_api
// ---------------------------------------------------------------------------
export async function fetchXApi(input: FetchXApiInput) {
  logger.info({ input }, "fetchXApi STUB called");
  const results: Record<
    string,
    {
      platform: string;
      impressions: number;
      likes: number;
      shares: number;
      comments: number;
      saves: number;
      quote_rt: number;
    }
  > = {};
  for (const handle of input.handles) {
    const impressions = Math.floor(Math.random() * 200_000) + 20_000;
    const er = 0.015 + Math.random() * 0.04;
    const engagement = Math.floor(impressions * er);
    results[handle] = {
      platform: "X",
      impressions,
      likes: Math.floor(engagement * 0.5),
      shares: Math.floor(engagement * 0.2),
      comments: Math.floor(engagement * 0.2),
      saves: Math.floor(engagement * 0.05),
      quote_rt: Math.floor(engagement * 0.05),
    };
  }
  return { stub: true, data: results };
}

// ---------------------------------------------------------------------------
// STUB: fetch_semrush
// ---------------------------------------------------------------------------
export async function fetchSemrush(input: FetchSemrushInput) {
  logger.info({ input }, "fetchSemrush STUB called");
  const results: Record<string, number> = {};
  for (const domain of input.domains) {
    results[domain] = Math.floor(Math.random() * 50) + 5;
  }
  return { stub: true, data: results };
}

// ---------------------------------------------------------------------------
// STUB: fetch_llm_visibility
// ---------------------------------------------------------------------------
export async function fetchLLMVisibility(input: FetchLLMVisibilityInput) {
  logger.info({ input }, "fetchLLMVisibility STUB called");
  const results: {
    org: string;
    llm: string;
    mention_count: number;
    avg_position: number;
    citation_type: string;
    direct_links: number;
  }[] = [];
  const citationTypes = ["Direct", "Passing", "None"];
  for (const org of input.orgs) {
    for (const llm of input.llms) {
      results.push({
        org,
        llm,
        mention_count: Math.floor(Math.random() * 18) + 2,
        avg_position: parseFloat((1 + Math.random() * 3).toFixed(1)),
        citation_type: citationTypes[Math.floor(Math.random() * citationTypes.length)],
        direct_links: Math.floor(Math.random() * 5),
      });
    }
  }
  return { stub: true, data: results };
}
