import { memo } from "react";
import { ExternalLinkIcon } from "lucide-react";
import { Button } from "@renderer/components/ui/button";
import type { SearchResult } from "../../../../shared/types";
import { providerLabel } from "@renderer/lib/format";

interface ResultCardProps {
  result: SearchResult;
}

export const ResultCard = memo(function ResultCard({
  result,
}: ResultCardProps): React.JSX.Element {
  const snippet =
    result.snippet.length > 200
      ? result.snippet.slice(0, 200) + "..."
      : result.snippet;

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-medium text-foreground truncate">
            {result.documentTitle}
          </h3>
          {result.heading && (
            <p className="text-xs text-muted-foreground truncate">
              {result.heading}
            </p>
          )}
        </div>
        <span className="shrink-0 rounded-md bg-secondary px-1.5 py-0.5 text-xs text-muted-foreground">
          {providerLabel(result.provider)}
        </span>
      </div>

      <p className="text-sm text-muted-foreground leading-relaxed select-text">
        {snippet}
      </p>

      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground/60">
          {(result.score * 100).toFixed(0)}% match
        </span>
        {result.url && (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => void window.api.openExternal(result.url!)}
          >
            Open source
            <ExternalLinkIcon />
          </Button>
        )}
      </div>
    </div>
  );
});
