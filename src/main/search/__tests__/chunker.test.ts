import { describe, it, expect } from "vitest";
import { chunkText, estimateTokens } from "../chunker";

describe("estimateTokens", () => {
  it("estimates tokens from word count", () => {
    const text = "one two three four";
    expect(estimateTokens(text)).toBe(Math.ceil(4 / 0.75));
  });

  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("counts spaceless CJK by codepoint, not by whitespace", () => {
    // Whitespace splitting sees "你好世界" as one word (≈2 tokens); codepoint
    // counting prices it at ~1 token each — the fix that lets oversized CJK
    // sections be detected and split at all.
    expect(estimateTokens("你好世界")).toBe(4);
  });
});

describe("chunkText", () => {
  it("splits on markdown headings", () => {
    const text = "# Intro\nHello world\n## Details\nMore info here";
    const chunks = chunkText(text, "Test Doc");
    expect(chunks.length).toBe(2);
    expect(chunks[0].heading).toBe("Intro");
    expect(chunks[0].text).toBe("Hello world");
    expect(chunks[1].heading).toBe("Details");
    expect(chunks[1].text).toBe("More info here");
  });

  it("preserves heading levels (h1 through h6)", () => {
    const text =
      "# H1\nContent 1\n## H2\nContent 2\n### H3\nContent 3\n#### H4\nContent 4";
    const chunks = chunkText(text, "Test");
    expect(chunks).toHaveLength(4);
    expect(chunks[0].heading).toBe("H1");
    expect(chunks[1].heading).toBe("H2");
    expect(chunks[2].heading).toBe("H3");
    expect(chunks[3].heading).toBe("H4");
  });

  it("handles content before the first heading", () => {
    const text = "Preamble text\n# Heading\nBody text";
    const chunks = chunkText(text, "Test");
    expect(chunks).toHaveLength(2);
    expect(chunks[0].heading).toBeNull();
    expect(chunks[0].text).toBe("Preamble text");
    expect(chunks[1].heading).toBe("Heading");
  });

  it("splits oversized sections at sentence boundaries with overlap", () => {
    const sentences = Array(200).fill("This is a sentence.").join(" ");
    const chunks = chunkText(`# Big Section\n${sentences}`, "Test");
    expect(chunks.length).toBeGreaterThan(1);

    for (let i = 1; i < chunks.length; i++) {
      const prevWords = chunks[i - 1].text.split(/\s+/);
      const currWords = chunks[i].text.split(/\s+/);
      const overlapWords = prevWords.filter(
        (w, idx) =>
          idx >= prevWords.length - Math.ceil(50 * 0.75) &&
          currWords.slice(0, Math.ceil(50 * 0.75)).includes(w),
      );
      expect(overlapWords.length).toBeGreaterThan(0);
    }
  });

  it("keeps each chunk under the max token limit", () => {
    const sentences = Array(200)
      .fill("This is a test sentence with several words.")
      .join(" ");
    const chunks = chunkText(`# Section\n${sentences}`, "Test");
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(450);
    }
  });

  it("returns empty array for empty string", () => {
    expect(chunkText("", "Empty")).toHaveLength(0);
  });

  it("returns empty array for whitespace-only string", () => {
    expect(chunkText("   \n\n  ", "Whitespace")).toHaveLength(0);
  });

  it("handles document with no headings", () => {
    const text =
      "Paragraph one. Some content here.\n\nParagraph two. More content.\n\nParagraph three.";
    const chunks = chunkText(text, "Flat Doc");
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].heading).toBeNull();
  });

  it("assigns sequential indices", () => {
    const text = "# A\nContent A\n## B\nContent B\n### C\nContent C";
    const chunks = chunkText(text, "Test");
    expect(chunks.map((c) => c.index)).toEqual([0, 1, 2]);
  });

  it("assigns sequential indices across oversized splits", () => {
    const longText = Array(200).fill("Word.").join(" ");
    const text = `# Short\nBrief.\n## Long\n${longText}`;
    const chunks = chunkText(text, "Test");
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].index).toBe(i);
    }
  });

  it("computes token count for each chunk", () => {
    const text = "# Title\nSome words in this section";
    const chunks = chunkText(text, "Test");
    expect(chunks[0].tokenCount).toBe(
      Math.ceil("Some words in this section".split(/\s+/).length / 0.75),
    );
  });

  it("skips heading-only sections with no body", () => {
    const text =
      "# Title\n\n## Empty Section\n\n## Has Content\nActual content here";
    const chunks = chunkText(text, "Test");
    const headings = chunks.map((c) => c.heading);
    expect(headings).not.toContain("Empty Section");
    expect(headings).toContain("Has Content");
  });

  it("handles a single paragraph with no structure", () => {
    const text = "Just a single block of text with no structure at all.";
    const chunks = chunkText(text, "Test");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].heading).toBeNull();
    expect(chunks[0].text).toBe(text);
  });

  it("chunks a large CJK document into bounded pieces", () => {
    // 250 sentences × 20 characters = 5,000 characters, no ASCII whitespace.
    // Before the fix this produced a single ~5,000-token chunk; sentence
    // segmentation (。) plus codepoint token counting must now bound each chunk.
    const sentence = "这是一个用来测试分块逻辑的中文示例句子。";
    const doc = sentence.repeat(250);
    const chunks = chunkText(doc, "中文文档");
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(400); // MAX_TOKENS
    }
  });

  it("slices a terminator-less CJK run by codepoints", () => {
    // A 2,000-character run with no sentence terminator cannot be split by
    // segmentation or whitespace; the codepoint-slicing fallback must still keep
    // every chunk within the limit.
    const doc = "字".repeat(2000);
    const chunks = chunkText(doc, "无标点");
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(400); // MAX_TOKENS
    }
  });

  it("slices an oversized spaceless non-CJK run instead of emitting one defective chunk", () => {
    // A 100KB base64-like blob (a data URI, minified bundle, or long hash) has
    // no whitespace for the word-count heuristic to key off. Before the fix it
    // priced as a single "word" (~2 tokens) regardless of length and landed in
    // one oversized chunk, which the embedding provider then silently
    // truncates or rejects — no downstream length guard exists.
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const blob = Array.from(
      { length: 100_000 },
      (_, i) => alphabet[i % alphabet.length],
    ).join("");

    const chunks = chunkText(blob, "Blob Doc");

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      // MAX_TOKENS (400) * 8 chars/token is a safe upper bound regardless of
      // the actual chars-per-token ratio used internally.
      expect(chunk.text.length).toBeLessThanOrEqual(400 * 8);
      expect(chunk.tokenCount).toBeGreaterThan(2);
    }
  });

  it("does not move normal-text chunk boundaries when the char floor is added", () => {
    // Pinned output captured from the pre-fix chunker. The char-based floor
    // introduced for pathological spaceless runs must be a no-op for ordinary
    // multi-word English — this is the boundary-stability guarantee the fix
    // is scoped to preserve.
    const text =
      "The quick brown fox jumps over the lazy dog. It was a bright cold day in April, and the clocks were striking thirteen. Commons is a local-first search tool built for student club archives, indexing agendas, meeting notes, and shared documents so members can find what they need without hunting through a dozen different tools. Every chunk produced by the chunker should stay well under the token ceiling so downstream embedding calls never truncate silently.";

    const chunks = chunkText(text, "Normal Doc");

    expect(chunks).toEqual([
      { index: 0, heading: null, text, tokenCount: 100 },
    ]);
  });

  it("slices a realistic link-heavy section instead of pricing it as one oversized chunk", () => {
    // History of this test, in order:
    //
    // Round 1 fix: an *aggregate* character floor (total non-space chars /
    // 6 over the whole string) reclassified this exact 300-word section
    // (25% URLs/paths/filenames) as oversized (~941 estimated tokens) even
    // though word-count pricing alone put it at exactly 400 — a
    // boundary-stability violation for ordinary link-heavy prose.
    //
    // Round 2 fix: scoped the floor to individual words >= 400 chars
    // instead. That made this section correctly stay 1 chunk (no URL here
    // reaches 400 chars) — but that pin was itself wrong: a single 4,875-char
    // chunk is a real ~1,200-token payload by any actual tokenizer, ~3x
    // MAX_TOKENS, which silently truncates or errors at embed time. Pinning
    // "1 chunk, tokenCount 400" enshrined the same F6 defect through a
    // different door — 400 was the word-*count* estimate, not a bound on
    // the section's real size.
    //
    // Round 3 fix (current): words longer than LONG_WORD_CHARS (24 — above
    // any natural-language word) are priced by character count at ~4
    // chars/token. These URLs are 40-100+ chars, so they are now correctly
    // priced by length instead of the flat ~1.33-token/word charge. The
    // section's real estimate is 1920, well over MAX_TOKENS, and it is
    // correctly sliced into several bounded chunks instead of landing in
    // one oversized chunk.
    const filler = [
      "the",
      "club",
      "meeting",
      "was",
      "held",
      "to",
      "discuss",
      "budget",
      "plans",
      "for",
      "next",
      "semester",
      "members",
      "voted",
      "on",
      "new",
      "officers",
      "and",
      "reviewed",
      "the",
      "agenda",
      "before",
      "closing",
      "with",
      "announcements",
      "about",
      "upcoming",
      "events",
      "and",
      "fundraising",
    ];
    const urls = [
      "https://cpclubs.calpoly.edu/orgs/robotics-club/documents/meeting-notes-2026-03-15-agenda-final.pdf",
      "https://drive.google.com/file/d/1A2b3C4d5E6f7G8h9I0jKlMnOpQrStUvWxYz/view?usp=sharing",
      "/Users/clubadmin/Documents/ClubArchive/2026/spring/officer-elections-results.xlsx",
      "https://calendar.google.com/calendar/event?eid=abcdefghijklmnopqrstuvwxyz1234567890",
      "C:\\Users\\officer\\Documents\\Fundraising\\2026-spring-budget-proposal-v3.docx",
    ];
    const words: string[] = [];
    for (let i = 0; i < 300; i++) {
      words.push(
        i % 4 === 0
          ? urls[Math.floor(i / 4) % urls.length]
          : filler[i % filler.length],
      );
    }
    const text = words.join(" ");

    // The plain word-count estimate alone would be exactly 400 (300 words /
    // 0.75) — the number that made the old pin look "safe." The real,
    // length-aware estimate is 1920: nearly 5x higher, because 75 of these
    // 300 "words" are 40-100+ char URLs priced by length, not by count.
    expect(estimateTokens(text)).toBe(1920);

    const chunks = chunkText(text, "Link Heavy");

    expect(chunks.length).toBe(6);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(400); // MAX_TOKENS
      expect(chunk.text.length).toBeLessThanOrEqual(400 * 8);
      expect(chunk.tokenCount).toBe(estimateTokens(chunk.text));
    }
  });

  it("bounds a space-separated list of UUIDs instead of pricing it as ~2 tokens/word", () => {
    // Regression for a review finding: a per-word floor keyed only to
    // extremely long words (>= a few hundred chars) misses ordinary
    // documents whose *aggregate* volume of moderately-long tokens is the
    // real problem — 300 space-separated UUIDs (a pasted export) are 36
    // chars each, individually nowhere near pathological, but their real
    // token cost is far above what word-count pricing (~1.33 tokens/word)
    // reports. Before this fix that priced as estimate 400 → a single
    // ~11,100-char chunk (~7x the real token budget) — the original F6
    // defect through a different door.
    const hex = (n: number, len: number): string =>
      n.toString(16).padStart(len, "0").slice(0, len);
    const uuid = (i: number): string =>
      `${hex(i, 8)}-${hex(i * 7, 4)}-${hex(i * 13, 4)}-${hex(i * 17, 4)}-${hex(i * 19, 12)}`;
    const words = Array.from({ length: 300 }, (_, i) => uuid(i));
    expect(words.every((w) => w.length === 36)).toBe(true);
    const text = words.join(" ");

    const chunks = chunkText(text, "UUID Export");

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(400 * 8);
      expect(chunk.tokenCount).toBeLessThanOrEqual(450);
      // Internal consistency: the reported tokenCount matches what
      // estimateTokens computes for that exact chunk text.
      expect(chunk.tokenCount).toBe(estimateTokens(chunk.text));
    }
  });

  it("bounds a run of long fixed-length hashes the same way", () => {
    // Second pathological-aggregate case at a different word length (200
    // chars, well past a UUID but still far short of the codepoint-slicer's
    // per-word threshold) — same underlying bug, different shape.
    const hash = (i: number): string =>
      (i.toString(16) + "0".repeat(200)).slice(0, 200);
    const words = Array.from({ length: 250 }, (_, i) => hash(i));
    expect(words.every((w) => w.length === 200)).toBe(true);
    const text = words.join(" ");

    const chunks = chunkText(text, "Hash List");

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(400 * 8);
      expect(chunk.tokenCount).toBe(estimateTokens(chunk.text));
    }
  });

  it("bounds a roster of emails that stay under LONG_WORD_CHARS but are still length-blind to word-count pricing", () => {
    // Regression for a review finding: Round 3's per-word floor only
    // reprices words that cross LONG_WORD_CHARS (24 chars) into a
    // char-based estimate — everything at or under that threshold still
    // went through the flat ~1.33-tokens/word count heuristic, which is
    // length-blind *within* the short bucket. 300 club-member emails
    // (~21 chars each, comfortably under 24 so they stay "short") priced as
    // a plain word count of 400 and landed in a single ~6,700-char chunk —
    // roughly 4x the real token budget. This is the same family of bug as
    // the UUID/hash cases, one bucket over.
    const emails = Array.from(
      { length: 300 },
      (_, i) => `member${String(i).padStart(3, "0")}@calpoly.edu`,
    );
    expect(emails.every((w) => w.length === 21)).toBe(true);
    const text = emails.join(" ");

    // Word-count-only pricing would say exactly 400 (300 / 0.75) — same
    // number that made the Round-2 link-heavy pin look safe. The
    // char-based floor over the short bucket (300 words × 21 chars / 8)
    // reveals the real estimate is much higher.
    expect(estimateTokens(text)).toBe(788);

    const chunks = chunkText(text, "Email Roster");

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(400 * 8);
      expect(chunk.tokenCount).toBe(estimateTokens(chunk.text));
    }
  });

  it("pins the short-bucket char-floor crossover at ~10.67 avg chars/word", () => {
    // Deliberate boundary probe for the Round 4 fix: the floor
    // (shortWordChars / 8) only beats the count estimate
    // (shortWordCount / 0.75) once the short-bucket average word length
    // exceeds 8 / 0.75 ≈ 10.67 chars. Pinned on both sides of that line, at
    // a word count (300) large enough that rounding doesn't blur the
    // comparison.
    const w11 = Array.from(
      { length: 300 },
      (_, i) => `lorem${String(i).padStart(6, "0")}`,
    );
    expect(w11.every((w) => w.length === 11)).toBe(true);
    // 300 × 11 / 8 = 412.5 → 413, just over MAX_TOKENS: the floor wins and
    // tips this section from "exactly at the limit" to oversized.
    expect(estimateTokens(w11.join(" "))).toBe(413);
    expect(chunkText(w11.join(" "), "Eleven").length).toBeGreaterThan(1);

    const w9 = Array.from(
      { length: 300 },
      (_, i) => `word${String(i).padStart(5, "0")}`,
    );
    expect(w9.every((w) => w.length === 9)).toBe(true);
    // 300 × 9 / 8 = 337.5 → 338, under the 400 count-based estimate: the
    // count estimate wins and this section is unaffected by the Round 4
    // fix — identical to Round 3 and to the pre-Task-11 formula.
    expect(estimateTokens(w9.join(" "))).toBe(400);
    expect(chunkText(w9.join(" "), "Nine")).toHaveLength(1);
  });
});
