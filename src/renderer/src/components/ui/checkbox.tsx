import { CheckIcon } from "lucide-react";
import { cn } from "@renderer/lib/utils";

interface CheckboxProps {
  checked: boolean;
  onChange?: () => void;
  className?: string;
}

export function Checkbox({
  checked,
  onChange,
  className,
}: CheckboxProps): React.JSX.Element {
  const styles = cn(
    "cursor-pointer flex size-4 shrink-0 items-center justify-center rounded border",
    checked
      ? "border-primary bg-primary text-primary-foreground"
      : "border-input",
    className,
  );

  const icon = checked && <CheckIcon strokeWidth={3} className="size-3" />;

  if (!onChange) {
    return (
      <span role="checkbox" aria-checked={checked} className={styles}>
        {icon}
      </span>
    );
  }

  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={onChange}
      className={cn(
        styles,
        "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/24",
      )}
    >
      {icon}
    </button>
  );
}
