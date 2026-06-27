import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
export default defineConfig({
    plugins: [react()],
    test: {
        environment: "node",
        include: ["src/**/*.test.{ts,tsx}"],
    },
    server: {
        port: 5173,
        host: true,
        watch: {
            // im Docker noetig, damit Aenderungen auf dem Host detected werden
            usePolling: true,
        },
        proxy: {
            "/api": {
                target: "http://backend:8000",
                changeOrigin: true,
            },
        },
    },
});
