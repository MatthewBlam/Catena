import { DownloadIcon } from "lucide-react";
import { Button } from "@renderer/components/ui/button";
import { ErrorBanner } from "@renderer/components/ui/error-banner";
import { OllamaProgressBar } from "@renderer/components/setup/OllamaProgressBar";
import { useOllamaSetup } from "@renderer/lib/useOllamaSetup";

/**
 * One-click download of the Ollama chat model grounded answers need. Surfaced
 * where the "no chat model installed" hint appears; `onInstalled` fires on a
 * clean pull so the caller can retry generating the answer.
 */
export function OllamaChatModelButton({
  onInstalled,
}: {
  onInstalled?: () => void;
}): React.JSX.Element {
  const { progress, running, error, start, cancel } = useOllamaSetup();

  if (running && progress) {
    return (
      <div className="space-y-2">
        <OllamaProgressBar progress={progress} />
        <Button variant="ghost" size="xs" onClick={cancel}>
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {error && <ErrorBanner variant="error">{error}</ErrorBanner>}
      <Button
        variant="outline"
        size="sm"
        onClick={() =>
          start(() => window.api.pullOllamaChatModel(), onInstalled)
        }
      >
        <DownloadIcon />
        Download answer model
      </Button>
    </div>
  );
}
