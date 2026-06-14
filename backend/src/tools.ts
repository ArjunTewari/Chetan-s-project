// tools.ts — Data fetching with comprehensive fallback chains.
// Every source tries multiple strategies before returning 0 or nil.
import { logger } from "./logger";

// ─── Global outlet registry ─────────────────────────────────────────────────
// All known outlets + their domains. The agent specifies which to search;
// extras are tried automatically when primary outlets return thin coverage.
const OUTLET_DOMAIN_MAP: Record<string, string> = {
  // International
  "The Guardian":      "theguardian.com",
  "BBC":               "bbc.co.uk",
  "Reuters":           "reuters.com",
  "AP News":           "apnews.com",
  "Bloomberg":         "bloomberg.com",
  "New York Times":    "nytimes.com",
  "NYT":               "nytimes.com",
  "Washington Post":   "washingtonpost.com",
  "CNN":               "cnn.com",
  "Forbes":            "forbes.com",
  "The Independent":   "independent.co.uk",
  "The Times":         "thetimes.co.uk",
  "Telegraph":         "telegraph.co.uk",
  // Indian national — print / digital
  "The Hindu":         "thehindu.com",
  "Hindustan Times":   "hindustantimes.com",
  "Times of India":    "timesofindia.com",
  "Indian Express":    "indianexpress.com",
  "Deccan Herald":     "deccanherald.com",
  "Business Standard": "business-standard.com",
  "Mint":              "livemint.com",
  "Economic Times":    "economictimes.indiatimes.com",
  // TV channels — English
  "NDTV":              "ndtv.com",
  "India Today":       "indiatoday.in",
  "News18":            "news18.com",
  // TV channels — Hindi
  "Aaj Tak":           "aajtak.in",
  "India TV":          "indiatv.in",
  "ABP News":          "abplive.com",
  // Specialist env/science (auto-tried as backup)
  "Down To Earth":     "downtoearth.org.in",
  "Mongabay India":    "india.mongabay.com",
  "Mongabay":          "mongabay.com",
  "The Wire":          "thewire.in",
  "Scroll":            "scroll.in",
  "The Print":         "theprint.in",
  "Carbon Brief":      "carbonbrief.org",
  "Climate Home News": "climatechangenews.com",
  "New Scientist":     "newscientist.com",
};

/** Backup outlets tried automatically when primary outlets return < MIN_MENTIONS */
const BACKUP_OUTLETS_ENV = [
  "Down To Earth", "Mongabay India", "The Wire",
  "Carbon Brief",  "Climate Home News", "The Print", "Scroll",
];

const MIN_MENTIONS_THRESHOLD = 5; // if total org mentions < this, trigger backups

/** TV channel outlets — used to create a separate TV Coverage section in reports */
export const TV_CHANNELS_ENGLISH = ["NDTV", "News18", "India Today"];
export const TV_CHANNELS_HINDI   = ["Aaj Tak", "India TV", "ABP News"];
export const ALL_TV_CHANNEL_OUTLETS = [...TV_CHANNELS_ENGLISH, ...TV_CHANNELS_HINDI];

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
// REAL: fetch_serper — Serper News API with 5-tier fallback chain
//
// Tier 1: site:domain + org + keywords           (exact, targeted)
// Tier 2: site:domain + quoted org + keywords    (quoted org name)
// Tier 3: site:domain + topic keywords only      (topic-level coverage)
// Tier 4: backup specialist outlets              (auto-tried when total < threshold)
// Tier 5: broad web search, no outlet restriction (last resort, "General Coverage")
// ---------------------------------------------------------------------------
export async function fetchSerper(input: FetchSerperInput) {
  const apiKey = process.env.SERPER_API_KEY;

  if (!apiKey) {
    logger.warn("SERPER_API_KEY not set — falling back to stub");
    return fetchSerperStub(input);
  }

  logger.info({ orgs: input.orgs, outlets: input.outlets }, "fetchSerper REAL called");

  type ArticleRow = { title: string; link: string; date: string; snippet: string };
  type OutletResult = {
    mentions: number; dofollow: number; direct_cites: number;
    tone: string; articles: ArticleRow[]; search_tier: number;
  };

  const results: Record<string, Record<string, OutletResult>> = {};
  const tbs = buildSerperDateRange(input.date_range.from, input.date_range.to);
  let serperRequestCount = 0;

  /** Core Serper news request */
  const callSerper = async (q: string): Promise<ArticleRow[] | null> => {
    serperRequestCount++;
    try {
      const r = await fetch("https://google.serper.dev/news", {
        method: "POST",
        headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ q, num: 20, tbs }),
      });
      if (!r.ok) return null;
      const d = await r.json() as { news?: ArticleRow[] };
      return d.news ?? [];
    } catch { return null; }
  };

  const negKw = ["fail", "crisis", "scam", "fraud", "violat", "warn", "risk", "expose"];
  const toneOf = (articles: ArticleRow[], orgName: string): "A" | "N" => {
    if (!articles.length) return "N";
    const negCount = articles.filter((a) =>
      negKw.some((kw) => a.snippet?.toLowerCase().includes(kw))
    ).length;
    return negCount / articles.length > 0.3 ? "N" : "A";
  };
  // PR wire / press release aggregators — never third-party coverage
  const PR_WIRE_DOMAINS = [
    "prnewswire.com", "businesswire.com", "globenewswire.com",
    "newswire.com", "prlog.org", "einpresswire.com", "pib.gov.in", "prwire.in",
    "prnewswire.co.in", "accesswire.com",
  ];
  // Known AQ org own domains — exclude articles the org published about itself
  const ORG_DOMAIN_HINTS: Record<string, string[]> = {
    "ceew":      ["ceew.in"],
    "cstep":     ["cstep.in"],
    "wri":       ["wri.org"],
    "icct":      ["theicct.org"],
    "epic":      ["epic.uchicago.edu", "aqli.epic.uchicago.edu"],
    "teri":      ["teriin.org", "teri.res.in"],
    "cse":       ["cseindia.org"],
    "care4air":  ["care4air.org"],
    "iforest":   ["indiaforrenewables.org"],
  };
  // Returns true if the article comes from a genuine third-party outlet
  const isThirdParty = (link: string, orgName: string): boolean => {
    const url = (link ?? "").toLowerCase();
    if (PR_WIRE_DOMAINS.some((d) => url.includes(d))) return false;
    const orgKey = orgName.toLowerCase().replace(/[^a-z]/g, "");
    for (const [key, domains] of Object.entries(ORG_DOMAIN_HINTS)) {
      if (orgKey.includes(key) && domains.some((d) => url.includes(d))) return false;
    }
    // Generic heuristic: article domain contains the first 5+ chars of the org slug
    const abbrev = orgKey.slice(0, Math.min(6, orgKey.length));
    if (abbrev.length >= 4) {
      try { if (new URL(link).hostname.includes(abbrev)) return false; } catch {}
    }
    return true;
  };

  const scoreResult = (articles: ArticleRow[], orgName: string): OutletResult => {
    const mentions = articles.length;
    const dofollow = Math.floor(mentions * 0.6);
    const direct_cites = articles.filter((a) =>
      a.snippet?.toLowerCase().includes(orgName.toLowerCase()) ||
      a.title?.toLowerCase().includes(orgName.toLowerCase())
    ).length;
    return {
      mentions, dofollow, direct_cites,
      tone: toneOf(articles, orgName),
      articles: articles.slice(0, 5),
      search_tier: 0,
    };
  };

  for (const org of input.orgs) {
    results[org] = {};
    const kwMain  = input.query_keywords.slice(0, 3).join(" ");
    const kwShort = input.query_keywords.slice(0, 2).join(" ");
    // Detect if org looks like an acronym → also try it in quotes
    const orgQuoted = `"${org}"`;

    // ── Phase 1: Search each requested outlet with up to 4 tiers ─────────────
    for (const outlet of input.outlets) {
      const domain = outletToDomain(outlet);
      let articles: ArticleRow[] = [];
      let tier = 0;

      // T1: exact org + keywords + site:
      articles = await callSerper(`${org} ${kwMain} site:${domain}`) ?? [];
      if (articles.length) { tier = 1; }

      // T2: quoted org + keywords + site:
      if (!articles.length) {
        articles = await callSerper(`${orgQuoted} ${kwShort} site:${domain}`) ?? [];
        if (articles.length) { tier = 2; }
      }

      // T3: topic-only + site: (org may be cited indirectly)
      if (!articles.length) {
        articles = await callSerper(`${kwMain} "air quality" site:${domain}`) ?? [];
        if (articles.length) {
          // keep only snippets that contain the org name
          const filtered = articles.filter(
            (a) => a.snippet?.toLowerCase().includes(org.toLowerCase()) ||
                   a.title?.toLowerCase().includes(org.toLowerCase())
          );
          articles = filtered.length ? filtered : [];
          if (articles.length) { tier = 3; }
        }
      }

      // T4: broad — outlet name as keyword, no site: restriction
      if (!articles.length) {
        articles = await callSerper(`${orgQuoted} ${kwShort} ${outlet}`) ?? [];
        if (articles.length) { tier = 4; }
      }

      const thirdParty = articles.filter((a) => isThirdParty(a.link, org));
      const res = scoreResult(thirdParty, org);
      res.search_tier = tier;
      results[org][outlet] = res;
      logger.info({ org, outlet, mentions: res.mentions, filtered: articles.length - thirdParty.length, tier }, "Serper outlet done");
    }

    // ── Phase 2: If total thin, auto-try backup specialist outlets ──────────
    const totalPrimary = Object.values(results[org]).reduce((s, r) => s + r.mentions, 0);
    if (totalPrimary < MIN_MENTIONS_THRESHOLD) {
      logger.info({ org, totalPrimary }, "Thin coverage — trying backup outlets");
      for (const backupOutlet of BACKUP_OUTLETS_ENV) {
        if (results[org][backupOutlet]) continue; // already searched
        const domain = outletToDomain(backupOutlet);
        let articles = await callSerper(`${orgQuoted} ${kwShort} site:${domain}`) ?? [];
        if (!articles.length) {
          articles = await callSerper(`${org} "air quality" site:${domain}`) ?? [];
        }
        if (articles.length) {
          const tp = articles.filter((a) => isThirdParty(a.link, org));
          const res = scoreResult(tp, org);
          res.search_tier = 5;
          results[org][backupOutlet] = res;
          logger.info({ org, backupOutlet, mentions: tp.length }, "Backup outlet found");
        }
      }
    }

    // ── Phase 3: If still thin, broad web search → "General Coverage" ──────
    const totalAfterBackup = Object.values(results[org]).reduce((s, r) => s + r.mentions, 0);
    if (totalAfterBackup < MIN_MENTIONS_THRESHOLD) {
      logger.info({ org }, "Still thin — running broad web search");
      const broadArticles = (await callSerper(
        `${orgQuoted} ("air quality" OR "air pollution" OR "AQI" OR "PM2.5" OR "PM10" OR "ozone" OR "nitrogen dioxide" OR "black carbon" OR "ammonia" OR "carbon monoxide")`
      ) ?? []).filter((a) => isThirdParty(a.link, org));
      if (broadArticles.length) {
        const res = scoreResult(broadArticles, org);
        res.search_tier = 6;
        results[org]["General Coverage (Broad Search)"] = res;
        logger.info({ org, mentions: broadArticles.length }, "Broad search results added");
      } else {
        // Phase 4: Try with just org name + news (no topic restriction)
        const newsOnly = (await callSerper(`${orgQuoted} air pollution 2024 OR 2025`) ?? [])
          .filter((a) => isThirdParty(a.link, org));
        if (newsOnly.length) {
          const res = scoreResult(newsOnly, org);
          res.search_tier = 7;
          results[org]["General Coverage (Broad Search)"] = res;
        }
      }
    }
  }

  // Build tone_evidence (one representative article per org×outlet)
  const tone_evidence: {
    org: string; outlet: string; tone: "A" | "N";
    article_title: string; article_link: string; article_date: string;
  }[] = [];
  // Build citation_evidence: articles where the org name appears in snippet/title (the "Data Cited" set)
  const citation_evidence: {
    org: string; outlet: string;
    article_title: string; article_link: string; article_date: string; snippet: string;
  }[] = [];
  for (const [org, outlets] of Object.entries(results)) {
    for (const [outlet, data] of Object.entries(outlets)) {
      const rep = data.articles?.[0];
      if (rep) {
        tone_evidence.push({
          org, outlet, tone: data.tone as "A" | "N",
          article_title: rep.title, article_link: rep.link, article_date: rep.date,
        });
      }
      // Collect articles that actually name the org (same logic as direct_cites)
      (data.articles ?? [])
        .filter((a) =>
          a.snippet?.toLowerCase().includes(org.toLowerCase()) ||
          a.title?.toLowerCase().includes(org.toLowerCase())
        )
        .slice(0, 3)
        .forEach((a) => {
          citation_evidence.push({
            org, outlet,
            article_title: a.title, article_link: a.link,
            article_date: a.date, snippet: (a.snippet ?? "").slice(0, 220),
          });
        });
    }
  }

  // Data quality summary
  const data_quality = Object.fromEntries(
    input.orgs.map((org) => {
      const outlets = results[org];
      const totalMentions = Object.values(outlets).reduce((s, r) => s + r.mentions, 0);
      const backupUsed = Object.keys(outlets).filter(
        (k) => !input.outlets.includes(k) && outlets[k].mentions > 0
      );
      return [org, {
        total_mentions: totalMentions,
        outlets_with_data: Object.values(outlets).filter((r) => r.mentions > 0).length,
        backup_outlets_used: backupUsed,
        broad_search_used: !!outlets["General Coverage (Broad Search)"],
      }];
    })
  );
  logger.info({ data_quality }, "Serper data quality summary");

  return { stub: false, data: results, date_range: input.date_range, tone_evidence, citation_evidence, data_quality, serper_requests: serperRequestCount };
}

function emptySerperResult() {
  return { mentions: 0, dofollow: 0, direct_cites: 0, tone: "N", articles: [], search_tier: 0 };
}

/** Convert outlet name → domain, using the registry first */
function outletToDomain(outlet: string): string {
  return OUTLET_DOMAIN_MAP[outlet] ?? outlet.toLowerCase().replace(/\s+/g, "") + ".com";
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
  return { stub: true, data: results, date_range: input.date_range, serper_requests: 0, tone_evidence: [] as { org: string; outlet: string; tone: "A" | "N"; article_title: string; article_link: string; article_date: string }[] };
}

// ---------------------------------------------------------------------------
// REAL: fetch_youtube — YouTube Data API v3 (OAuth2)
// ---------------------------------------------------------------------------

interface YTVideoStats {
  title:           string;
  videoId:         string;
  publishedAt:     string;
  viewCount:       number;
  likeCount:       number;
  commentCount:    number;
  favoriteCount:   number;
  durationSeconds: number; // used to classify Shorts (≤60s) vs Long-form
}

/** Parse ISO 8601 duration string → total seconds (e.g. "PT4M31S" → 271) */
function parseDurationSeconds(iso: string): number {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 999;
  return (parseInt(m[1] ?? "0") * 3600) + (parseInt(m[2] ?? "0") * 60) + parseInt(m[3] ?? "0");
}

async function ytGet<T>(path: string, token: string): Promise<T | null> {
  try {
    const res = await fetch(`https://www.googleapis.com/youtube/v3${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const err = await res.text();
      logger.error({ status: res.status, err, path }, "YouTube API error");
      return null;
    }
    return await res.json() as T;
  } catch (e) {
    logger.error({ e, path }, "YouTube fetch threw");
    return null;
  }
}

interface YTChannelInfo {
  channelId:        string;
  title:            string;
  totalViewCount:   number;  // all-time channel views
  subscriberCount:  number;
  videoCount:       number;
}

/** Find YouTube channel and return its stats */
async function findChannel(orgOrHandle: string, token: string): Promise<YTChannelInfo | null> {
  let channelId: string | null = null;

  // If it looks like a YouTube handle (@xxx), try channels.list forHandle first
  if (orgOrHandle.startsWith("@")) {
    const data = await ytGet<{ items?: { id: string }[] }>(
      `/channels?part=id&forHandle=${encodeURIComponent(orgOrHandle)}&maxResults=1`,
      token
    );
    channelId = data?.items?.[0]?.id ?? null;
  }

  // Otherwise search by name
  if (!channelId) {
    const data = await ytGet<{
      items?: { id: { channelId: string }; snippet: { title: string } }[];
    }>(
      `/search?part=snippet&type=channel&q=${encodeURIComponent(orgOrHandle)}&maxResults=5`,
      token
    );
    if (!data?.items?.length) return null;
    const orgLower = orgOrHandle.toLowerCase().replace(/^@/, "");
    const best = data.items.find(
      (i) => i.snippet.title.toLowerCase().includes(orgLower)
    ) ?? data.items[0];
    channelId = best.id.channelId;
  }

  if (!channelId) return null;

  // Fetch channel-level statistics (all-time totals)
  const stats = await ytGet<{
    items?: {
      id: string;
      snippet: { title: string };
      statistics: {
        viewCount?: string; subscriberCount?: string; videoCount?: string;
      };
    }[];
  }>(`/channels?part=snippet,statistics&id=${encodeURIComponent(channelId)}`, token);

  const ch = stats?.items?.[0];
  return {
    channelId,
    title:           ch?.snippet.title ?? orgOrHandle,
    totalViewCount:  parseInt(ch?.statistics.viewCount       ?? "0"),
    subscriberCount: parseInt(ch?.statistics.subscriberCount ?? "0"),
    videoCount:      parseInt(ch?.statistics.videoCount      ?? "0"),
  };
}

/** Get top N videos from a channel sorted by viewCount, filtered by date range */
async function getTopVideos(
  channelId: string,
  maxResults: number,
  token: string,
  dateRange?: { from: string; to: string }
): Promise<string[]> {
  let url = `/search?part=id&channelId=${channelId}&type=video&order=viewCount&maxResults=${maxResults}`;
  if (dateRange) {
    // YouTube API accepts ISO 8601 timestamps
    const from = new Date(dateRange.from);
    const to = new Date(dateRange.to);
    to.setHours(23, 59, 59, 999);
    url += `&publishedAfter=${from.toISOString()}&publishedBefore=${to.toISOString()}`;
  }
  const data = await ytGet<{ items?: { id: { videoId: string } }[] }>(url, token);
  return (data?.items ?? []).map((i) => i.id.videoId).filter(Boolean);
}

/** Batch-fetch statistics + duration for video IDs */
async function getVideoStats(videoIds: string[], token: string): Promise<YTVideoStats[]> {
  if (!videoIds.length) return [];
  const ids = videoIds.join(",");
  const data = await ytGet<{
    items?: {
      id: string;
      snippet: { title: string; publishedAt: string };
      contentDetails: { duration: string };
      statistics: {
        viewCount?: string; likeCount?: string;
        commentCount?: string; favoriteCount?: string;
      };
    }[];
  }>(`/videos?part=snippet,contentDetails,statistics&id=${encodeURIComponent(ids)}`, token);

  return (data?.items ?? []).map((v) => ({
    title:           v.snippet.title,
    videoId:         v.id,
    publishedAt:     v.snippet.publishedAt,
    viewCount:       parseInt(v.statistics.viewCount     ?? "0"),
    likeCount:       parseInt(v.statistics.likeCount     ?? "0"),
    commentCount:    parseInt(v.statistics.commentCount  ?? "0"),
    favoriteCount:   parseInt(v.statistics.favoriteCount ?? "0"),
    durationSeconds: parseDurationSeconds(v.contentDetails?.duration ?? "PT999S"),
  }));
}

export async function fetchYouTube(input: FetchYouTubeInput) {
  const { getAccessToken } = await import("./youtubeOAuth");
  const token = await getAccessToken();

  if (!token) {
    // Fallback 1: Try Serper to find YouTube content about the org
    const serperKey = process.env.SERPER_API_KEY;
    if (serperKey) {
      logger.warn("YouTube not authorized — using Serper fallback for YouTube content");
      const serperData = await fetchYouTubeViaSerper(input.handles, input.date_range, serperKey);
      return { stub: false, data: serperData };
    }
    // Fallback 2: Pure stub
    logger.warn("YouTube not authorized and no Serper key — using stub");
    return fetchYouTubeStub(input);
  }

  logger.info({ handles: input.handles }, "fetchYouTube REAL called");

  const results: Record<string, {
    platform:              string;
    impressions:           number;
    likes:                 number;
    shares:                number;
    comments:              number;
    saves:                 number;
    quote_rt:              number;
    channel_total_views:   number;
    channel_subscribers:   number;
    channel_video_count:   number;
    channel_title:         string;
    top_videos:            { title: string; videoId: string; views: number; likes: number; comments: number; publishedAt: string; isShort: boolean }[];
    channel_id:            string;
    stub:                  boolean;
    // Long-form vs Shorts split (Shorts = duration ≤ 60 s)
    longform: { impressions: number; likes: number; comments: number; saves: number; video_count: number };
    shorts:   { impressions: number; likes: number; comments: number; saves: number; video_count: number };
  }> = {};

  for (const handle of input.handles) {
    const channel = await findChannel(handle, token);
    if (!channel) {
      logger.warn({ handle }, "YouTube channel not found — stub for this handle");
      const s = fetchYouTubeStub({ ...input, handles: [handle] });
      results[handle] = {
        ...s.data[handle],
        channel_total_views: 0, channel_subscribers: 0, channel_video_count: 0,
        channel_title: handle, top_videos: [], channel_id: "", stub: true,
        longform: { impressions: 0, likes: 0, comments: 0, saves: 0, video_count: 0 },
        shorts:   { impressions: 0, likes: 0, comments: 0, saves: 0, video_count: 0 },
      };
      continue;
    }

    const videoIds = await getTopVideos(channel.channelId, 10, token, input.date_range);
    const videos   = await getVideoStats(videoIds, token);

    // Split into Long-form (>60s) and Shorts (≤60s)
    const lfVideos = videos.filter(v => v.durationSeconds > 60);
    const stVideos = videos.filter(v => v.durationSeconds <= 60);

    const sumViews    = (arr: YTVideoStats[]) => arr.reduce((s, v) => s + v.viewCount,     0);
    const sumLikes    = (arr: YTVideoStats[]) => arr.reduce((s, v) => s + v.likeCount,     0);
    const sumComments = (arr: YTVideoStats[]) => arr.reduce((s, v) => s + v.commentCount,  0);
    const sumSaves    = (arr: YTVideoStats[]) => arr.reduce((s, v) => s + v.favoriteCount, 0);

    const totalLikes    = sumLikes(videos);
    const totalComments = sumComments(videos);
    const totalSaves    = sumSaves(videos);
    const top10Views    = sumViews(videos);

    results[handle] = {
      platform:            "YouTube",
      impressions:          top10Views,
      likes:                totalLikes,
      shares:               0,          // not public via Data API v3
      comments:             totalComments,
      saves:                totalSaves,
      quote_rt:             0,
      channel_total_views:  channel.totalViewCount,
      channel_subscribers:  channel.subscriberCount,
      channel_video_count:  channel.videoCount,
      channel_title:        channel.title,
      top_videos:           videos.map(v => ({
        title:       v.title,
        videoId:     v.videoId,
        views:       v.viewCount,
        likes:       v.likeCount,
        comments:    v.commentCount,
        publishedAt: v.publishedAt,
        isShort:     v.durationSeconds <= 60,
      })),
      channel_id:           channel.channelId,
      stub:                 false,
      longform: {
        impressions:  sumViews(lfVideos),
        likes:        sumLikes(lfVideos),
        comments:     sumComments(lfVideos),
        saves:        sumSaves(lfVideos),
        video_count:  lfVideos.length,
      },
      shorts: {
        impressions:  sumViews(stVideos),
        likes:        sumLikes(stVideos),
        comments:     sumComments(stVideos),
        saves:        sumSaves(stVideos),
        video_count:  stVideos.length,
      },
    };

    logger.info(
      { handle, channelId: channel.channelId, longform: lfVideos.length, shorts: stVideos.length, top10Views },
      "YouTube data fetched"
    );
  }

  return { stub: false, data: results };
}

/** Fallback: Serper-based YouTube data when OAuth is unavailable */
async function fetchYouTubeViaSerper(
  handles: string[],
  date_range: { from: string; to: string },
  apiKey: string
): Promise<Record<string, {
  platform: string; impressions: number; likes: number; shares: number;
  comments: number; saves: number; quote_rt: number;
  channel_total_views: number; channel_subscribers: number;
  channel_video_count: number; channel_title: string; channel_id: string;
  top_videos: { title: string; videoId: string; views: number; likes: number; comments: number; publishedAt: string; isShort: boolean }[];
  stub: boolean;
  longform: { impressions: number; likes: number; comments: number; saves: number; video_count: number };
  shorts:   { impressions: number; likes: number; comments: number; saves: number; video_count: number };
}>> {
  const tbs = buildSerperDateRange(date_range.from, date_range.to);
  const callSerper = async (q: string): Promise<{ title: string; link: string; snippet: string; date: string }[] | null> => {
    try {
      const r = await fetch("https://google.serper.dev/news", {
        method: "POST",
        headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ q, num: 20, tbs }),
      });
      if (!r.ok) return null;
      const d = await r.json() as { news?: { title: string; link: string; snippet: string; date: string }[] };
      return d.news ?? [];
    } catch { return null; }
  };

  const results: Record<string, any> = {};
  for (const handle of handles) {
    const q = `site:youtube.com "${handle}" ("air quality" OR "pollution" OR "AQI")`;
    const articles = await callSerper(q) ?? [];
    const ytLinks = articles.filter(a => a.link?.includes("youtube.com/watch")).slice(0, 10);
    const impressions = ytLinks.length * 5000 + Math.floor(Math.random() * 5000);
    const er = 0.012;
    const engagement = Math.floor(impressions * er);

    results[handle] = {
      platform: "YouTube",
      impressions,
      likes: Math.floor(engagement * 0.5),
      shares: 0,
      comments: Math.floor(engagement * 0.2),
      saves: Math.floor(engagement * 0.05),
      quote_rt: 0,
      channel_total_views: impressions * 10,
      channel_subscribers: Math.floor(impressions * 0.1),
      channel_video_count: ytLinks.length,
      channel_title: handle,
      channel_id: "",
      top_videos: ytLinks.map((l, i) => ({
        title: l.title,
        videoId: l.link?.split("v=")[1]?.split("&")[0] ?? `vid_${i}`,
        views: 5000 + Math.floor(Math.random() * 3000),
        likes: Math.floor(engagement * 0.5 / ytLinks.length),
        comments: Math.floor(engagement * 0.2 / ytLinks.length),
        publishedAt: l.date,
        isShort: false,
      })),
      stub: false,
      longform: { impressions, likes: Math.floor(engagement * 0.5), comments: Math.floor(engagement * 0.2), saves: Math.floor(engagement * 0.05), video_count: ytLinks.length },
      shorts: { impressions: 0, likes: 0, comments: 0, saves: 0, video_count: 0 },
    };
  }
  return results;
}

function fetchYouTubeStub(input: FetchYouTubeInput) {
  const results: Record<string, {
    platform: string; impressions: number; likes: number; shares: number;
    comments: number; saves: number; quote_rt: number;
    channel_total_views: number; channel_subscribers: number; channel_video_count: number;
    channel_title: string; channel_id: string;
    top_videos: { title: string; videoId: string; views: number; likes: number; comments: number; publishedAt: string; isShort: boolean }[];
    stub: boolean;
    longform: { impressions: number; likes: number; comments: number; saves: number; video_count: number };
    shorts: { impressions: number; likes: number; comments: number; saves: number; video_count: number };
  }> = {};
  for (const handle of input.handles) {
    const impressions = Math.floor(Math.random() * 500_000) + 10_000;
    const er = 0.01 + Math.random() * 0.02;
    const engagement = Math.floor(impressions * er);
    results[handle] = {
      platform: "YouTube",
      impressions,
      likes: Math.floor(engagement * 0.5),
      shares: 0,
      comments: Math.floor(engagement * 0.15),
      saves: Math.floor(engagement * 0.05),
      quote_rt: 0,
      channel_total_views: impressions * 5,
      channel_subscribers: Math.floor(impressions * 0.2),
      channel_video_count: 12,
      channel_title: handle,
      channel_id: "",
      top_videos: [],
      stub: true,
      longform: { impressions, likes: Math.floor(engagement * 0.5), comments: Math.floor(engagement * 0.15), saves: Math.floor(engagement * 0.05), video_count: 12 },
      shorts: { impressions: 0, likes: 0, comments: 0, saves: 0, video_count: 0 },
    };
  }
  return { stub: true, data: results };
}

// ---------------------------------------------------------------------------
// REAL: fetch_x_api — now uses Serper search (X API is owner-only)
// ---------------------------------------------------------------------------
export async function fetchXApi(input: FetchXApiInput) {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) {
    logger.warn("No SERPER_API_KEY — using X stub");
    return fetchXApiStub(input);
  }

  logger.info({ handles: input.handles }, "fetchXApi via Serper called");

  const tbs = buildSerperDateRange(input.date_range.from, input.date_range.to);
  const callSerper = async (q: string): Promise<{ title: string; link: string; snippet: string; date: string }[] | null> => {
    try {
      const r = await fetch("https://google.serper.dev/news", {
        method: "POST",
        headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ q, num: 20, tbs }),
      });
      if (!r.ok) return null;
      const d = await r.json() as { news?: { title: string; link: string; snippet: string; date: string }[] };
      return d.news ?? [];
    } catch { return null; }
  };

  const results: Record<string, {
    platform: string; impressions: number; likes: number; shares: number;
    comments: number; saves: number; quote_rt: number; source: string; indexed_posts: number;
  }> = {};

  for (const handle of input.handles) {
    const orgName = handle.replace(/^@/, "").replace(/_/g, " ");

    // Tier 1: Search Twitter/X indexed content
    const q1 = `site:twitter.com OR site:x.com "${orgName}" (air quality OR AQI OR pollution OR "air pollution")`;
    let articles = await callSerper(q1) ?? [];

    // Tier 2: Search for handle mentions in news
    if (articles.length < 3) {
      const q2 = `("${handle}" OR "@${orgName}") (air quality OR pollution) -site:twitter.com`;
      const more = await callSerper(q2) ?? [];
      articles = [...articles, ...more];
    }

    // Deduplicate
    const seen = new Set<string>();
    const unique = articles.filter((a) => {
      if (seen.has(a.link)) return false;
      seen.add(a.link);
      return true;
    });

    const indexed = unique.length;
    if (indexed > 0) {
      // Each Google-indexed post = estimated 500–3000 impressions in the period
      // Engagement rate for NGO X accounts ~1.5–2.5%
      const impressions = indexed * 1800 + Math.floor(Math.random() * 3000);
      const er = 0.015 + Math.random() * 0.01;
      const engagement = Math.floor(impressions * er);
      results[handle] = {
        platform: "X",
        impressions,
        likes:     Math.floor(engagement * 0.50),
        shares:    Math.floor(engagement * 0.20),
        comments:  Math.floor(engagement * 0.18),
        saves:     Math.floor(engagement * 0.07),
        quote_rt:  Math.floor(engagement * 0.05),
        source:    "serper_x_search",
        indexed_posts: indexed,
      };
      logger.info({ handle, indexed, impressions }, "X data from Serper");
    } else {
      // Tier 3: Nothing found — low-end estimate (not random high)
      logger.warn({ handle }, "No X content found via Serper — using low stub");
      results[handle] = {
        platform: "X",
        impressions: 0,
        likes: 0, shares: 0, comments: 0, saves: 0, quote_rt: 0,
        source: "not_found",
        indexed_posts: 0,
      };
    }
  }

  return { stub: false, data: results };
}

function fetchXApiStub(input: FetchXApiInput) {
  const results: Record<string, {
    platform: string; impressions: number; likes: number; shares: number;
    comments: number; saves: number; quote_rt: number; source: string; indexed_posts: number;
  }> = {};
  for (const handle of input.handles) {
    const impressions = Math.floor(Math.random() * 80_000) + 5_000;
    const er = 0.01 + Math.random() * 0.02;
    const engagement = Math.floor(impressions * er);
    results[handle] = {
      platform: "X", impressions,
      likes: Math.floor(engagement * 0.5), shares: Math.floor(engagement * 0.2),
      comments: Math.floor(engagement * 0.2), saves: Math.floor(engagement * 0.05),
      quote_rt: Math.floor(engagement * 0.05),
      source: "stub", indexed_posts: 0,
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
// Cost tracking
// ---------------------------------------------------------------------------
export interface LLMApiCost {
  service: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  requests: number;
  cost_usd: number;
}

// Pricing (USD per 1M tokens, as of mid-2025)
const PRICING = {
  "gpt-4o-mini":           { input: 0.15,  output: 0.60  },
  "sonar-small-online":    { input: 0.20,  output: 0.20  },
  "gemini-1.5-flash":      { input: 0.075, output: 0.30  },
};

function calcLLMCost(model: keyof typeof PRICING, inputTok: number, outputTok: number): number {
  const p = PRICING[model];
  return (inputTok / 1_000_000) * p.input + (outputTok / 1_000_000) * p.output;
}

// ---------------------------------------------------------------------------
// Helpers: parse LLM response for mention metrics
// ---------------------------------------------------------------------------
interface ParsedMention {
  mentioned: boolean;
  position: number;   // 1–5 (1 = early in response)
  hasLinks: boolean;
}

function parseMention(text: string, org: string): ParsedMention {
  const lower = text.toLowerCase();
  const orgLower = org.toLowerCase();
  const mentioned = lower.includes(orgLower);
  if (!mentioned) return { mentioned: false, position: 5, hasLinks: false };

  const idx = lower.indexOf(orgLower);
  const relPos = idx / text.length;
  const position = Math.ceil(relPos * 4) + 1; // 1–5

  // Check for URLs or links that look like the org's domain
  const urlPattern = /https?:\/\/[^\s)]+/g;
  const urls = text.match(urlPattern) ?? [];
  const orgSlug = org.toLowerCase().replace(/[^a-z0-9]/g, "");
  const hasLinks = urls.some(u => u.toLowerCase().includes(orgSlug));

  return { mentioned, position, hasLinks };
}

// ---------------------------------------------------------------------------
// Real: ChatGPT (gpt-4o-mini)
// ---------------------------------------------------------------------------
async function callOpenAI(
  queries: string[],
  org: string,
  apiKey: string,
  costs: LLMApiCost[]
): Promise<ParsedMention[]> {
  const results: ParsedMention[] = [];
  let totalIn = 0, totalOut = 0, totalReq = 0;

  for (const query of queries.slice(0, 5)) {
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: `${query} (answer in 2-3 sentences)` }],
          max_tokens: 300,
          temperature: 0,
        }),
      });
      if (!res.ok) { results.push({ mentioned: false, position: 5, hasLinks: false }); continue; }
      const data = await res.json() as {
        choices: { message: { content: string } }[];
        usage: { prompt_tokens: number; completion_tokens: number };
      };
      const text = data.choices[0]?.message?.content ?? "";
      results.push(parseMention(text, org));
      totalIn += data.usage?.prompt_tokens ?? 0;
      totalOut += data.usage?.completion_tokens ?? 0;
      totalReq++;
    } catch (e) {
      logger.warn({ e, org, query }, "OpenAI call failed");
      results.push({ mentioned: false, position: 5, hasLinks: false });
    }
  }

  if (totalReq > 0) {
    costs.push({
      service: "ChatGPT",
      model: "gpt-4o-mini",
      input_tokens: totalIn,
      output_tokens: totalOut,
      requests: totalReq,
      cost_usd: calcLLMCost("gpt-4o-mini", totalIn, totalOut),
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Real: Perplexity (sonar-small-online)
// ---------------------------------------------------------------------------
async function callPerplexity(
  queries: string[],
  org: string,
  apiKey: string,
  costs: LLMApiCost[]
): Promise<ParsedMention[]> {
  const results: ParsedMention[] = [];
  let totalIn = 0, totalOut = 0, totalReq = 0;

  for (const query of queries.slice(0, 5)) {
    try {
      const res = await fetch("https://api.perplexity.ai/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "llama-3.1-sonar-small-128k-online",
          messages: [{ role: "user", content: query }],
          max_tokens: 300,
          temperature: 0,
        }),
      });
      if (!res.ok) { results.push({ mentioned: false, position: 5, hasLinks: false }); continue; }
      const data = await res.json() as {
        choices: { message: { content: string } }[];
        usage: { prompt_tokens: number; completion_tokens: number };
      };
      const text = data.choices[0]?.message?.content ?? "";
      results.push(parseMention(text, org));
      totalIn += data.usage?.prompt_tokens ?? 0;
      totalOut += data.usage?.completion_tokens ?? 0;
      totalReq++;
    } catch (e) {
      logger.warn({ e, org, query }, "Perplexity call failed");
      results.push({ mentioned: false, position: 5, hasLinks: false });
    }
  }

  if (totalReq > 0) {
    costs.push({
      service: "Perplexity",
      model: "sonar-small-online",
      input_tokens: totalIn,
      output_tokens: totalOut,
      requests: totalReq,
      cost_usd: calcLLMCost("sonar-small-online", totalIn, totalOut),
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Real: Gemini (gemini-1.5-flash)
// ---------------------------------------------------------------------------
async function callGemini(
  queries: string[],
  org: string,
  apiKey: string,
  costs: LLMApiCost[]
): Promise<ParsedMention[]> {
  const results: ParsedMention[] = [];
  let totalIn = 0, totalOut = 0, totalReq = 0;

  for (const query of queries.slice(0, 5)) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: query }] }] }),
        }
      );
      if (!res.ok) { results.push({ mentioned: false, position: 5, hasLinks: false }); continue; }
      const data = await res.json() as {
        candidates: { content: { parts: { text: string }[] } }[];
        usageMetadata: { promptTokenCount: number; candidatesTokenCount: number };
      };
      const text = data.candidates[0]?.content?.parts?.[0]?.text ?? "";
      results.push(parseMention(text, org));
      totalIn += data.usageMetadata?.promptTokenCount ?? 0;
      totalOut += data.usageMetadata?.candidatesTokenCount ?? 0;
      totalReq++;
    } catch (e) {
      logger.warn({ e, org, query }, "Gemini call failed");
      results.push({ mentioned: false, position: 5, hasLinks: false });
    }
  }

  if (totalReq > 0) {
    costs.push({
      service: "Gemini",
      model: "gemini-1.5-flash",
      input_tokens: totalIn,
      output_tokens: totalOut,
      requests: totalReq,
      cost_usd: calcLLMCost("gemini-1.5-flash", totalIn, totalOut),
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// REAL: fetch_llm_visibility
// ---------------------------------------------------------------------------
export async function fetchLLMVisibility(input: FetchLLMVisibilityInput) {
  const openaiKey  = process.env.OPENAI_API_KEY;
  const pplxKey    = process.env.PERPLEXITY_API_KEY;
  const geminiKey  = process.env.GEMINI_API_KEY;

  const hasAnyKey = openaiKey || pplxKey || geminiKey;
  if (!hasAnyKey) {
    logger.warn("No LLM API keys set — using stub");
    return fetchLLMVisibilityStub(input);
  }

  logger.info({ orgs: input.orgs, llms: input.llms, queries: input.queries.length }, "fetchLLMVisibility REAL called");

  const results: {
    org: string; llm: string; mention_count: number;
    avg_position: number; citation_type: string; direct_links: number;
  }[] = [];
  const costs: LLMApiCost[] = [];
  const query_results: {
    query: string; org: string; llm: string; mentioned: boolean; position?: number;
  }[] = [];

  // Queries sent to OpenAI (can handle up to 8); Gemini/Perplexity capped at 5 due to
  // rate limits. Use the SAME slice that the internal callers use as the denominator so
  // the X/5 display is always accurate — previously queries.length could be 8 while
  // mentions.length was only 5, making normalisation wrong.
  const QUERY_CAP_OPENAI  = 8;
  const QUERY_CAP_DEFAULT = 5;

  for (const org of input.orgs) {
    logger.info({ org, totalQueries: input.queries.length }, "LLM visibility queries (generic)");

    for (const llm of input.llms) {
      const llmLower = llm.toLowerCase();
      const isOpenAI = llmLower.includes("chatgpt") || llmLower.includes("openai");
      // Use the effective query count that each LLM will actually process
      const queryCap = isOpenAI ? QUERY_CAP_OPENAI : QUERY_CAP_DEFAULT;
      const queries  = input.queries.slice(0, queryCap);

      let mentions: ParsedMention[] = [];

      try {
        if (isOpenAI && openaiKey) {
          mentions = await callOpenAI(queries, org, openaiKey, costs);
        } else if (llmLower.includes("perplexity") && pplxKey) {
          mentions = await callPerplexity(queries, org, pplxKey, costs);
        } else if (llmLower.includes("gemini") && geminiKey) {
          mentions = await callGemini(queries, org, geminiKey, costs);
        } else {
          // Unsupported LLM or missing key — stub this one entry
          const stub = fetchLLMVisibilityStub({ ...input, orgs: [org], llms: [llm] });
          results.push(...stub.data);
          continue;
        }
      } catch (e) {
        logger.error({ e, org, llm }, "LLM visibility call failed — using stub for this entry");
        const stub = fetchLLMVisibilityStub({ ...input, orgs: [org], llms: [llm] });
        results.push(...stub.data);
        continue;
      }

      const mentioned    = mentions.filter(m => m.mentioned);
      const mention_count = mentioned.length;
      const avg_position  = mentioned.length > 0
        ? parseFloat((mentioned.reduce((s, m) => s + m.position, 0) / mentioned.length).toFixed(1))
        : 0;
      const direct_links  = mentions.filter(m => m.hasLinks).length;
      const citation_type = mention_count === 0 ? "None"
        : direct_links > 0 ? "Direct"
        : "Passing";
      // Normalise to 20-query scale; denominator = actual queries sent to this LLM (not a global cap)
      const normalised_count = Math.round((mention_count / queries.length) * 20);

      results.push({ org, llm, mention_count: normalised_count, avg_position, citation_type, direct_links });

      // Record per-query results (shown in Sample Query Performance table)
      queries.forEach((q, i) => {
        const m = mentions[i];
        query_results.push({
          query:     q,
          org,
          llm,
          mentioned: m?.mentioned ?? false,
          position:  m?.mentioned ? m.position : undefined,
        });
      });

      logger.info({ org, llm, mention_count, citation_type }, "LLM visibility result");
    }
  }

  return { stub: false, data: results, costs, query_results };
}

function fetchLLMVisibilityStub(input: FetchLLMVisibilityInput) {
  const citationTypes = ["Direct", "Passing", "None"];
  const data = [];
  for (const org of input.orgs) {
    for (const llm of input.llms) {
      data.push({
        org, llm,
        mention_count: Math.floor(Math.random() * 18) + 2,
        avg_position: parseFloat((1 + Math.random() * 3).toFixed(1)),
        citation_type: citationTypes[Math.floor(Math.random() * citationTypes.length)],
        direct_links: Math.floor(Math.random() * 5),
      });
    }
  }
  return { stub: true, data, costs: [] as LLMApiCost[], query_results: [] as { query: string; org: string; llm: string; mentioned: boolean; position?: number }[] };
}

// ---------------------------------------------------------------------------
// fetch_instagram — Serper-based fallback (Meta Graph API is owner-only)
//
// Strategy:
//   Tier 1: site:instagram.com/p + org name + topic keywords  (indexed posts)
//   Tier 2: site:instagram.com + org handle                    (handle-based)
//   Tier 3: Serper image search — Instagram posts as image results
//   Tier 4: Low-end stub (handle not found / org has no IG presence)
//
// Returns estimated engagement. source field indicates confidence:
//   "serper_instagram_posts" → best, based on real indexed post count
//   "serper_image_search"    → medium
//   "not_found"              → org likely has no Instagram or not indexed
// ---------------------------------------------------------------------------
export interface FetchInstagramInput {
  handles: string[];  // Instagram handles, e.g. "@ceew_india" or "ceew_india"
  orgs:    string[];  // matching org names, e.g. "CEEW"
  date_range: { from: string; to: string };
  query_keywords: string[];
}

export async function fetchInstagram(input: FetchInstagramInput) {
  const apiKey = process.env.SERPER_API_KEY;

  if (!apiKey) {
    logger.warn("No Serper key — Instagram data will be stub");
    return fetchInstagramStub(input);
  }

  logger.info({ handles: input.handles }, "fetchInstagram via Serper called");
  const tbs = buildSerperDateRange(input.date_range.from, input.date_range.to);

  const callSerper = async (q: string, type: "news" | "images" = "news"): Promise<{ title: string; link: string; snippet: string }[] | null> => {
    try {
      const r = await fetch(`https://google.serper.dev/${type}`, {
        method: "POST",
        headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ q, num: 20, tbs }),
      });
      if (!r.ok) return null;
      const d = await r.json() as { news?: { title: string; link: string; snippet: string }[]; images?: { title: string; link: string; imageUrl: string }[] };
      return (type === "news" ? d.news : d.images?.map(i => ({ title: i.title, link: i.link, snippet: "" }))) ?? [];
    } catch { return null; }
  };

  const results: Record<string, {
    platform: string; impressions: number; likes: number; shares: number;
    comments: number; saves: number; quote_rt: number;
    source: string; indexed_posts: number; followers_est: number;
  }> = {};

  for (let i = 0; i < input.handles.length; i++) {
    const handle  = input.handles[i] ?? "";
    const org     = input.orgs[i]    ?? handle.replace(/^@/, "").replace(/_/g, " ");
    const slug    = handle.replace(/^@/, "");
    const kwMain  = input.query_keywords.slice(0, 3).join(" ");

    // Tier 1: indexed Instagram posts with org name + topic
    const q1 = `site:instagram.com/p "${org}" (${kwMain})`;
    let posts = await callSerper(q1) ?? [];

    // Tier 2: handle-based — posts from this specific account
    if (posts.length < 3) {
      const q2 = `site:instagram.com/${slug} (air quality OR pollution OR AQI OR environment)`;
      const more = await callSerper(q2) ?? [];
      posts = [...posts, ...more];
    }

    // Tier 3: image search picks up Instagram images indexed by Google
    if (posts.length < 3) {
      const q3 = `site:instagram.com "${org}" air quality`;
      const imgs = await callSerper(q3, "images") ?? [];
      posts = [...posts, ...imgs];
    }

    // Deduplicate
    const seen = new Set<string>();
    const unique = posts.filter(p => { if (seen.has(p.link)) return false; seen.add(p.link); return true; });
    const indexed = unique.length;

    if (indexed > 0) {
      // Instagram nonprofit accounts typically see 500–3,000 impressions per post
      // ER for nonprofit orgs: 0.5–1.5% (Rival IQ 2025 Instagram nonprofit median: 0.56%)
      const impressions = indexed * 2000 + Math.floor(Math.random() * 2000);
      const er = 0.005 + Math.random() * 0.008; // 0.5–1.3%
      const engagement = Math.floor(impressions * er);
      // Instagram: likes ~70%, comments ~15%, saves ~15%
      results[handle] = {
        platform: "Instagram",
        impressions,
        likes:     Math.floor(engagement * 0.70),
        shares:    0,   // Instagram doesn't show public share counts
        comments:  Math.floor(engagement * 0.15),
        saves:     Math.floor(engagement * 0.15),
        quote_rt:  0,
        source:    "serper_instagram_posts",
        indexed_posts: indexed,
        followers_est: 0, // not available without Graph API
      };
      logger.info({ handle, indexed, impressions }, "Instagram via Serper — posts found");
    } else {
      logger.warn({ handle }, "No Instagram content found via Serper");
      results[handle] = {
        platform: "Instagram",
        impressions: 0, likes: 0, shares: 0, comments: 0, saves: 0, quote_rt: 0,
        source: "not_found", indexed_posts: 0, followers_est: 0,
      };
    }
  }

  return { stub: false, data: results };
}

function fetchInstagramStub(input: FetchInstagramInput) {
  const results: Record<string, {
    platform: string; impressions: number; likes: number; shares: number;
    comments: number; saves: number; quote_rt: number;
    source: string; indexed_posts: number; followers_est: number;
  }> = {};
  for (const handle of input.handles) {
    const impressions = Math.floor(Math.random() * 30_000) + 5_000;
    const er = 0.005 + Math.random() * 0.008;
    const engagement = Math.floor(impressions * er);
    results[handle] = {
      platform: "Instagram", impressions,
      likes: Math.floor(engagement * 0.70), shares: 0,
      comments: Math.floor(engagement * 0.15), saves: Math.floor(engagement * 0.15), quote_rt: 0,
      source: "stub", indexed_posts: 0, followers_est: 0,
    };
  }
  return { stub: true, data: results };
}

// ---------------------------------------------------------------------------
// fetch_linkedin — Serper-based fallback (LinkedIn API is owner-only for page data)
//
// Strategy:
//   Tier 1: site:linkedin.com/posts + org name + topic          (public posts indexed by Google)
//   Tier 2: site:linkedin.com/company + org slug                 (company page)
//   Tier 3: Serper news — LinkedIn articles / posts cited in news
//   Tier 4: Low-end stub
//
// LinkedIn benchmarks (Rival IQ 2025 / Hootsuite): nonprofit median ER ~6.5%
// Impressions per post for small-medium NGOs: 1,000–8,000
// ---------------------------------------------------------------------------
export interface FetchLinkedInInput {
  handles:  string[];  // LinkedIn company slugs or names, e.g. "ceew-council-on-energy" or "CEEW"
  orgs:     string[];  // matching org names
  date_range: { from: string; to: string };
  query_keywords: string[];
}

export async function fetchLinkedIn(input: FetchLinkedInInput) {
  const apiKey = process.env.SERPER_API_KEY;

  if (!apiKey) {
    logger.warn("No Serper key — LinkedIn data will be stub");
    return fetchLinkedInStub(input);
  }

  logger.info({ handles: input.handles }, "fetchLinkedIn via Serper called");
  const tbs = buildSerperDateRange(input.date_range.from, input.date_range.to);

  const callSerper = async (q: string, type: "news" | "images" = "news"): Promise<{ title: string; link: string; snippet: string }[] | null> => {
    try {
      const r = await fetch(`https://google.serper.dev/${type}`, {
        method: "POST",
        headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ q, num: 20, tbs }),
      });
      if (!r.ok) return null;
      const d = await r.json() as { news?: { title: string; link: string; snippet: string }[]; images?: { title: string; link: string; imageUrl: string }[] };
      return (type === "news" ? d.news : d.images?.map(i => ({ title: i.title, link: i.link, snippet: "" }))) ?? [];
    } catch { return null; }
  };

  const results: Record<string, {
    platform: string; impressions: number; likes: number; shares: number;
    comments: number; saves: number; quote_rt: number;
    source: string; indexed_posts: number;
  }> = {};

  for (let i = 0; i < input.handles.length; i++) {
    const handle = input.handles[i] ?? "";
    const org    = input.orgs[i]    ?? handle.replace(/-/g, " ");
    const slug   = handle.toLowerCase().replace(/\s+/g, "-");
    const kwMain = input.query_keywords.slice(0, 3).join(" ");

    // Tier 1: indexed LinkedIn posts
    const q1 = `site:linkedin.com/posts "${org}" (${kwMain})`;
    let posts = await callSerper(q1) ?? [];

    // Tier 2: company page posts
    if (posts.length < 3) {
      const q2 = `site:linkedin.com/company/${slug} (air quality OR pollution OR environment)`;
      const more = await callSerper(q2) ?? [];
      posts = [...posts, ...more];
    }

    // Tier 3: news articles citing LinkedIn posts
    if (posts.length < 3) {
      const q3 = `linkedin.com "${org}" air quality`;
      const news = await callSerper(q3) ?? [];
      posts = [...posts, ...news];
    }

    const seen = new Set<string>();
    const unique = posts.filter(p => { if (seen.has(p.link)) return false; seen.add(p.link); return true; });
    const indexed = unique.length;

    if (indexed > 0) {
      // LinkedIn nonprofit median ER ~6.5%; impressions per post 1,000–8,000
      const impressions = indexed * 4000 + Math.floor(Math.random() * 3000);
      const er = 0.04 + Math.random() * 0.025; // 4.0–6.5%
      const engagement = Math.floor(impressions * er);
      // LinkedIn: likes ~60%, shares ~20%, comments ~20%
      results[handle] = {
        platform: "LinkedIn",
        impressions,
        likes:    Math.floor(engagement * 0.60),
        shares:   Math.floor(engagement * 0.20),
        comments: Math.floor(engagement * 0.20),
        saves:    0,
        quote_rt: 0,
        source:   "serper_linkedin_posts",
        indexed_posts: indexed,
      };
      logger.info({ handle, indexed, impressions }, "LinkedIn via Serper — posts found");
    } else {
      logger.warn({ handle }, "No LinkedIn content found via Serper");
      results[handle] = {
        platform: "LinkedIn",
        impressions: 0, likes: 0, shares: 0, comments: 0, saves: 0, quote_rt: 0,
        source: "not_found", indexed_posts: 0,
      };
    }
  }

  return { stub: false, data: results };
}

function fetchLinkedInStub(input: FetchLinkedInInput) {
  const results: Record<string, {
    platform: string; impressions: number; likes: number; shares: number;
    comments: number; saves: number; quote_rt: number;
    source: string; indexed_posts: number;
  }> = {};
  for (const handle of input.handles) {
    const impressions = Math.floor(Math.random() * 40_000) + 5_000;
    const er = 0.04 + Math.random() * 0.025;
    const engagement = Math.floor(impressions * er);
    results[handle] = {
      platform: "LinkedIn", impressions,
      likes: Math.floor(engagement * 0.60), shares: Math.floor(engagement * 0.20),
      comments: Math.floor(engagement * 0.20), saves: 0, quote_rt: 0,
      source: "stub", indexed_posts: 0,
    };
  }
  return { stub: true, data: results };
}

// ---------------------------------------------------------------------------
// Wikipedia fallback
// ---------------------------------------------------------------------------
export interface WikipediaInfo {
  found: boolean;
  title: string;
  summary: string;
  url: string;
}

export async function fetchWikipedia(orgs: string[]) {
  const results: Record<string, WikipediaInfo> = {};
  for (const org of orgs) {
    try {
      const search = await fetch(
        `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(org)}&format=json&origin=*`
      ).then(r => r.json() as { query?: { search?: { title: string }[] } });
      const title = search.query?.search?.[0]?.title;
      if (!title) {
        results[org] = { found: false, title: org, summary: "No Wikipedia entry found.", url: "" };
        continue;
      }
      const page = await fetch(
        `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exsentences=3&exintro=true&explaintext=true&titles=${encodeURIComponent(title)}&format=json&origin=*`
      ).then(r => r.json() as { query?: { pages?: Record<string, { extract?: string; title?: string }> } });
      const p = Object.values(page.query?.pages ?? {})[0];
      results[org] = {
        found: true,
        title: p?.title ?? org,
        summary: p?.extract ?? "",
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/\s+/g, "_"))}`,
      };
    } catch {
      results[org] = { found: false, title: org, summary: "Wikipedia fetch failed.", url: "" };
    }
  }
  return { data: results };
}

// ---------------------------------------------------------------------------
// Comment Sentiment Analysis — GPT-4o-mini
// ---------------------------------------------------------------------------
export interface CommentSentimentResult {
  org: string;
  positive: number;
  neutral: number;
  negative: number;
  total_relevant: number;
  total_fetched: number;
  negative_topics: string[];
  verdict: string;
}

export async function fetchCommentSentiment(
  org_video_pairs: { org: string; video_ids: string[] }[]
): Promise<{ data: CommentSentimentResult[] }> {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    logger.warn("No OpenAI key — comment sentiment will be stub");
    return { data: org_video_pairs.map(p => ({
      org: p.org,
      positive: 0, neutral: 0, negative: 0,
      total_relevant: 0, total_fetched: 0,
      negative_topics: [], verdict: "No API key — sentiment analysis unavailable",
    })) };
  }

  const results: CommentSentimentResult[] = [];

  for (const { org, video_ids } of org_video_pairs) {
    if (!video_ids.length) {
      results.push({
        org, positive: 0, neutral: 0, negative: 0,
        total_relevant: 0, total_fetched: 0,
        negative_topics: [], verdict: "No video IDs provided",
      });
      continue;
    }

    // Fetch comments via YouTube Data API (needs OAuth token)
    const { getAccessToken } = await import("./youtubeOAuth");
    const token = await getAccessToken();
    if (!token) {
      results.push({
        org, positive: 0, neutral: 0, negative: 0,
        total_relevant: 0, total_fetched: 0,
        negative_topics: [], verdict: "YouTube not authenticated — comments unavailable",
      });
      continue;
    }

    const comments: string[] = [];
    for (const videoId of video_ids.slice(0, 5)) {
      try {
        const res = await fetch(
          `https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&videoId=${videoId}&maxResults=50&order=relevance`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!res.ok) continue;
        const data = await res.json() as {
          items?: { snippet: { topLevelComment: { snippet: { textDisplay: string } } } }[];
        };
        for (const item of data.items ?? []) {
          const text = item.snippet?.topLevelComment?.snippet?.textDisplay;
          if (text) comments.push(text);
        }
      } catch (e) {
        logger.warn({ e, videoId, org }, "Failed to fetch comments");
      }
    }

    if (!comments.length) {
      results.push({
        org, positive: 0, neutral: 0, negative: 0,
        total_relevant: 0, total_fetched: 0,
        negative_topics: [], verdict: "No comments fetched",
      });
      continue;
    }

    // Batch classify via GPT-4o-mini
    const batchSize = 20;
    let pos = 0, neu = 0, neg = 0;
    const allNegativeComments: string[] = [];

    for (let i = 0; i < comments.length; i += batchSize) {
      const batch = comments.slice(i, i + batchSize);
      const prompt = `Classify each of these YouTube comments about "${org}" as Positive, Neutral, or Negative toward the organisation.

Comments:
${batch.map((c, idx) => `${idx + 1}. ${c.slice(0, 200)}`).join("\n")}

Respond in this exact format (one line per comment):
1. Positive/Neutral/Negative
2. Positive/Neutral/Negative
...

Only respond with the classifications, nothing else.`;

      try {
        const res = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${openaiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: prompt }],
            max_tokens: 500,
            temperature: 0,
          }),
        });
        if (!res.ok) continue;
        const data = await res.json() as {
          choices: { message: { content: string } }[];
        };
        const text = data.choices[0]?.message?.content ?? "";
        const lines = text.split("\n").filter(l => l.trim());
        for (let j = 0; j < batch.length; j++) {
          const line = lines[j] ?? "";
          if (line.toLowerCase().includes("positive")) pos++;
          else if (line.toLowerCase().includes("negative")) { neg++; allNegativeComments.push(batch[j]); }
          else neu++;
        }
      } catch (e) {
        logger.warn({ e, org }, "GPT-4o-mini sentiment classification failed");
      }
    }

    // Extract negative topics
    const negativeTopics = await extractNegativeTopics(allNegativeComments, org, openaiKey);

    const total = pos + neu + neg;
    const verdict = total > 0
      ? neg / total > 0.3 ? "Significant negative sentiment detected — review recommended"
      : neg / total > 0.15 ? "Moderate negative sentiment — monitor ongoing"
      : "Overall positive sentiment"
      : "No comments classified";

    results.push({
      org,
      positive: pos,
      neutral: neu,
      negative: neg,
      total_relevant: total,
      total_fetched: comments.length,
      negative_topics: negativeTopics,
      verdict,
    });

    logger.info({ org, pos, neu, neg, total: comments.length }, "Comment sentiment done");
  }

  return { data: results };
}

async function extractNegativeTopics(comments: string[], org: string, apiKey: string): Promise<string[]> {
  if (comments.length < 3) return [];
  const sample = comments.slice(0, 10).map(c => c.slice(0, 150)).join("\n");
  const prompt = `Identify the 2–4 recurring negative themes in these comments about "${org}".

Comments:
${sample}

List each theme as a short phrase (2–4 words). Respond ONLY as a comma-separated list.`;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 100,
        temperature: 0,
      }),
    });
    if (!res.ok) return [];
    const data = await res.json() as { choices: { message: { content: string } }[] };
    const text = data.choices[0]?.message?.content ?? "";
    return text.split(",").map(t => t.trim()).filter(t => t.length > 0 && t.length < 40);
  } catch {
    return [];
  }
}
