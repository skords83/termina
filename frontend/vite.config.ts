import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "API_");
  const target = env.API_PROXY_TARGET || "http://127.0.0.1:8000";
  return {
  plugins: [react()],
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
  server: {
    port: 5173,
    host: "127.0.0.1",
    watch: {
      // im Docker noetig, damit Aenderungen auf dem Host detected werden
      usePolling: true,
    },
    proxy: {
      "/public": { target, changeOrigin: true },
      "/healthz": { target, changeOrigin: true },
      "/api": {
        target,
        changeOrigin: true,
      },
    },
  },
  };
});
