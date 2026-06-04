import { GoogleGenerativeAI } from "@google/generative-ai";

const MODEL = "gemini-3.5-flash";

function getModel() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY environment variable is not set");
  const genai = new GoogleGenerativeAI(apiKey);
  return genai.getGenerativeModel({ model: MODEL });
}

function buildPrompt(query, candidates) {
  const courseList = candidates
    .map(
      (c, i) =>
        `[${i + 1}] Code: ${c.code} | Name: ${c.name} | Credits: ${c.credits} | Completion: ${c.completion}
Annotation: ${(c.anotace || "").slice(0, 400)}
Learning outcomes: ${(c.vystupy || "").slice(0, 300)}
Topics: ${(c.temata || "").slice(0, 200)}`
    )
    .join("\n\n");

  return `You are an academic advisor at Masaryk University's Faculty of Arts (Filozofická fakulta).
A student has described their learning goal in Czech. From the candidate courses below, select the 5 best matches.

Student goal: "${query}"

Candidate courses:
${courseList}

Respond with valid JSON only — no markdown fences, no extra text. The JSON must be an array of exactly 5 objects, each with these fields:
- "code": course code string
- "reasoning": one concise sentence in Czech (max 20 words) naming the specific overlap between the course and the student's goal

Sort by best match first.`;
}

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { query, candidates } = body;
  if (!query || !Array.isArray(candidates) || candidates.length === 0) {
    return Response.json({ error: "query and candidates are required" }, { status: 400 });
  }

  try {
    const model = getModel();
    const prompt = buildPrompt(query, candidates);
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();

    let recommendations;
    try {
      recommendations = JSON.parse(text);
    } catch {
      // Gemini occasionally wraps JSON in markdown — strip fences if present
      const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
      recommendations = JSON.parse(cleaned);
    }

    // Attach full course metadata back to each recommendation,
    // then sort by cosine similarity score so the closest match is always first.
    const byCode = Object.fromEntries(candidates.map((c) => [c.code, c]));
    const enriched = recommendations
      .map((rec) => ({ ...byCode[rec.code], reasoning: rec.reasoning }))
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

    return Response.json({ recommendations: enriched });
  } catch (err) {
    console.error("Recommend error:", err);
    return Response.json({ error: "Recommendation failed" }, { status: 500 });
  }
}
