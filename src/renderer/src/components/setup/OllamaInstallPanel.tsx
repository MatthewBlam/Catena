import { Button } from "@renderer/components/ui/button";
import { ErrorBanner } from "@renderer/components/ui/error-banner";
import { OllamaProgressBar } from "@renderer/components/setup/OllamaProgressBar";
import { useOllamaSetup } from "@renderer/lib/useOllamaSetup";

interface OllamaInstallPanelProps {
  /** Fires once a managed setup finishes successfully (not on cancel). */
  onInstalled: () => void;
}

/**
 * The one-click managed-Ollama install UI: a "Set up Ollama" button that
 * downloads + starts the engine and pulls the embedding model, swapping to a
 * live progress bar (with cancel) while it runs. Shared by onboarding
 * (`OllamaOption`) and the Settings local-model section so both stay identical.
 */
export function OllamaInstallPanel({
  onInstalled,
}: OllamaInstallPanelProps): React.JSX.Element {
  const { progress, running, error, start, cancel } = useOllamaSetup();

  function runSetup(): void {
    start(
      () => window.api.ollamaSetup(),
      () => onInstalled(),
    );
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
