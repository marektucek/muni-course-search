// Single source of truth for the embedding model.
// Swap the model name here to change the embedding backend everywhere.
import { GoogleGenerativeAI } from "@google/generative-ai";

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

/**
 * Returns a dense embedding vector for the given text string.
 * @param {string} text
 * @returns {Promise<number[]>}
 */
export async function embedText(text) {
  const genai = getClient();
  const model = genai.getGenerativeModel({ model: MODEL_NAME });
  const result = await model.embedContent(text);
  return result.embedding.values;
}
