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

/** Human-readable byte size for a progress line, e.g. "1.2 GB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

/** The one-line label shown for each managed-setup phase. */
export function ollamaPhaseLabel(
  phase: import("../../../shared/types").OllamaProgress["phase"],
): string {
  switch (phase) {
    case "checking":
      return "Checking for Ollama…";
    case "downloading-engine":
      return "Downloading Ollama…";
    case "extracting":
      return "Installing Ollama…";
    case "starting-engine":
      return "Starting Ollama…";
    case "pulling-model":
      return "Downloading model…";
    case "ready":
      return "Ready";
    case "error":
      return "Something went wrong";
  }
}
