import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5000,
    host: "0.0.0.0",
    allowedHosts: true,
    proxy: {
      "/conversations": "http://localhost:3001",
      "/health": "http://localhost:3001",
      "/youtube": "http://localhost:3001",
    },
  },
});
