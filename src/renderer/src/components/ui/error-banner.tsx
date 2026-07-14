import { cn } from "@renderer/lib/utils";
import { AlertTriangleIcon, InfoIcon, XCircleIcon } from "lucide-react";

interface ErrorBannerProps {
  variant?: "error" | "warning" | "info";
  children: React.ReactNode;
  className?: string;
  onDismiss?: () => void;
}

const icons = {
  error: XCircleIcon,
  warning: AlertTriangleIcon,
  info: InfoIcon,
};

const styles = {
  error:
    "border-destructive/30 bg-destructive/8 text-destructive-foreground [&_svg]:text-destructive",
  warning:
    "border-warning/30 bg-warning/8 text-warning-foreground [&_svg]:text-warning",
  info: "border-info/30 bg-info/8 text-info-foreground [&_svg]:text-info",
};

export function ErrorBanner({
  variant = "error",
  children,
  className,
  onDismiss,
}: ErrorBannerProps): React.JSX.Element {
  const Icon = icons[variant];

  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm",
        styles[variant],
        className,
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" />
      <div className="flex-1">{children}</div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="mt-0.5 shrink-0 opacity-60 hover:opacity-100"
        >
          <XCircleIcon className="size-4" />
        </button>
      )}
    </div>
  );
}
