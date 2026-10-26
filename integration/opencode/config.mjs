// Print a config fragment for this checkout. No configuration or token is read
// or written; merge the plugin entry into your existing OpenCode configuration.
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
const localTokenFile = process.env.DELTARELAY_LOCAL_TOKEN_FILE || join(configHome, "deltarelay", "local.token")

console.log(JSON.stringify({
  $schema: "https://opencode.ai/config.json",
  plugins: [{
    package: dirname(fileURLToPath(import.meta.url)),
    options: {
      gateway: "http://127.0.0.1:8788",
      localTokenFile: resolve(localTokenFile),
      providers: ["openai", "opencode-go"],
      headerTimeout: 14400000,
    },
  }],
}, null, 2))
