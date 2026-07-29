import { useEffect, useState } from "react";
import { Button } from "@renderer/components/ui/button";
import { ErrorBanner } from "@renderer/components/ui/error-banner";
import { Spinner } from "@renderer/components/ui/spinner";
import { OllamaProgressBar } from "@renderer/components/setup/OllamaProgressBar";
import { useOllamaSetup } from "@renderer/lib/useOllamaSetup";
import type { OllamaStatusDetail } from "../../../../shared/types";

interface OllamaOptionProps {
  onSuccess: () => void;
}

/**
 * Local-provider onboarding. Replaces the old copy-a-terminal-command flow with
 * a one-click managed setup: the main process downloads + starts Ollama (or
 * reuses a running one) and pulls the embedding model, streaming progress here.
 * If everything is already installed, it goes straight to "Use Ollama".
 */
export function OllamaOption({
  onSuccess,
}: OllamaOptionProps): React.JSX.Element {
  const [status, setStatus] = useState<OllamaStatusDetail | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const { progress, running, error, start, cancel } = useOllamaSetup();

  useEffect(() => {
    let ignore = false;
    window.api
      .getOllamaStatusDetail()
      .then((s) => {
        if (!ignore) setStatus(s);
      })
      .catch(() => {
        if (!ignore) setStatusError("Failed to check Ollama status.");
      });
    return () => {
      ignore = true;
    };
  }, []);

  async function handleUseExisting(): Promise<void> {
    try {
      await window.api.setEmbeddingProvider("ollama");
      onSuccess();
    } catch {
      setStatusError("Failed to set Ollama as provider.");
    }
  }

  function runSetup(): void {
    // On a clean finish, persist provider + advance. Refresh status too, so a
    // failure mid-way leaves the button in the right state.
    start(
      () => window.api.ollamaSetup(),
      () => onSuccess(),
    );
  }

  if (statusError) {
    return <ErrorBanner variant="error">{statusError}</ErrorBanner>;
  }

  if (running && progress) {
    return (
      <div className="space-y-3">
        <OllamaProgressBar progress={progress} />
        <Button variant="outline" onClick={cancel} className="w-full">
          Cancel
        </Button>
      </div>
    );
  }

  if (status === null) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-3.5" />
        Checking for Ollama…
      </p>
    );
  }

  // Everything's already in place (a prior setup, or a system Ollama with an
  // embedding model) — no download needed.
  if (status.engineUp && status.embeddingReady) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-success-foreground">
          Ollama is ready ({status.embeddingModels.join(", ")}).
        </p>
        <Button onClick={() => void handleUseExisting()} className="w-full">
          Use Ollama
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {error && <ErrorBanner variant="error">{error}</ErrorBanner>}
      <p className="text-sm text-muted-foreground">
        Commons will download and run Ollama locally, then fetch the embedding
        model it needs — no manual setup or account required. This can take a
        few minutes and around 300&nbsp;MB.
      </p>
      <Button onClick={runSetup} className="w-full">
        Set up Ollama
      </Button>
    </div>
  );
}
