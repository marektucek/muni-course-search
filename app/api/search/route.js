import { embedText } from "../../../lib/embedder";
import { searchCourses } from "../../../lib/courses";

// Converts a Google RetryInfo delay string like "24s" or "150.5s" into
// a human-readable Czech string, e.g. "2 minuty" or "30 sekund".
function formatRetryDelay(raw) {
  if (!raw) return null;
  const seconds = Math.ceil(parseFloat(raw.replace("s", "")));
  if (isNaN(seconds)) return null;
  if (seconds < 60) return `${seconds} sekund`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes === 1) return "1 minutu";
  if (minutes < 5) return `${minutes} minuty`;
  return `${minutes} minut`;
}

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { query } = body;
  if (!query || typeof query !== "string" || !query.trim()) {
    return Response.json({ error: "query is required" }, { status: 400 });
  }

  try {
    const queryEmbedding = await embedText(query.trim());
    const candidates = await searchCourses(queryEmbedding, 15);
    return Response.json({ candidates });
  } catch (err) {
    console.error("Search error:", err);

    // Gemini quota exceeded — extract retry delay and surface it to the client
    if (err?.status === 429) {
      const retryInfo = err?.errorDetails?.find(
        (d) => d["@type"] === "type.googleapis.com/google.rpc.RetryInfo"
      );
      const retryIn = retryInfo ? formatRetryDelay(retryInfo.retryDelay) : null;
      return Response.json({ error: "quota_exceeded", retryIn }, { status: 503 });
    }

    return Response.json({ error: "search_failed" }, { status: 500 });
  }
}
