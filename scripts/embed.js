// Reads courses_raw.json, generates an embedding vector for each course,
// and writes courses_embedded.json with the vector added to each record.
require("dotenv").config({ path: require("path").join(__dirname, "../.env.local") });

const fs = require("fs");
const path = require("path");
const { embedText } = require("../lib/embedder.cjs");

const INPUT = path.join(__dirname, "../data/courses_raw.json");
const OUTPUT = path.join(__dirname, "../data/courses_embedded.json");
const BATCH_DELAY_MS = 200; // stay well within Gemini rate limits

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Concatenates the three text fields into a single string for embedding.
function buildTextForEmbedding(course) {
  return [course.name, course.anotace, course.vystupy, course.temata]
    .filter(Boolean)
    .join(" ");
}

async function main() {
  if (!fs.existsSync(INPUT)) {
    console.error(`Input file not found: ${INPUT}`);
    console.error("Run `npm run scrape` first.");
    process.exit(1);
  }

  const courses = JSON.parse(fs.readFileSync(INPUT, "utf-8"));
  console.log(`Embedding ${courses.length} courses...`);

  // Resume support: skip courses that already have an embedding
  let existing = [];
  if (fs.existsSync(OUTPUT)) {
    existing = JSON.parse(fs.readFileSync(OUTPUT, "utf-8"));
    console.log(`Found ${existing.length} already-embedded courses, resuming.`);
  }
  const existingCodes = new Set(existing.map((c) => `${c.code}__${c.semester}`));

  const results = [...existing];

  for (let i = 0; i < courses.length; i++) {
    const course = courses[i];
    const key = `${course.code}__${course.semester}`;
    if (existingCodes.has(key)) continue;

    const text = buildTextForEmbedding(course);
    if (!text.trim()) {
      console.warn(`  Skipping ${course.code} — no text to embed`);
      results.push({ ...course, embedding: [] });
      continue;
    }

    try {
      const embedding = await embedText(text);
      results.push({ ...course, embedding });
      process.stdout.write(`  [${i + 1}/${courses.length}] ${course.code}\r`);
    } catch (err) {
      console.error(`\n  Error embedding ${course.code}: ${err.message}`);
      results.push({ ...course, embedding: [] });
    }

    // Checkpoint every 50 courses so a crash doesn't lose all progress
    if ((i + 1) % 50 === 0) {
      fs.writeFileSync(OUTPUT, JSON.stringify(results, null, 2));
    }

    await sleep(BATCH_DELAY_MS);
  }

  fs.writeFileSync(OUTPUT, JSON.stringify(results, null, 2));
  console.log(`\nSaved ${results.length} courses to ${OUTPUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
