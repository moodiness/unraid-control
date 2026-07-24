import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg"],
      manifest: {
        name: "Unraid",
        short_name: "Unraid",
        description:
          "A private, self-hosted control center for your Unraid server.",
        theme_color: "#0b0b12",
        background_color: "#08080d",
        display: "standalone",
        display_override: ["window-controls-overlay", "standalone"],
        start_url: "/",
        scope: "/",
        orientation: "any",
        categories: ["utilities", "productivity"],
        icons: [
          {
            src: "/icon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any",
          },
          {
            src: "/icon-maskable.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "maskable",
          },
        ],
        shortcuts: [
          {
            name: "Dashboard",
            short_name: "Dashboard",
            url: "/?view=dashboard",
          },
          { name: "Docker", short_name: "Docker", url: "/?view=docker" },
          { name: "Storage", short_name: "Storage", url: "/?view=storage" },
        ],
      },
      workbox: {
        cleanupOutdatedCaches: true,
        globIgnores: ["**/index.html"],
        navigateFallback: null,
      },
    }),
  ],
  server: {
    host: true,
    port: 5173,
    proxy: {
      "/api": "http://localhost:3001",
      "/health": "http://localhost:3001",
    },
  },
});
