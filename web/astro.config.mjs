import { defineConfig } from "astro/config"

// Static output is served by the Go dashboard command. No Node adapter or UI
// framework is needed, and the browser never receives a gateway token.
export default defineConfig({
  output: "static",
  devToolbar: { enabled: false },
  vite: {
    // The Go dashboard allows only same-origin external scripts. Astro would
    // otherwise inline small bundles (including the theme picker) by default.
    build: { assetsInlineLimit: 0 },
    server: {
      proxy: {
        "/api/dashboard": "http://127.0.0.1:8790",
        "/api/inspection": "http://127.0.0.1:8790",
        "/api/opencode": "http://127.0.0.1:8790",
        "/api/system": "http://127.0.0.1:8790",
      },
    },
  },
})
