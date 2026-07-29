import { AlertDialog } from "@base-ui/react/alert-dialog";
import type * as React from "react";
import { Button, type ButtonProps } from "@renderer/components/ui/button";

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** The body: plain text or rich content (paragraphs, emphasis, etc.). */
  children: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmVariant?: ButtonProps["variant"];
  /** Lets the cancel (safe) action be the visually prominent one when the
   * confirmed action is the discouraged path. */
  cancelVariant?: ButtonProps["variant"];
  /** Runs on confirm; the dialog closes itself afterward. */
  onConfirm: () => void;
}

/**
 * A modal yes/no confirmation built on Base UI's AlertDialog (matching the other
 * `ui/` primitives). Controlled via `open`/`onOpenChange`; the parent decides
 * what confirming does. Unlike native `confirm()`, the body can carry formatted,
 * emphasized copy — used where a choice needs real explanation, not a one-liner.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  children,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  confirmVariant = "default",
  cancelVariant = "outline",
  onConfirm,
}: ConfirmDialogProps): React.JSX.Element {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-black/50 transition-opacity duration-150 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <AlertDialog.Popup className="fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-card p-5 shadow-lg outline-none transition-[opacity,transform] duration-150 data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0">
          <AlertDialog.Title className="text-base font-medium text-foreground">
            {title}
          </AlertDialog.Title>
          <AlertDialog.Description
            render={<div />}
            className="mt-2 space-y-2 text-sm text-muted-foreground"
          >
            {children}
          </AlertDialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Close
              render={<Button variant={cancelVariant} size="sm" />}
            >
              {cancelLabel}
            </AlertDialog.Close>
            <Button
              variant={confirmVariant}
              size="sm"
              onClick={() => {
                onConfirm();
                onOpenChange(false);
              }}
            >
              {confirmLabel}
            </Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
