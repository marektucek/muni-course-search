// Visits each course URL and patches the name field in courses_raw.json
// and courses_embedded.json for any course whose name still equals its code.
// Run once after the IS server comes back up:  node scripts/patch-names.js

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const RAW_PATH = path.join(__dirname, "../data/courses_raw.json");
const EMBEDDED_PATH = path.join(__dirname, "../data/courses_embedded.json");
const RATE_LIMIT_MS = 1000;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function extractName(html, code) {
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (!titleMatch) return null;
  let title = titleMatch[1]
    .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&#\d+;/g, "")
    .replace(/-\s*(Filozofická fakulta|FF MU|Masarykova univerzita)[^<]*/i, "")
    .replace(new RegExp(`\\b${code}\\b`, "g"), "")
    .replace(/[()|\-–]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return title || null;
}

function waitForEnter(prompt) {
  return new Promise((resolve) => {
    const readline = require("readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => { rl.close(); resolve(); });
  });
}

async function main() {
  const raw = JSON.parse(fs.readFileSync(RAW_PATH, "utf-8"));
  const needsPatch = raw.filter((c) => !c.name || c.name === c.code);
  console.log(`${needsPatch.length} / ${raw.length} courses need a name patch.`);
  if (needsPatch.length === 0) { console.log("Nothing to do."); return; }

  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);

  await page.goto("about:blank");
  console.log(`\nBrowser open. Navigate to https://is.muni.cz and log in if needed.`);
  await waitForEnter("Press Enter when ready... ");

  const nameMap = {};
  let done = 0;

  for (const course of needsPatch) {
    await sleep(RATE_LIMIT_MS);
    try {
      await page.goto(course.url, { waitUntil: "domcontentloaded" });
      const html = await page.content();
      const name = extractName(html, course.code);
      if (name) {
        nameMap[course.code] = name;
        done++;
        process.stdout.write(`  [${done}/${needsPatch.length}] ${course.code} → ${name}\r`);
      }
    } catch (err) {
      console.error(`\n  Error on ${course.code}: ${err.message}`);
    }
  }

  await browser.close();
  console.log(`\nPatched ${done} names. Saving...`);

  // Apply to raw
  for (const c of raw) {
    if (nameMap[c.code]) c.name = nameMap[c.code];
  }
  fs.writeFileSync(RAW_PATH, JSON.stringify(raw, null, 2));

  // Apply to embedded (if it exists)
  if (fs.existsSync(EMBEDDED_PATH)) {
    const embedded = JSON.parse(fs.readFileSync(EMBEDDED_PATH, "utf-8"));
    for (const c of embedded) {
      if (nameMap[c.code]) c.name = nameMap[c.code];
    }
    fs.writeFileSync(EMBEDDED_PATH, JSON.stringify(embedded, null, 2));
  }

  console.log("Done.");
}

main().catch((e) => { console.error(e); process.exit(1); });
