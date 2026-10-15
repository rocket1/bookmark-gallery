// Assembles store-ready builds in dist/<browser>: only the files the extension
// runs (background.js, pages/, icons/) plus that browser's manifest. Nothing
// else from the repo (CLAUDE.md, scripts, editor config, …) ever ships.
//
//   node scripts/build.mjs chrome            build dist/chrome
//   node scripts/build.mjs chrome --watch    …and rebuild on every change
//   node scripts/build.mjs --zip             build both, lint Firefox, zip into artifacts/
//
// No dependencies; --zip runs web-ext (pinned below) through npx.
import { cpSync, rmSync, mkdirSync, readFileSync, watch } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const WEB_EXT = "web-ext@10.7.0";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCES = ["background.js", "pages", "icons"];
const MANIFESTS = { firefox: "manifest.json", chrome: "manifest.chrome.json" };

const args = process.argv.slice(2);
const zip = args.includes("--zip");
const targets = args.filter((a) => !a.startsWith("--"));
const browsers = targets.length ? targets : Object.keys(MANIFESTS);
for (const b of browsers) {
  if (!MANIFESTS[b]) {
    console.error(`Unknown browser "${b}" — use ${Object.keys(MANIFESTS).join(" / ")}`);
    process.exit(1);
  }
}

const versionOf = (file) => JSON.parse(readFileSync(join(root, file), "utf8")).version;

function build(browser) {
  const out = join(root, "dist", browser);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const src of SOURCES) {
    cpSync(join(root, src), join(out, src), { recursive: true, filter: (p) => !p.endsWith(".DS_Store") && !p.endsWith(".md") });
  }
  cpSync(join(root, MANIFESTS[browser]), join(out, "manifest.json"));
  console.log(`[${new Date().toLocaleTimeString()}] Built dist/${browser}`);
  return out;
}

function webExt(...webExtArgs) {
  execFileSync("npx", ["--yes", WEB_EXT, ...webExtArgs], { cwd: root, stdio: "inherit" });
}

if (zip) {
  // Both stores get the same release, so the manifests must agree.
  const versions = new Set(Object.values(MANIFESTS).map(versionOf));
  if (versions.size !== 1) {
    console.error(`Version mismatch between manifests: ${[...versions].join(" vs ")} — bump both.`);
    process.exit(1);
  }
  const [version] = versions;
  for (const browser of browsers) {
    const out = build(browser);
    if (browser === "firefox") webExt("lint", "--source-dir", out);
    webExt("build", "--source-dir", out, "--artifacts-dir", join(root, "artifacts"),
      "--filename", `bookmark-gallery-${browser}-${version}.zip`, "--overwrite-dest");
  }
} else {
  browsers.forEach(build);
}

if (args.includes("--watch")) {
  let timer = null;
  for (const src of [...SOURCES, ...browsers.map((b) => MANIFESTS[b])]) {
    watch(join(root, src), { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => browsers.forEach(build), 150);
    });
  }
  console.log("Watching for changes — Ctrl+C to stop.");
}
