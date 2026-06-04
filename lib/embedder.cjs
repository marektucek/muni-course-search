// CommonJS wrapper used by the Node.js scripts (scrape.js, embed.js).
// The actual model is still only named here, matching the ESM lib/embedder.js.
const { GoogleGenerativeAI } = require("@google/generative-ai");

const MODEL_NAME = "gemini-embedding-2";

let client = null;

function getClient() {
  if (!client) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY environment variable is not set");
    client = new GoogleGenerativeAI(apiKey);
  }
  return client;
}

async function embedText(text) {
  const genai = getClient();
  const model = genai.getGenerativeModel({ model: MODEL_NAME });
  const result = await model.embedContent(text);
  return result.embedding.values;
}

module.exports = { embedText };
