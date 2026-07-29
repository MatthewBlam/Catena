import { Spinner } from "@renderer/components/ui/spinner";
import { formatBytes, ollamaPhaseLabel } from "@renderer/lib/ollama";
import type { OllamaProgress } from "../../../../shared/types";

/**
 * Renders one managed-Ollama progress event: a phase label, a determinate bar
 * when `percent` is known, and a byte readout for downloads/pulls. Shared by the
 * onboarding setup and the answer-model download button.
 */
export function OllamaProgressBar({
  progress,
}: {
  progress: OllamaProgress;
}): React.JSX.Element {
  const { phase, percent, bytesCompleted, bytesTotal } = progress;
  const label = ollamaPhaseLabel(phase);
  const showBar = typeof percent === "number";

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Spinner className="size-3.5" />
        <span>{label}</span>
        {typeof percent === "number" && (
          <span className="ml-auto tabular-nums">{percent}%</span>
        )}
      </div>
      {showBar && (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-200"
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
      {typeof bytesCompleted === "number" && typeof bytesTotal === "number" && (
        <p className="text-xs tabular-nums text-muted-foreground/70">
          {formatBytes(bytesCompleted)} / {formatBytes(bytesTotal)}
        </p>
      )}
    </div>
  );
}
