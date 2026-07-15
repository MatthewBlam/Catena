/**
 * Whether an Ollama model name looks like an embedding model. A heuristic, but
 * the same one onboarding uses to decide if the user has something to embed
 * with — kept in one place so App-readiness and the onboarding option agree.
 */
export function isEmbeddingModel(name: string): boolean {
  return (
    name.includes("embed") || name.includes("nomic") || name.includes("mxbai")
  );
}

export interface OllamaStatus {
  available: boolean;
  models: string[];
  embeddingModels: string[];
}

/** Whether Ollama is reachable, and which of its models can embed. */
export async function getOllamaStatus(): Promise<OllamaStatus> {
  const { available, models } = await window.api.checkOllama();
  return {
    available,
    models,
    embeddingModels: models.filter(isEmbeddingModel),
  };
}
