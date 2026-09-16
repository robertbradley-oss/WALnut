import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  ...(mode === "replay"
    ? {
        publicDir: false,
        define: { "process.env.NODE_ENV": JSON.stringify("production") },
        build: {
          outDir: "work/replay-build",
          lib: {
            entry: "src/replay-main.tsx",
            name: "WALnutReplay",
            formats: ["iife" as const],
            fileName: () => "replay.js",
            cssFileName: "replay",
          },
          cssCodeSplit: false,
        },
      }
    : {}),
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: { "/api": { target: "http://127.0.0.1:7878", changeOrigin: true } },
  },
}));
