require("dotenv").config({ path: require("path").join(__dirname, "../.env.local") });

const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const { embedText } = require("../lib/embedder.cjs");

const INPUT = path.join(__dirname, "../data/courses_raw.json");
const BATCH_DELAY_MS = 200;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function buildTextForEmbedding(course) {
  return [course.name, course.anotace, course.vystupy, course.temata]
    .filter(Boolean)
    .join(" ");
}

async function main() {
  if (!fs.existsSync(INPUT)) {
    console.error(`Input file not found: ${INPUT}`);
    process.exit(1);
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local");
    process.exit(1);
  }

  const supabase = createClient(url, key);
  const courses = JSON.parse(fs.readFileSync(INPUT, "utf-8"));
  console.log(`Loaded ${courses.length} courses from courses_raw.json`);

  // Fetch already-embedded course keys from Supabase to support resume
  const { data: existing, error: fetchError } = await supabase
    .from("courses")
    .select("code, semester")
    .not("embedding", "is", null);
  if (fetchError) {
    console.error("Failed to fetch existing courses:", fetchError.message);
    process.exit(1);
  }
  const existingKeys = new Set(existing.map((c) => `${c.code}__${c.semester}`));
  console.log(`${existingKeys.size} courses already embedded in Supabase, resuming.`);

  let upserted = 0;
  let skipped = 0;

  for (let i = 0; i < courses.length; i++) {
    const course = courses[i];
    const key = `${course.code}__${course.semester}`;

    if (existingKeys.has(key)) {
      skipped++;
      continue;
    }

    const text = buildTextForEmbedding(course);
    if (!text.trim()) {
      console.warn(`  Skipping ${course.code} — no text to embed`);
      skipped++;
      continue;
    }

    try {
      const embedding = await embedText(text);
      const { error } = await supabase.from("courses").upsert(
        {
          code: course.code,
          semester: course.semester,
          name: course.name,
          faculty: course.faculty,
          credits: course.credits,
          completion: course.completion,
          url: course.url,
          anotace: course.anotace,
          vystupy: course.vystupy,
          temata: course.temata,
          embedding,
        },
        { onConflict: "code,semester" }
      );
      if (error) throw new Error(error.message);
      upserted++;
      process.stdout.write(`  [${i + 1}/${courses.length}] ${course.code}\r`);
    } catch (err) {
      console.error(`\n  Error on ${course.code}: ${err.message}`);
    }

    await sleep(BATCH_DELAY_MS);
  }

  console.log(`\nDone. Upserted: ${upserted}, Skipped: ${skipped}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
