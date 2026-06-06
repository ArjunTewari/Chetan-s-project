---
name: Replit API routing
description: How to configure API_BASE so fetch calls work in Replit's browser proxy environment
---

Use `API_BASE = ""` (empty string) so all fetch calls use relative URLs (e.g. `/conversations/1/chat`).
Vite's proxy then forwards them to the backend on localhost:3001.

**Why:** Replit serves the frontend through a proxied iframe. The browser cannot reach `http://localhost:3001` directly — absolute localhost URLs fail with "Failed to fetch". Only relative URLs routed through Vite's dev-server proxy work.

**How to apply:** Any new API call must use a relative path. The Vite proxy config (`vite.config.ts`) must include the path prefix. PPTX download links and OAuth popup URLs follow the same rule.
