import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseFrontMatter,
  chunkText,
  termFrequency,
  cosineSimilarityTf,
} from "../src/chunker.js";

// ── parseFrontMatter ──

describe("parseFrontMatter", () => {
  it("parses YAML front-matter and returns meta + body", () => {
    const input = `---
title: Apollo 11 Mission
category: History
id: DOC-AP-011
---

# Apollo 11 Mission

The first moon landing.`;

    const { meta, body } = parseFrontMatter(input);
    assert.equal(meta.title, "Apollo 11 Mission");
    assert.equal(meta.category, "History");
    assert.equal(meta.id, "DOC-AP-011");
    assert.ok(body.includes("# Apollo 11 Mission"));
    assert.ok(body.includes("The first"));
  });

  it("returns empty meta and full text when no front-matter", () => {
    const input = "# Just a heading\n\nSome body text.";
    const { meta, body } = parseFrontMatter(input);
    assert.deepEqual(meta, {});
    assert.equal(body, input);
  });

  it("handles front-matter with colons in values", () => {
    const input = `---
title: Planets: Mars and Venus
category: Astronomy
---

Body text.`;
    const { meta, body } = parseFrontMatter(input);
    assert.equal(meta.title, "Planets: Mars and Venus");
    assert.ok(body.includes("Body text."));
  });
});

// ── chunkText ──

describe("chunkText", () => {
  it("returns single chunk when text is shorter than maxTokens", () => {
    const text = "short document with few words";
    const chunks = chunkText(text, 400, 50);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0], text);
  });

  it("splits long text into overlapping chunks", () => {
    const words = Array.from({ length: 100 }, (_, i) => `word${i}`);
    const text = words.join(" ");
    const chunks = chunkText(text, 30, 5);

    assert.ok(chunks.length > 1, "should produce multiple chunks");
    // Each chunk (except possibly last) should have ≤ maxTokens words
    for (const chunk of chunks) {
      assert.ok(chunk.split(/\s+/).length <= 30);
    }
  });

  it("maintains overlap between consecutive chunks", () => {
    const words = Array.from({ length: 60 }, (_, i) => `w${i}`);
    const text = words.join(" ");
    const chunks = chunkText(text, 20, 5);

    // Last 5 words of chunk 0 should appear at start of chunk 1
    const chunk0Words = chunks[0].split(/\s+/);
    const chunk1Words = chunks[1].split(/\s+/);
    const overlap = chunk0Words.slice(-5);
    const start1 = chunk1Words.slice(0, 5);
    assert.deepEqual(overlap, start1);
  });

  it("handles empty or whitespace-only text", () => {
    const chunks = chunkText("   ", 400, 50);
    assert.equal(chunks.length, 1);
  });
});

// ── termFrequency ──

describe("termFrequency", () => {
  it("counts term frequency correctly", () => {
    const tf = termFrequency("mars mars space space space rocket");
    assert.equal(tf.get("mars"), 2);
    assert.equal(tf.get("space"), 3);
    assert.equal(tf.get("rocket"), 1);
  });

  it("lowercases all terms", () => {
    const tf = termFrequency("Mars MARS mars");
    assert.equal(tf.get("mars"), 3);
    assert.equal(tf.has("Mars"), false);
  });

  it("includes single-character tokens", () => {
    const tf = termFrequency("a b mars c space");
    assert.equal(tf.has("a"), true);
    assert.equal(tf.has("b"), true);
    assert.equal(tf.get("mars"), 1);
  });

  it("returns empty map for empty input", () => {
    const tf = termFrequency("");
    assert.equal(tf.size, 0);
  });
});

// ── cosineSimilarityTf ──

describe("cosineSimilarityTf", () => {
  it("returns 1 for identical vectors", () => {
    const a = new Map([["mars", 2], ["space", 3]]);
    const sim = cosineSimilarityTf(a, a);
    assert.ok(Math.abs(sim - 1) < 1e-9);
  });

  it("returns 0 for completely disjoint vectors", () => {
    const a = new Map([["mars", 1]]);
    const b = new Map([["rocket", 1]]);
    assert.equal(cosineSimilarityTf(a, b), 0);
  });

  it("returns value between 0 and 1 for partially overlapping vectors", () => {
    const a = new Map([["mars", 2], ["space", 1]]);
    const b = new Map([["mars", 1], ["rocket", 3]]);
    const sim = cosineSimilarityTf(a, b);
    assert.ok(sim > 0 && sim < 1);
  });

  it("returns 0 when either vector is empty", () => {
    const a = new Map();
    const b = new Map([["mars", 1]]);
    assert.equal(cosineSimilarityTf(a, b), 0);
    assert.equal(cosineSimilarityTf(b, a), 0);
  });
});
