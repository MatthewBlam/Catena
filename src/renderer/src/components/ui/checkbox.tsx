import { CheckIcon } from "lucide-react";
import { cn } from "@renderer/lib/utils";

interface CheckboxProps {
  checked: boolean;
  onChange?: () => void;
  className?: string;
  /**
   * Visible text rendered inside the control, beside the box. A bare box has no
   * way to acquire an accessible name — it is a `button`, so a wrapping `<label>`
   * is not part of its name computation — and list rows solve that by pairing it
   * with a separate labelled button. For a standalone checkbox that would mean
   * two tab stops for one control, so the label goes inside instead.
   */
  label?: React.ReactNode;
}

export function Checkbox({
  checked,
  onChange,
  className,
  label,
}: CheckboxProps): React.JSX.Element {
  const boxStyles = cn(
    "cursor-pointer flex size-4 shrink-0 items-center justify-center rounded border",
    checked
      ? "border-primary bg-primary text-primary-foreground"
      : "border-input",
    // Unlabelled, the control *is* the box, so the caller's classes land on it;
    // labelled, they belong to the row that wraps it.
    label === undefined && className,
  );

  const icon = checked && <CheckIcon strokeWidth={3} className="size-3" />;
  // Unlabelled renders exactly as before: the box, with the icon directly inside.
  const content =
    label === undefined ? (
      icon
    ) : (
      <>
        <span className={boxStyles}>{icon}</span>
        {label}
      </>
    );
  const styles =
    label === undefined
      ? boxStyles
      : cn("flex cursor-pointer items-center gap-2", className);

  if (!onChange) {
    return (
      <span role="checkbox" aria-checked={checked} className={styles}>
        {content}
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
      {content}
    </button>
  );
}
