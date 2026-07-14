const RERANK_MODEL = "rerank-v3.5";
const RERANK_TIMEOUT_MS = 15_000;

interface CohereRerankResult {
  index: number;
  relevance_score: number;
}

export async function rerank(
  query: string,
  candidates: { id: string; text: string }[],
  apiKey: string,
  topN = 8,
): Promise<{ id: string; score: number }[]> {
  const res = await fetch("https://api.cohere.com/v2/rerank", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: RERANK_MODEL,
      query,
      documents: candidates.map((c) => c.text),
      top_n: topN,
    }),
    signal: AbortSignal.timeout(RERANK_TIMEOUT_MS),
  });

  if (!res.ok)
    throw new Error(`Cohere rerank failed: ${res.status} ${res.statusText}`);

  const data = (await res.json()) as { results?: CohereRerankResult[] };
  if (!data.results || !Array.isArray(data.results)) {
    throw new Error(
      "Cohere rerank returned invalid response: missing results array",
    );
  }

  return data.results
    .filter((r) => r.index >= 0 && r.index < candidates.length)
    .map((r) => ({
      id: candidates[r.index].id,
      score: r.relevance_score,
    }));
}
