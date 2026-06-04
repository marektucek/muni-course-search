// Manual smoke test for the embedding + search pipeline.
// Runs two queries:
//   1. Tailored — written to closely match a known course (AR_AK03, digital archivnictví).
//      Pass = that course appears in the top 5.
//   2. Blind — a plausible student goal with no known target.
//      We just print the results and eyeball them.
//
// Usage:  node scripts/test-search.js

require("dotenv").config({ path: require("path").join(__dirname, "../.env.local") });

const { embedText } = require("../lib/embedder.cjs");
const { topK } = require("../lib/similarity.cjs");
const courses = require("../data/courses_embedded.json");

const embedded = courses.filter((c) => c.embedding?.length > 0);
console.log(`Loaded ${embedded.length} embedded courses.\n`);

function printResults(results) {
  results.forEach((c, i) => {
    const score = (c.score * 100).toFixed(1);
    const preview = (c.anotace || "(no annotation)").slice(0, 100);
    console.log(`  ${i + 1}. [${score}%] ${c.code}  ${c.name !== c.code ? "— " + c.name : ""}`);
    console.log(`     ${preview}`);
  });
}

async function runTest(label, query, targetCode) {
  console.log(`${"─".repeat(60)}`);
  console.log(`TEST: ${label}`);
  console.log(`Query: "${query}"`);
  if (targetCode) console.log(`Expected in top 5: ${targetCode}`);
  console.log();

  const vec = await embedText(query);
  const results = topK(vec, embedded, 5);
  printResults(results);

  if (targetCode) {
    const hit = results.some((c) => c.code === targetCode);
    console.log(`\nResult: ${hit ? "✓ PASS" : "✗ FAIL"} — ${targetCode} ${hit ? "found" : "not found"} in top 5`);
  }
  console.log();
}

async function main() {
  // 1. Tailored query — should surface AR_AK03 (digitální archivnictví)
  await runTest(
    "Tailored — digital archives",
    "Zajímá mě správa digitálních dokumentů, digital-born archivnictví a péče o elektronické záznamy",
    "AR_AK03"
  );

  // 2. Blind query — plausible student goal, no known target
  await runTest(
    "Blind — literary theory",
    "Chci porozumět teoriím literatury a metodám literární analýzy textu"
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
