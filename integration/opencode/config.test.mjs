import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const generator = fileURLToPath(new URL("./config.mjs", import.meta.url))

function generate(directory, environment = {}) {
  return JSON.parse(execFileSync(process.execPath, [generator], {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: directory,
      XDG_CONFIG_HOME: "",
      DELTARELAY_LOCAL_TOKEN_FILE: "",
      ...environment,
    },
  }))
}

test("generates checkout-relative plugin and home-relative token paths from any working directory", () => {
  const directory = mkdtempSync(join(tmpdir(), "deltarelay config-"))
  try {
    const config = generate(directory)
    assert.deepEqual(config, {
      $schema: "https://opencode.ai/config.json",
      plugins: [{
        package: dirname(generator),
        options: {
          gateway: "http://127.0.0.1:8788",
          localTokenFile: join(directory, ".config", "deltarelay", "local.token"),
          providers: ["openai", "opencode-go"],
          headerTimeout: 14400000,
        },
      }],
    })
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("uses XDG_CONFIG_HOME for the token location", () => {
  const directory = mkdtempSync(join(tmpdir(), "deltarelay config-"))
  try {
    const configHome = join(directory, "custom config")
    const config = generate(directory, { XDG_CONFIG_HOME: configHome })
    assert.equal(config.plugins[0].options.localTokenFile, join(configHome, "deltarelay", "local.token"))
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("an explicit token file overrides XDG defaults and resolves relative paths", () => {
  const directory = mkdtempSync(join(tmpdir(), "deltarelay config-"))
  try {
    for (const tokenFile of [join(directory, "private token"), "relative token"]) {
      const config = generate(directory, {
        XDG_CONFIG_HOME: join(directory, "unused"),
        DELTARELAY_LOCAL_TOKEN_FILE: tokenFile,
      })
      assert.equal(config.plugins[0].options.localTokenFile, resolve(directory, tokenFile))
    }
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
