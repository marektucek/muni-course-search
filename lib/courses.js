// Loads the embedded course data from disk once and caches it in memory.
// In production (Vercel) the JSON is read at request time from the bundled file system.
import fs from "fs";
import path from "path";

let cache = null;

export function getCourses() {
  if (cache) return cache;
  const filePath = path.join(process.cwd(), "data", "courses_embedded.json");
  if (!fs.existsSync(filePath)) {
    throw new Error(
      "courses_embedded.json not found — run `npm run scrape` then `npm run embed`"
    );
  }
  cache = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  return cache;
}
