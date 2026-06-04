// Scrapes the FF MUNI course catalog for two semesters and extracts
// course metadata + text fields. Output: data/courses_raw.json
//
// Strategy: two-pass per semester.
//   Pass 1 — fast: page through the catalog and collect every unique course URL.
//            The catalog groups courses by study programme, so the same URL
//            appears on many pages; we deduplicate here so Pass 2 visits each
//            detail page exactly once.
//   Pass 2 — slow: visit each detail URL, extract text fields, checkpoint to disk
//            after every 25 courses so a crash loses minimal work.

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const SEMESTERS = ["podzim2026", "jaro2027"];
const BASE_URL = "https://is.muni.cz";
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Returns a random delay that mimics the uneven cadence of a human clicking
// through pages — mostly 1.5–3 s with occasional longer pauses.
function humanDelay() {
  const r = Math.random();
  if (r < 0.10) return 4000 + Math.random() * 4000;  // 10%: 4–8 s (distracted)
  if (r < 0.25) return 2500 + Math.random() * 1500;  // 15%: 2.5–4 s (reading)
  return 1200 + Math.random() * 1300;                 // 75%: 1.2–2.5 s (normal)
}

// Extracts the full text of a section identified by its bold heading label.
//
// IS MUNI course pages use a <dt>/<dd> definition list:
//   <dt><b>Výstupy z učení</b></dt>
//   <dd>"Po absolvování kurzu bude student schopen:"<br>
//       " – aktivně používat..."<br>
//       " – zvládnout..."</dd>
//
// We match the <dt> containing the label, then capture the entire sibling <dd>.
function extractSection(html, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Match <dt>…<b>Label</b>…</dt> followed by <dd>…content…</dd>
  const pattern = new RegExp(
    `<dt[^>]*>[\\s\\S]*?<b[^>]*>\\s*${escaped}[^<]*<\\/b>[\\s\\S]*?<\\/dt>\\s*<dd[^>]*>([\\s\\S]*?)<\\/dd>`,
    "i"
  );

  const match = html.match(pattern);
  if (!match) return "";

  return match[1]
    .replace(/<br\s*\/?>/gi, " ")  // <br> → space so bullet lines stay readable
    .replace(/<[^>]+>/g, " ")      // strip any remaining tags
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

// Extracts the human-readable course name from the page <title>.
// IS MUNI title formats seen in the wild:
//   "CODE Název předmětu - Filozofická fakulta MU"
//   "Název předmětu (CODE) - FF MU"
// We strip the code, faculty suffix, and surrounding punctuation.
function extractName(html, code) {
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (!titleMatch) return code;
  let title = titleMatch[1]
    .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&#\d+;/g, "")
    .replace(/-\s*(Filozofická fakulta|FF MU|Masarykova univerzita)[^<]*/i, "")
    .replace(new RegExp(`\\b${code}\\b`, "g"), "")
    .replace(/[()|\-–]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return title || code;
}

// Parses credits and completion type from the Rozsah <dt>/<dd>, e.g. "2/0/0. 3 kr. Zk."
function parseRozsah(html) {
  const pattern = /<dt[^>]*>[\s\S]*?<b[^>]*>\s*Rozsah[^<]*<\/b>[\s\S]*?<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/i;
  const match = html.match(pattern);
  if (!match) return { credits: "", completion: "" };
  const text = match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const creditsMatch = text.match(/(\d+)\s*kr/i);
  const completionMatch = text.match(/\b(Zk|k|z)\b\.?/i);
  return {
    credits: creditsMatch ? creditsMatch[1] : "",
    completion: completionMatch ? completionMatch[1].toLowerCase() : "",
  };
}

// Extracts the language of instruction from the "Jazyk výuky" <dt>/<dd>.
// Returns a short label (e.g. "angličtina", "němčina") or null for Czech.
function extractLanguage(html) {
  const match = html.match(
    /<dt[^>]*>[\s\S]*?<b[^>]*>\s*Jazyk výuky\s*<\/b>[\s\S]*?<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/i
  );
  if (!match) return null;
  const text = match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  // If the text contains "čeština" or is empty, treat as Czech (no chip needed)
  if (!text || text.includes("čeština") || text.includes("cestina")) return null;
  return text;
}

// Determines whether the course is open to students outside its home programme.
// IS MUNI uses "Omezení zápisu do předmětu" with values like:
//   "Předmět je otevřen i studentům mimo mateřské obory" → open (true)
//   "Předmět je určen pouze studentům mateřských oborů"  → restricted (false)
// Returns true (open), false (restricted), or null (field not found).
function extractOpenAccess(html) {
  const match = html.match(
    /<dt[^>]*>[\s\S]*?<b[^>]*>\s*Omezení zápisu do předmětu\s*<\/b>[\s\S]*?<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/i
  );
  if (!match) return null;
  const text = match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (/mimo mateřské/i.test(text)) return true;
  if (/pouze studentům mateřských/i.test(text) || /pouze.*mateřsk/i.test(text)) return false;
  return null;
}

// Pass 1: page through the catalog and return every unique {code, name, href}.
// Does NOT visit detail pages — only catalog list pages.
async function collectCourseUrls(page, semester) {
  const listUrl = `${BASE_URL}/predmety/?lang=cs;fakulta=1421;obdobi=${semester}`;
  console.log(`\n[Pass 1] Collecting URLs for ${semester}`);

  const seen = new Set();
  const courses = []; // {code, name, href}
  let pageNum = 1;
  let pvysl = null;

  while (true) {
    const url =
      pageNum === 1
        ? listUrl
        : `${BASE_URL}/predmety/?lang=cs;pvysl=${pvysl};fakulta=1421;obdobi=${semester};start=${(pageNum - 1) * 50}`;

    await page.goto(url, { waitUntil: "networkidle" });

    // Grab pvysl from the first page for stable subsequent pagination
    if (pageNum === 1) {
      const hrefs = await page.$$eval("a[href]", (ls) =>
        ls.map((a) => a.getAttribute("href") || "")
      );
      const pvyslHref = hrefs.find((h) => h.includes("pvysl="));
      pvysl = pvyslHref?.match(/pvysl=(\d+)/)?.[1] ?? null;
      console.log(`  pvysl: ${pvysl}`);
    }

    const rows = await page.$$eval("a[href]", (links) =>
      links
        .map((a) => ({ href: a.getAttribute("href") || "", text: a.textContent.trim() }))
        .filter(({ href, text }) => href.includes("/predmet/phil/") && text.length > 0)
        .map(({ href, text }) => ({
          code: href.split("/").filter(Boolean).pop().split(";")[0].split("?")[0],
          name: text,
          href: href.startsWith("http") ? href : `https://is.muni.cz${href}`,
        }))
    );

    // Count new vs already-seen to track how much the catalog repeats itself
    let newOnPage = 0;
    for (const row of rows) {
      if (!seen.has(row.href)) {
        seen.add(row.href);
        courses.push(row);
        newOnPage++;
      }
    }

    process.stdout.write(
      `  Page ${pageNum}: ${rows.length} links, ${newOnPage} new, ${courses.length} unique so far\n`
    );

    // Stop when the page returns no links at all (past the end of the catalog)
    if (rows.length === 0) break;

    // Stop when we get two consecutive pages with zero new courses — the catalog
    // has looped back and is only showing already-seen entries.
    if (newOnPage === 0) {
      // Check one more page to be sure
      pageNum++;
      const nextUrl = `${BASE_URL}/predmety/?lang=cs;pvysl=${pvysl};fakulta=1421;obdobi=${semester};start=${(pageNum - 1) * 50}`;
      await page.goto(nextUrl, { waitUntil: "networkidle" });
      const nextRows = await page.$$eval("a[href]", (links) =>
        links
          .filter((a) => (a.getAttribute("href") || "").includes("/predmet/phil/"))
          .map((a) => a.getAttribute("href") || "")
      );
      const hasNew = nextRows.some((h) => !seen.has(h.startsWith("http") ? h : `https://is.muni.cz${h}`));
      if (!hasNew) {
        console.log(`  No new courses on two consecutive pages — catalog exhausted.`);
        break;
      }
      // There were new ones after all; continue from the page we just loaded
      continue;
    }

    pageNum++;
  }

  console.log(`  Done — ${courses.length} unique course URLs for ${semester}`);
  return courses;
}

// Pass 2: visit each detail URL and extract metadata.
// Skips URLs already present in scrapedUrls. Checkpoints every 25 courses.
async function scrapeDetails(page, semester, courseList, scrapedUrls, allCourses, checkpoint) {
  console.log(`\n[Pass 2] Scraping details for ${semester} (${courseList.length} URLs)`);

  let scraped = 0;
  let skipped = 0;

  for (const row of courseList) {
    if (scrapedUrls.has(row.href)) {
      skipped++;
      continue;
    }

    await sleep(humanDelay());
    try {
      await page.goto(row.href, { waitUntil: "domcontentloaded" });
      const html = await page.content();

      const { credits, completion } = parseRozsah(html);
      const name = extractName(html, row.code);
      const anotace = extractSection(html, "Anotace");
      const vystupy = extractSection(html, "Výstupy z učení");
      const temata = extractSection(html, "Klíčová témata");
      const jazyk = extractLanguage(html);
      const otevreny = extractOpenAccess(html);

      allCourses.push({
        code: row.code,
        name,
        faculty: "Filozofická fakulta",
        credits,
        completion,
        semester,
        url: row.href,
        jazyk,      // language of instruction, null if Czech
        otevreny,   // true = open to all, false = home programme only, null = unknown
        anotace,
        vystupy,
        temata,
      });
      scrapedUrls.add(row.href);
      scraped++;

      process.stdout.write(
        `  [${scraped + skipped}/${courseList.length}] +${row.code} (total saved: ${allCourses.length})\r`
      );

      // Checkpoint every 25 detail pages
      if (scraped % 25 === 0) {
        checkpoint();
        process.stdout.write(`\n  Checkpoint (${allCourses.length} saved)\n`);
      }
    } catch (err) {
      console.error(`\n  Error scraping ${row.href}: ${err.message}`);
    }
  }

  checkpoint();
  console.log(`\n  Done — scraped ${scraped}, skipped ${skipped} (already done)`);
}

// Pauses until the user presses Enter in the terminal.
function waitForEnter(prompt) {
  return new Promise((resolve) => {
    const readline = require("readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => { rl.close(); resolve(); });
  });
}

async function main() {
  const outPath = path.join(__dirname, "../data/courses_raw.json");
  const urlCachePath = path.join(__dirname, "../data/courses_urls.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  // Load previously scraped courses (resume support)
  let allCourses = [];
  if (fs.existsSync(outPath)) {
    allCourses = JSON.parse(fs.readFileSync(outPath, "utf-8"));
    if (allCourses.length > 0)
      console.log(`Resuming — ${allCourses.length} courses already in ${outPath}`);
  }
  const scrapedUrls = new Set(allCourses.map((c) => c.url));

  function checkpoint() {
    fs.writeFileSync(outPath, JSON.stringify(allCourses, null, 2));
  }

  // Run headed so the user can solve any CAPTCHA
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);

  // Open the browser to a blank page — let the user navigate manually so they
  // can handle login, CAPTCHA, or any other gate without a script timeout.
  const targetUrl = `${BASE_URL}/predmety/?lang=cs;fakulta=1421;obdobi=${SEMESTERS[0]}`;
  await page.goto("about:blank");
  console.log("\nBrowser is open.");
  console.log(`Navigate to: ${targetUrl}`);
  console.log("Solve any CAPTCHA and wait until the course list is fully visible.");
  await waitForEnter("Then press Enter here to start scraping... ");

  for (const semester of SEMESTERS) {
    // Pass 1: collect all unique URLs (fast — only catalog pages, no detail visits)
    let courseList;
    const urlCacheKey = `${semester}`;

    // Re-use cached URL list if available so re-runs skip Pass 1 entirely
    const urlCache = fs.existsSync(urlCachePath)
      ? JSON.parse(fs.readFileSync(urlCachePath, "utf-8"))
      : {};

    if (urlCache[urlCacheKey]) {
      console.log(`\nUsing cached URL list for ${semester} (${urlCache[urlCacheKey].length} courses)`);
      courseList = urlCache[urlCacheKey];
    } else {
      courseList = await collectCourseUrls(page, semester);
      urlCache[urlCacheKey] = courseList;
      fs.writeFileSync(urlCachePath, JSON.stringify(urlCache, null, 2));
    }

    // Pass 2: visit each detail page
    await scrapeDetails(page, semester, courseList, scrapedUrls, allCourses, checkpoint);
    console.log(`\nSemester ${semester} complete.`);
  }

  await browser.close();
  checkpoint();
  console.log(`\nAll done. Total saved: ${allCourses.length} courses → ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
