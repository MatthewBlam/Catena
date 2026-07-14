import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import type * as React from "react";
import { cn } from "@renderer/lib/utils";

export type SwitchProps = SwitchPrimitive.Root.Props;

export function Switch({
  className,
  ...props
}: SwitchProps): React.ReactElement {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "relative inline-flex h-5 w-8 shrink-0 cursor-pointer items-center rounded-full border border-input bg-input/64 p-px outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/24 disabled:pointer-events-none disabled:opacity-64 data-checked:border-primary data-checked:bg-primary",
        className,
      )}
      data-slot="switch"
      {...props}
    >
      <SwitchPrimitive.Thumb
        className="block size-4 rounded-full bg-background shadow-xs transition-[translate] data-checked:translate-x-3"
        data-slot="switch-thumb"
      />
    </SwitchPrimitive.Root>
  );
}
