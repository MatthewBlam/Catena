import { useEffect, useRef, useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { Button } from "@renderer/components/ui/button";
import { ErrorBanner } from "@renderer/components/ui/error-banner";
import { getOllamaStatus, isEmbeddingModel } from "@renderer/lib/ollama";

const PULL_COMMAND = "ollama pull nomic-embed-text";

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
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    return () => window.clearTimeout(copiedTimerRef.current);
  }, []);

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(PULL_COMMAND);
      setCopied(true);
      window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable — the snippet text is still selectable by hand.
    }
  }

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
      <p className="text-sm text-muted-foreground">Checking for Ollama…</p>
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
          <div className="flex items-center justify-between gap-2 rounded-sm bg-muted py-1 pl-2 pr-1">
            <code className="text-sm font-mono">{PULL_COMMAND}</code>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={copied ? "Copied" : "Copy command"}
              onClick={() => void handleCopy()}
            >
              {copied ? <CheckIcon /> : <CopyIcon />}
            </Button>
          </div>
          <Button variant="outline" onClick={checkOllama} className="w-full">
            Retry
          </Button>
        </div>
      )}
    </div>
  );
}
