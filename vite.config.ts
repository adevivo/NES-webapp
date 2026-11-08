import { resolve } from "node:path";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  build: {
    rolldownOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        play: resolve(import.meta.dirname, "play.html"),
        activity: resolve(import.meta.dirname, "activity.html"),
      },
    },
  },
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg"],
      manifest: {
        name: "8-Bit Shelf",
        short_name: "8-Bit Shelf",
        description: "Play NES homebrew and your own ROMs in the browser.",
        theme_color: "#16161d",
        background_color: "#16161d",
        display: "standalone",
        start_url: ".",
        icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
      },
      workbox: {
        // Precache the app shell AND the emulator runtime + NES core so the app
        // works offline right after install, not just after the first game.
        globPatterns: ["**/*.{js,css,html,svg,json,wasm,data}"],
        globIgnores: ["homebrew/**"],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        // play.html?id=... must match the precached play.html
        ignoreURLParametersMatching: [/.*/],
        navigateFallback: null,
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.includes("/homebrew/"),
            handler: "StaleWhileRevalidate",
            options: { cacheName: "homebrew" },
          },
        ],
      },
    }),
  ],
});
