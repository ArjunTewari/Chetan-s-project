# Emerald AI — Air Quality Media Intelligence Platform

A full-stack agentic platform that generates defensible, data-backed Air Quality Media Intelligence reports for NGOs and research organisations.

## What it does

- **Social Media** — YouTube (via OAuth2, Data API v3) and X/Twitter (via Serper search)
- **Media Coverage** — Serper News API with 5-tier fallback (site-specific → backup outlets → broad web)
- **LLM / AEO Visibility** — Live queries to ChatGPT, Perplexity, Gemini measuring unprompted mentions
- **Comment Sentiment** — GPT-4o-mini classifies YouTube comments per organisation
- **Wikipedia Context** — Auto-fetched when media coverage is thin
- **Report output** — Self-contained HTML report + editable PPTX download
- **Draft review** — User reviews all data before final report is generated

## Stack

| Layer | Technology |
|---|---|
| Agent | Anthropic Claude Sonnet 4, SSE streaming |
| Backend | Node.js, Express, TypeScript, ts-node-dev |
| Frontend | React 18, Vite, TypeScript |
| Data | Serper News API, YouTube Data API v3, OpenAI, Perplexity, Gemini |

## Quick start

### 1. Clone and install
```bash
git clone https://github.com/ArjunTewari/Chetan-s-project.git
cd Chetan-s-project

cd backend && npm install
cd ../frontend && npm install
```

### 2. Configure environment
```bash
cp backend/.env.example backend/.env
# Edit backend/.env and fill in all API keys
```

### 3. Run
```bash
# Terminal 1 — backend
cd backend && npm run dev

# Terminal 2 — frontend
cd frontend && npm run dev
```

Open http://localhost:5173

## YouTube OAuth setup

1. Create OAuth 2.0 credentials at https://console.cloud.google.com/apis/credentials
2. Add `http://localhost:3001/youtube/callback` as an authorised redirect URI
3. Fill in `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REDIRECT_URI` in `.env`
4. Visit http://localhost:3001/youtube/auth to authorise

## API keys needed

See `backend/.env.example` for the full list:
- `ANTHROPIC_API_KEY` — Claude agent
- `SERPER_API_KEY` — Media coverage, X fallback, YouTube fallback
- `OPENAI_API_KEY` — LLM visibility (ChatGPT) + comment sentiment
- `PERPLEXITY_API_KEY` — LLM visibility
- `GEMINI_API_KEY` — LLM visibility
- `YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET` — YouTube OAuth2

## Project structure

```
├── backend/
│   ├── src/
│   │   ├── agent.ts          # Claude agentic loop, tool definitions
│   │   ├── tools.ts          # All data fetching with fallback chains
│   │   ├── calculator.ts     # Pure scoring calculations
│   │   ├── htmlGenerator.ts  # HTML report template
│   │   ├── pptxGenerator.ts  # PPTX report generator
│   │   ├── server.ts         # Express HTTP + SSE server
│   │   └── youtubeOAuth.ts   # YouTube token manager
│   └── .env.example
└── frontend/
    └── src/
        └── App.tsx           # React chat UI
```
