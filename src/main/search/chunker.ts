export interface ChunkData {
  index: number;
  heading: string | null;
  text: string;
  tokenCount: number;
}

const MAX_TOKENS = 400;
const OVERLAP_TOKENS = 50;
const HEADING_REGEX = /^(#{1,6})\s+(.+)$/;

// Codepoints from scripts written without spaces between words — CJK ideographs
// and kana, plus the CJK/fullwidth punctuation blocks. The whitespace word
// heuristic below reads a spaceless run as a single "word" and so under-counts
// these by orders of magnitude; each such codepoint is priced at ~1 token.
const CJK_CHAR =
  /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/g;

// Any word longer than this is priced by character count instead of by the
// ~1.33-tokens/word count heuristic. 24 sits comfortably above the longest
// word in any natural-English test fixture (scanned max: 9 chars) and above
// any realistic natural-language word, but well below a UUID (36 chars), a
// file hash, or a URL — so short words stay cheaply and accurately priced
// by count, while long tokens (individually unremarkable, but whose
// *aggregate* volume a word-count-only estimate would silently miss — e.g.
// a pasted export of hundreds of UUIDs) are priced by length instead of
// disappearing into a flat ~1.33-token charge each.
const LONG_WORD_CHARS = 24;

export function estimateTokens(text: string): number {
  const cjkChars = (text.match(CJK_CHAR) ?? []).length;
  // Strip the CJK codepoints before the whitespace heuristic so a mixed
  // "Latin 中文" string counts both halves, then add the CJK codepoints back at
  // ~1 token each. Pure-Latin text is unchanged — there is nothing to strip.
  const stripped = text.replace(CJK_CHAR, " ");
  // .length is UTF-16 code units, not codepoints — conservative (an
  // overcount) for astral-plane characters, which is the safe direction for
  // a floor whose purpose is to avoid under-pricing.
  const words = stripped.split(/\s+/).filter(Boolean);
  let shortWordCount = 0;
  let longWordChars = 0;
  for (const word of words) {
    if (word.length > LONG_WORD_CHARS) {
      // Worst-case ~4 chars/token: real BPE tokenizers run close to this for
      // high-entropy non-language text (hex, base64, UUIDs) that has few or
      // no learned merges, unlike natural prose's ~4-5 chars/token average.
      longWordChars += Math.ceil(word.length / 4);
    } else {
      shortWordCount++;
    }
  }
  return Math.ceil(shortWordCount / 0.75) + cjkChars + longWordChars;
}

/** Slice a spaceless run into codepoint groups each ≈ maxTokens tokens. */
function sliceByTokens(text: string, maxTokens: number): string[] {
  const chars = Array.from(text); // codepoint-aware (handles surrogate pairs)
  const pieces: string[] = [];
  for (let i = 0; i < chars.length; i += maxTokens) {
    pieces.push(chars.slice(i, i + maxTokens).join(""));
  }
  return pieces;
}

function splitOnHeadings(
  text: string,
): { heading: string | null; body: string }[] {
  const lines = text.split("\n");
  const sections: { heading: string | null; body: string }[] = [];
  let currentHeading: string | null = null;
  let currentLines: string[] = [];

  for (const line of lines) {
    const match = line.match(HEADING_REGEX);
    if (match) {
      const body = currentLines.join("\n").trim();
      if (body || currentHeading !== null) {
        sections.push({ heading: currentHeading, body });
      }
      currentHeading = match[2].trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  const remaining = currentLines.join("\n").trim();
  if (remaining || currentHeading !== null) {
    sections.push({ heading: currentHeading, body: remaining });
  }

  return sections;
}

function splitOnParagraphs(
  text: string,
): { heading: string | null; body: string }[] {
  const paragraphs = text
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paragraphs.length === 0) return [];
  return [{ heading: null, body: paragraphs.join("\n\n") }];
}

function splitAtSentences(text: string): string[] {
  // Intl.Segmenter knows sentence boundaries for every script — including CJK
  // terminators (。！？) and RTL punctuation the Latin-only regex below cannot
  // see. Without it, CJK/Arabic/Hebrew never split into sentences and fell
  // through to whitespace word-splitting, which CJK has none of — producing one
  // enormous chunk per document.
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    try {
      const segmenter = new Intl.Segmenter(undefined, {
        granularity: "sentence",
      });
      const parts: string[] = [];
      for (const { segment } of segmenter.segment(text)) {
        const trimmed = segment.trim();
        if (trimmed) parts.push(trimmed);
      }
      if (parts.length > 0) return parts;
    } catch {
      // fall through to the regex
    }
  }
  // Latin-only fallback (Segmenter should always be present in Node/Electron);
  // CJK terminators added so it at least splits some CJK when it is not.
  return text.split(/(?<=[.!?。！？])\s+(?=[A-ZÀ-ɏ"])/).filter(Boolean);
}

function splitOversizedSection(
  text: string,
  heading: string | null,
  startIndex: number,
): ChunkData[] {
  const sentences = splitAtSentences(text);
  const chunks: ChunkData[] = [];
  let current: string[] = [];
  let currentTokens = 0;
  let idx = startIndex;

  for (const sentence of sentences) {
    const sentenceTokens = estimateTokens(sentence);

    if (sentenceTokens > MAX_TOKENS) {
      if (current.length > 0) {
        const chunkText = current.join(" ");
        chunks.push({
          index: idx++,
          heading,
          text: chunkText,
          tokenCount: estimateTokens(chunkText),
        });
        current = [];
        currentTokens = 0;
      }
      const words = sentence.split(/\s+/);
      let wordBuf: string[] = [];
      let wordTokens = 0;
      for (const word of words) {
        const wt = estimateTokens(word);

        // A single "word" over the limit is a spaceless run (typically CJK)
        // with no whitespace boundary to pack against — the old code emitted it
        // as one over-limit chunk. Slice it by codepoints instead, keeping the
        // remainder in the buffer so the following words can still pack onto it.
        if (wt > MAX_TOKENS) {
          if (wordBuf.length > 0) {
            const chunkText = wordBuf.join(" ");
            chunks.push({
              index: idx++,
              heading,
              text: chunkText,
              tokenCount: estimateTokens(chunkText),
            });
            wordBuf = [];
            wordTokens = 0;
          }
          const pieces = sliceByTokens(word, MAX_TOKENS);
          for (let i = 0; i < pieces.length - 1; i++) {
            chunks.push({
              index: idx++,
              heading,
              text: pieces[i],
              tokenCount: estimateTokens(pieces[i]),
            });
          }
          const tail = pieces[pieces.length - 1];
          wordBuf.push(tail);
          wordTokens += estimateTokens(tail);
          continue;
        }

        if (wordTokens + wt > MAX_TOKENS && wordBuf.length > 0) {
          const chunkText = wordBuf.join(" ");
          chunks.push({
            index: idx++,
            heading,
            text: chunkText,
            tokenCount: estimateTokens(chunkText),
          });
          wordBuf = [];
          wordTokens = 0;
        }
        wordBuf.push(word);
        wordTokens += wt;
      }
      if (wordBuf.length > 0) {
        current = wordBuf;
        currentTokens = wordTokens;
      }
      continue;
    }

    if (currentTokens + sentenceTokens > MAX_TOKENS && current.length > 0) {
      const chunkText = current.join(" ");
      chunks.push({
        index: idx++,
        heading,
        text: chunkText,
        tokenCount: estimateTokens(chunkText),
      });

      const overlapTarget = OVERLAP_TOKENS;
      const overlapSentences: string[] = [];
      let overlapCount = 0;
      for (let i = current.length - 1; i >= 0; i--) {
        const st = estimateTokens(current[i]);
        if (overlapCount + st > overlapTarget && overlapSentences.length > 0)
          break;
        overlapSentences.unshift(current[i]);
        overlapCount += st;
      }
      current = [...overlapSentences];
      currentTokens = overlapCount;
    }

    current.push(sentence);
    currentTokens += sentenceTokens;
  }

  if (current.length > 0) {
    const chunkText = current.join(" ");
    chunks.push({
      index: idx,
      heading,
      text: chunkText,
      tokenCount: estimateTokens(chunkText),
    });
  }

  return chunks;
}

export function chunkText(text: string, _title: string): ChunkData[] {
  if (!text.trim()) return [];

  const hasHeadings = HEADING_REGEX.test(
    text.split("\n").find((l) => HEADING_REGEX.test(l)) ?? "",
  );
  const sections = hasHeadings
    ? splitOnHeadings(text)
    : splitOnParagraphs(text);

  if (sections.length === 0) return [];

  const chunks: ChunkData[] = [];
  let index = 0;

  for (const section of sections) {
    if (!section.body.trim()) continue;

    const tokens = estimateTokens(section.body);
    if (tokens <= MAX_TOKENS) {
      chunks.push({
        index,
        heading: section.heading,
        text: section.body,
        tokenCount: tokens,
      });
      index++;
    } else {
      const split = splitOversizedSection(section.body, section.heading, index);
      chunks.push(...split);
      index += split.length;
    }
  }

  return chunks;
}
