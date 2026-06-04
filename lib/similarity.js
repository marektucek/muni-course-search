// Pure cosine similarity utilities — no external dependencies.

/**
 * Computes cosine similarity between two equal-length vectors.
 * Returns a value in [-1, 1]; higher means more similar.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
export function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Returns the top-k courses sorted by cosine similarity to queryEmbedding.
 * @param {number[]} queryEmbedding
 * @param {Array<{embedding: number[], [key: string]: any}>} courses
 * @param {number} k
 * @returns {Array<{score: number, [key: string]: any}>}
 */
export function topK(queryEmbedding, courses, k) {
  return courses
    .filter((c) => c.embedding && c.embedding.length > 0)
    .map((c) => ({ ...c, score: cosineSimilarity(queryEmbedding, c.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
