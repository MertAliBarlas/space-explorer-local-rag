/**
 * Document chunking utility.
 * Splits markdown documents into overlapping chunks suitable for RAG retrieval.
 */

/**
 * Parse front-matter (YAML-like) from a markdown document.
 */
export function parseFrontMatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: text };

  const meta = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return { meta, body: match[2] };
}

/**
 * Split text into chunks of approximately `maxTokens` tokens
 * with `overlapTokens` overlap between consecutive chunks.
 * Uses whitespace-based token approximation (good enough for local RAG).
 */
export function chunkText(text, maxTokens = 400, overlapTokens = 50) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= maxTokens) return [text];

  const chunks = [];
  let start = 0;
  while (start < words.length) {
    const end = Math.min(start + maxTokens, words.length);
    chunks.push(words.slice(start, end).join(" "));
    if (end >= words.length) break;
    start = end - overlapTokens;
  }
  return chunks;
}



/**
 * Compute cosine similarity between two float arrays (embeddings).
 */
export function cosineSimilarity(a, b) {
  if (a.length !== b.length) return 0;
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
 * Calculate term frequencies (TF) for a given text.
 */
export function termFrequency(text) {
  const map = new Map();
  const words = text.toLowerCase().match(/\w+/g) || [];
  for (const w of words) {
    map.set(w, (map.get(w) || 0) + 1);
  }
  return map;
}

/**
 * Compute cosine similarity between two term frequency maps.
 */
export function cosineSimilarityTf(tfA, tfB) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [term, freq] of tfA.entries()) {
    if (tfB.has(term)) dot += freq * tfB.get(term);
    normA += freq * freq;
  }
  for (const freq of tfB.values()) normB += freq * freq;
  
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
