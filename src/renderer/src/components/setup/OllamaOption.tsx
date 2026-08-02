import { useEffect, useState } from "react";
import { Button } from "@renderer/components/ui/button";
import { ErrorBanner } from "@renderer/components/ui/error-banner";
import { Spinner } from "@renderer/components/ui/spinner";
import { OllamaInstallPanel } from "@renderer/components/setup/OllamaInstallPanel";
import type { OllamaStatusDetail } from "../../../../shared/types";

interface OllamaOptionProps {
  onSuccess: () => void;
}

/**
 * Local-provider onboarding. Replaces the old copy-a-terminal-command flow with
 * a one-click managed setup: the main process downloads + starts Ollama (or
 * reuses a running one) and pulls the embedding model. If everything is already
 * installed it goes straight to "Use Ollama"; otherwise it delegates to the
 * shared `OllamaInstallPanel` (also used in Settings).
 */
export function OllamaOption({
  onSuccess,
}: OllamaOptionProps): React.JSX.Element {
  const [status, setStatus] = useState<OllamaStatusDetail | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

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

  if (statusError) {
    return <ErrorBanner variant="error">{statusError}</ErrorBanner>;
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

  return <OllamaInstallPanel onInstalled={onSuccess} />;
}
