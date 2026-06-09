import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    watch: {
      // im Docker noetig, damit Aenderungen auf dem Host detected werden
      usePolling: true,
    },
  },
});
