// youtubeOAuth.ts — OAuth2 token manager for YouTube Data/Analytics API
import { config } from "dotenv";
import path from "path";
import fs from "fs";
config({ path: path.resolve(__dirname, "../.env"), override: true });
import { logger } from "./logger";

const CLIENT_ID     = process.env.YOUTUBE_CLIENT_ID     ?? "";
const CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET ?? "";
const REDIRECT_URI  = process.env.YOUTUBE_REDIRECT_URI  ?? "http://localhost:3001/youtube/callback";
const TOKEN_FILE    = path.resolve(__dirname, "../youtube-tokens.json");

interface TokenStore {
  access_token:  string;
  refresh_token: string;
  expiry_ms:     number; // unix ms
}

let mem: TokenStore | null = null;

// ── Persist / restore ────────────────────────────────────────────────────────

function load(): void {
  if (mem) return;
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      mem = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8")) as TokenStore;
      logger.info("YouTube tokens loaded from disk");
    }
  } catch { /* ignore */ }
}

function save(t: TokenStore): void {
  mem = t;
  try { fs.writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 2)); } catch { /* ignore */ }
}

// ── Auth URL ─────────────────────────────────────────────────────────────────

export function getAuthUrl(): string {
  const scopes = [
    "https://www.googleapis.com/auth/youtube.readonly",
    "https://www.googleapis.com/auth/yt-analytics.readonly",
  ];
  const params = new URLSearchParams({
    client_id:     CLIENT_ID,
    redirect_uri:  REDIRECT_URI,
    response_type: "code",
    scope:         scopes.join(" "),
    access_type:   "offline",
    prompt:        "consent",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

// ── Exchange code → tokens ───────────────────────────────────────────────────

export async function exchangeCode(code: string): Promise<void> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    new URLSearchParams({
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      redirect_uri:  REDIRECT_URI,
      grant_type:    "authorization_code",
    }),
  });
  const data = await res.json() as {
    access_token?: string; refresh_token?: string;
    expires_in?: number; error?: string;
  };
  if (!data.access_token) throw new Error(`YouTube token exchange failed: ${JSON.stringify(data)}`);
  save({
    access_token:  data.access_token,
    refresh_token: data.refresh_token ?? mem?.refresh_token ?? "",
    expiry_ms:     Date.now() + ((data.expires_in ?? 3600) - 60) * 1000,
  });
  logger.info("YouTube tokens saved");
}

// ── Get a valid access token (refreshes if expired) ──────────────────────────

export async function getAccessToken(): Promise<string | null> {
  load();
  if (!mem) return null;
  if (Date.now() < mem.expiry_ms) return mem.access_token;

  // Refresh
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    new URLSearchParams({
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: mem.refresh_token,
      grant_type:    "refresh_token",
    }),
  });
  const data = await res.json() as {
    access_token?: string; expires_in?: number; error?: string;
  };
  if (!data.access_token) {
    logger.error({ data }, "YouTube token refresh failed");
    return null;
  }
  save({ ...mem, access_token: data.access_token, expiry_ms: Date.now() + ((data.expires_in ?? 3600) - 60) * 1000 });
  return data.access_token;
}

export function isAuthorized(): boolean {
  load();
  return mem !== null && mem.refresh_token !== "";
}
