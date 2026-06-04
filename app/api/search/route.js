import { embedText } from "../../../lib/embedder";
import { getCourses } from "../../../lib/courses";
import { topK } from "../../../lib/similarity";

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
    const courses = getCourses();
    const candidates = topK(queryEmbedding, courses, 15);

    // Strip the embedding vectors from the response — they're large and not needed by the client
    const stripped = candidates.map(({ embedding: _emb, ...rest }) => rest);
    return Response.json({ candidates: stripped });
  } catch (err) {
    console.error("Search error:", err);
    return Response.json({ error: "Search failed" }, { status: 500 });
  }
}
