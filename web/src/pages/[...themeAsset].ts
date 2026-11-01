import type { APIRoute } from "astro"
import { themeInitializationScript, themeStylesheet } from "../lib/themes.js"

// Static build artifacts, not a runtime API. Keep these under the Go dashboard's
// existing /_astro/ asset allowlist; underscore-named source routes are ignored.
export function getStaticPaths() {
  return [
    { params: { themeAsset: "_astro/themes.css" }, props: { source: themeStylesheet(), contentType: "text/css; charset=utf-8" } },
    { params: { themeAsset: "_astro/theme-init.js" }, props: { source: themeInitializationScript(), contentType: "text/javascript; charset=utf-8" } },
  ]
}

export const GET: APIRoute = ({ props }) => new Response(props.source, {
  headers: { "Content-Type": props.contentType },
})
