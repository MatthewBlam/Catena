import { useEffect, useState } from "react";
import { Button } from "@renderer/components/ui/button";
import { ErrorBanner } from "@renderer/components/ui/error-banner";
import { getOllamaStatus, isEmbeddingModel } from "@renderer/lib/ollama";

interface OllamaOptionProps {
  onSuccess: () => void;
}

export function OllamaOption({
  onSuccess,
}: OllamaOptionProps): React.JSX.Element {
  const [status, setStatus] = useState<
    "checking" | "available" | "unavailable"
  >("checking");
  const [models, setModels] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function checkOllama(): Promise<void> {
    setStatus("checking");
    setError(null);
    try {
      const result = await getOllamaStatus();
      if (result.available) {
        setStatus("available");
        setModels(result.models);
      } else {
        setStatus("unavailable");
      }
    } catch {
      setError("Failed to check Ollama status.");
    }
  }

  useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        const result = await getOllamaStatus();
        if (ignore) return;
        if (result.available) {
          setStatus("available");
          setModels(result.models);
        } else {
          setStatus("unavailable");
        }
      } catch {
        if (ignore) return;
        setError("Failed to check Ollama status.");
      }
    })();
    return () => {
      ignore = true;
    };
  }, []);

  async function handleSelect(): Promise<void> {
    try {
      await window.api.setEmbeddingProvider("ollama");
      onSuccess();
    } catch {
      setError("Failed to set Ollama as provider.");
    }
  }

  if (error) {
    return <ErrorBanner variant="error">{error}</ErrorBanner>;
  }

  if (status === "checking") {
    return (
      <p className="text-sm text-muted-foreground">Checking for Ollama...</p>
    );
  }

  if (status === "unavailable") {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Ollama is not running. Install it from{" "}
          <button
            type="button"
            className="underline underline-offset-2 hover:text-foreground"
            onClick={() => void window.api.openExternal("https://ollama.com")}
          >
            ollama.com
          </button>
          , then start it and try again.
        </p>
        <Button variant="outline" onClick={checkOllama} className="w-full">
          Retry
        </Button>
      </div>
    );
  }

  const embeddingModels = models.filter(isEmbeddingModel);

  return (
    <div className="space-y-3">
      <p className="text-sm text-success-foreground">Ollama is running.</p>
      {embeddingModels.length > 0 ? (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Found embedding models: {embeddingModels.join(", ")}
          </p>
          <Button onClick={handleSelect} className="w-full">
            Use Ollama
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            No embedding models found. Pull one first:
          </p>
          <code className="block rounded-md bg-muted p-2 text-sm font-mono">
            ollama pull nomic-embed-text
          </code>
          <Button variant="outline" onClick={checkOllama} className="w-full">
            Retry
          </Button>
        </div>
      )}
    </div>
  );
}
