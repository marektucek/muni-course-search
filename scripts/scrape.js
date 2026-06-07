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
// Moves the mouse in a short random arc to mimic natural cursor movement.
// Called before navigating to a new page so the browser's pointer event log
// doesn't look like a script that teleports between coordinates.
async function jitterMouse(page) {
  const steps = 3 + Math.floor(Math.random() * 4);
  const x = 200 + Math.floor(Math.random() * 600);
  const y = 200 + Math.floor(Math.random() * 400);
  await page.mouse.move(x, y, { steps });
}

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

// Pass 1: collect all unique course URLs using the katalog AJAX endpoint.
// POSTs to /predmety/predmety_ajax.pl from inside the browser context so that
// session cookies are inherited automatically — no manual cookie handling.
// Both semesters are fetched in a single session using the combined terms filter.
async function collectCourseUrls(page) {
  console.log(`\n[Pass 1] Collecting course URLs via AJAX endpoint`);

  // Extract pvysl from the current page (katalog embeds it in the HTML)
  const pvysl = await page.evaluate(() => {
    const m = document.documentElement.innerHTML.match(/['"](pvysl)['"]\s*[,:]\s*['"]?(\d+)/);
    if (m) return m[2];
    // Fallback: look in any input or data attribute
    const inp = document.querySelector('input[name="pvysl"]');
    if (inp) return inp.value;
    return null;
  });
  console.log(`  pvysl: ${pvysl}`);

  // Term format used by the katalog: "podzim 2026" and "jaro 2027" (with space)
  const terms = SEMESTERS.map((s) => s.replace(/(\D+)(\d+)/, "$1 $2")); // "podzim2026" → "podzim 2026"

  const seen = new Set();
  const courses = [];

  // Request all results in a single call. The server ignores small records_per_page
  // values and returns ~300 rows anyway, so asking for 99999 gets everything at once
  // and avoids the need for pagination entirely.
  const { html } = await page.evaluate(
      async ({ pvysl, terms }) => {
        const body = new URLSearchParams({
          type: "result",
          operace: "get_courses",
          filters: JSON.stringify({
            offered: ["1"],
            faculties: ["1421"],
            depts_type: ["3"],
            terms,
          }),
          pvysl: pvysl ?? "",
          search_text: "",
          records_per_page: "99999",
          start: "0",
          origin_path_info: "/predmety/katalog",
        });

        const res = await fetch("/predmety/predmety_ajax.pl", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest",
          },
          body: body.toString(),
          credentials: "same-origin",
        });

        return await res.text();
      },
      { pvysl, terms }
  );

  if (!html || html.trim().length === 0) {
    console.log("  Warning: empty response. HTML snippet:", html?.slice(0, 300));
    return courses;
  }

  // Parse all course links out of the single response
  const rows = await page.evaluate((html) => {
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    return Array.from(tmp.querySelectorAll("a[href]"))
      .map((a) => ({ href: a.getAttribute("href") || "", text: a.textContent.trim() }))
      .filter(({ href }) => href.includes("/predmet/"))
      .map(({ href, text }) => ({
        code: href.split("/").filter(Boolean).pop().split(";")[0].split("?")[0],
        name: text,
        href: href.startsWith("http") ? href : `https://is.muni.cz${href}`,
      }));
  }, html);

  console.log(`  Server returned ${rows.length} course rows`);

  for (const row of rows) {
    if (!seen.has(row.href)) {
      seen.add(row.href);
      courses.push(row);
    }
  }

  console.log(`  Done — ${courses.length} unique course URLs`);
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
    await jitterMouse(page);
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

  // Run headed so the user can solve any CAPTCHA.
  // Launch flags strip Chromium's automation fingerprints.
  // Use the real installed Chrome instead of Playwright's bundled Chromium.
  // This bypasses TLS/HTTP2 fingerprint detection that flags Playwright's binary.
  const browser = await chromium.launch({
    headless: false,
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
      "--no-sandbox",
    ],
  });

  // Randomise viewport slightly so every session looks different
  const viewportWidth  = 1280 + Math.floor(Math.random() * 200);
  const viewportHeight = 900  + Math.floor(Math.random() * 120);

  const context = await browser.newContext({
    viewport: { width: viewportWidth, height: viewportHeight },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/124.0.0.0 Safari/537.36",
    locale: "cs-CZ",
    timezoneId: "Europe/Prague",
    extraHTTPHeaders: {
      "Accept-Language": "cs-CZ,cs;q=0.9,en;q=0.8",
      "Accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    },
  });

  // Patch JS properties that fingerprint automation even after the launch flags
  await context.addInitScript(() => {
    // Remove webdriver flag
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    // Spoof plugins list (empty in headless, populated in real Chrome)
    Object.defineProperty(navigator, "plugins", {
      get: () => [1, 2, 3, 4, 5], // non-zero length is enough
    });
    // Spoof language
    Object.defineProperty(navigator, "languages", {
      get: () => ["cs-CZ", "cs", "en-US", "en"],
    });
    // Remove the automation-specific chrome.runtime property pattern
    window.chrome = { runtime: {} };
  });

  const page = await context.newPage();
  page.setDefaultTimeout(60000);

  // Send the user to the katalog page — this is where the AJAX endpoint lives
  // and where the pvysl session token is generated.
  await page.goto("about:blank");
  console.log("\nBrowser is open.");
  console.log(`Navigate to: ${BASE_URL}/predmety/katalog`);
  console.log("Solve any CAPTCHA, apply the FF faculty filter for both semesters,");
  console.log("and wait until the course list is fully visible.");
  await waitForEnter("Then press Enter here to start scraping... ");

  // Pass 1: collect all unique URLs for both semesters in one AJAX session
  let courseList;
  const urlCache = fs.existsSync(urlCachePath)
    ? JSON.parse(fs.readFileSync(urlCachePath, "utf-8"))
    : {};

  if (urlCache["all"]) {
    console.log(`\nUsing cached URL list (${urlCache["all"].length} courses)`);
    courseList = urlCache["all"];
  } else {
    courseList = await collectCourseUrls(page);
    urlCache["all"] = courseList;
    fs.writeFileSync(urlCachePath, JSON.stringify(urlCache, null, 2));
  }

  // Pass 2: visit each detail page — assign semester from SEMESTERS based on
  // which term IS links the detail to (encoded in the URL path).
  for (const semester of SEMESTERS) {
    // Filter courseList to those whose URL contains this semester (e.g. podzim2026)
    const semesterList = courseList.filter((c) => c.href.includes(semester));
    console.log(`\nSemester ${semester}: ${semesterList.length} courses`);
    await scrapeDetails(page, semester, semesterList, scrapedUrls, allCourses, checkpoint);
    console.log(`\nSemester ${semester} complete.`);
  }

  // Also scrape any courses whose URL doesn't match either semester (edge cases)
  const matchedUrls = new Set(SEMESTERS.flatMap((s) => courseList.filter((c) => c.href.includes(s)).map((c) => c.href)));
  const unmatched = courseList.filter((c) => !matchedUrls.has(c.href));
  if (unmatched.length > 0) {
    console.log(`\nScraping ${unmatched.length} unmatched-semester courses...`);
    await scrapeDetails(page, "unknown", unmatched, scrapedUrls, allCourses, checkpoint);
  }

  await context.close();
  await browser.close();
  checkpoint();
  console.log(`\nAll done. Total saved: ${allCourses.length} courses → ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
