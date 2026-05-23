import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  // Assets served under /_app/ — keeps the SPA namespace separate from API routes
  base: "/_app/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Shared data shipped to both server and web. Single source of truth
      // lives under ../src/services so cron-parser + TimezoneService keep
      // using it directly; web imports the same file via this alias.
      "@shared/timezones-data": path.resolve(__dirname, "../src/services/timezones-data.ts"),
    },
  },
  build: {
    outDir: "dist",
    rollupOptions: {
      output: {
        // Split heavy, independently-cacheable vendor bundles out of the
        // critical `index-*.js` chunk. Each dependency here is either:
        //   • large (viem, lightweight-charts, streamdown/shiki),
        //   • or stable across app releases (react/react-dom/router).
        // Isolating them lets the browser parallelize downloads and keeps
        // long-term HTTP cache hits high — app code changes no longer
        // invalidate vendor chunks.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          // viem is only pulled in by the wallet surface (sidebar portfolio
          // widget + wallet manager). Splitting it keeps ≈ 45 kB gzipped
          // out of the critical chunk and lets it load in parallel.
          if (id.includes("/viem/") || id.includes("\\viem\\")) return "vendor-viem";
          // lightweight-charts — charts appear on Dashboard + WatchlistWidget
          // but never block first paint of "/" (chat). Isolate to its own
          // cacheable chunk.
          if (id.includes("lightweight-charts")) return "vendor-charts";
          // React + router + scheduler rarely change across app releases.
          // Keeping them in a stable chunk maximises HTTP-cache hits across
          // app deploys.
          if (
            id.includes("/react/") ||
            id.includes("/react-dom/") ||
            id.includes("/react-router") ||
            id.includes("/scheduler/")
          ) return "vendor-react";
          // Intentionally DO NOT split shiki / streamdown here: shiki ships
          // per-language dynamic imports, so lumping it into one manual
          // chunk would undo that and produce a ~10 MB file. Letting Rollup
          // emit natural chunks preserves the per-grammar lazy loading.
          return undefined;
        },
      },
    },
  },
  server: {
    proxy: {
      "/api": { target: "http://localhost:15401", changeOrigin: true },
      "/ws":  { target: "ws://localhost:15401", ws: true },
      "/pair":   { target: "http://localhost:15401", changeOrigin: true },
      "/health": { target: "http://localhost:15401", changeOrigin: true },
    },
  },
});
