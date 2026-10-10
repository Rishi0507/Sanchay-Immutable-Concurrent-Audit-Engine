import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The UI calls the MCP server's HTTP gateway. In development the calls are
// proxied so the browser sees one origin.
const target = process.env.API_TARGET || "http://localhost:8080";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target, changeOrigin: true },
      "/healthz": { target, changeOrigin: true },
    },
  },
});
