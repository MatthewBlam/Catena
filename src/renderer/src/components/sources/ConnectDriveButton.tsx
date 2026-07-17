import { useState } from "react";
import { Button } from "@renderer/components/ui/button";
import { Spinner } from "@renderer/components/ui/spinner";
import { toErrorMessage } from "@renderer/lib/errors";
import { DrivePicker } from "./DrivePicker";

interface ConnectDriveButtonProps {
  onSourceAdded: () => void;
}

export function ConnectDriveButton({
  onSourceAdded,
}: ConnectDriveButtonProps): React.JSX.Element {
  const [step, setStep] = useState<"idle" | "waiting" | "pick">("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleConnect(): Promise<void> {
    setError(null);
    try {
      // See ConnectNotionButton: hasSecret keeps the raw OAuth tokens out of
      // renderer memory, and moving the call inside the try means a failure here
      // shows an error instead of silently killing the button.
      if (await window.api.hasSecret("google_tokens")) {
        setStep("pick");
        return;
      }
      setStep("waiting");
      await window.api.startGoogleOAuth();
      setStep("pick");
    } catch (err) {
      const msg = toErrorMessage(err, "Failed to connect to Google Drive");
      if (msg === "OAuth canceled") {
        setStep("idle");
      } else {
        setError(msg);
        setStep("idle");
      }
    }
  }

  function handleCancelOAuth(): void {
    setStep("idle");
    window.api.cancelGoogleOAuth().catch(() => {});
  }

  async function handlePickAdd(
    selections: Array<{ id: string; name: string }>,
  ): Promise<{ added: number; failed: number }> {
    setError(null);
    const results = await Promise.allSettled(
      selections.map(({ id, name }) =>
        window.api.addSource({
          provider: "google_drive",
          folderId: id,
          folderName: name,
        }),
      ),
    );
    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length > 0) {
      setError(
        `Failed to add ${failures.length} of ${selections.length} source${selections.length !== 1 ? "s" : ""}`,
      );
    }
    if (failures.length < selections.length) {
      onSourceAdded();
    }
    return {
      added: selections.length - failures.length,
      failed: failures.length,
    };
  }

  if (step === "pick") {
    return (
      <div className="space-y-1 mt-4">
        <h3 className="text-sm font-medium">Add Drive source</h3>
        <DrivePicker onAdd={handlePickAdd} onClose={() => setStep("idle")} />
        {error && (
          <p className="text-sm text-destructive-foreground">{error}</p>
        )}
      </div>
    );
  }

  if (step === "waiting") {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-4" />
        <span>Waiting for Google authorization…</span>
        <Button
          className="ml-auto"
          variant="destructive-outline"
          size="xs"
          onClick={handleCancelOAuth}
        >
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Button
        variant="outline"
        className="w-full justify-start gap-2"
        onClick={handleConnect}
      >
        <DriveIcon />
        Connect Google Drive
      </Button>
      {error && <p className="text-sm text-destructive-foreground">{error}</p>}
    </div>
  );
}

function DriveIcon(): React.JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 256 228"
      width="16"
      height="16"
      fill="none"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path
        fill="#0066DA"
        d="m19.354 196.034l11.29 19.5c2.346 4.106 5.718 7.332 9.677 9.678q17.009-21.591 23.68-33.137q6.77-11.717 16.641-36.655q-26.604-3.502-40.32-3.502q-13.165 0-40.322 3.502c0 4.545 1.173 9.09 3.519 13.196z"
      />
      <path
        fill="#EA4335"
        d="M215.681 225.212c3.96-2.346 7.332-5.572 9.677-9.677l4.692-8.064l22.434-38.855a26.57 26.57 0 0 0 3.518-13.196q-27.315-3.502-40.247-3.502q-13.899 0-40.248 3.502q9.754 25.075 16.422 36.655q6.724 11.683 23.752 33.137"
      />
      <path
        fill="#00832D"
        d="M128.001 73.311q19.68-23.768 27.125-36.655q5.996-10.377 13.196-33.137C164.363 1.173 159.818 0 155.126 0h-54.25C96.184 0 91.64 1.32 87.68 3.519q9.16 26.103 15.544 37.154q7.056 12.213 24.777 32.638"
      />
      <path
        fill="#2684FC"
        d="M175.36 155.42H80.642l-40.32 69.792c3.958 2.346 8.503 3.519 13.195 3.519h148.968c4.692 0 9.238-1.32 13.196-3.52z"
      />
      <path
        fill="#00AC47"
        d="M128.001 73.311L87.681 3.52c-3.96 2.346-7.332 5.571-9.678 9.677L3.519 142.224A26.57 26.57 0 0 0 0 155.42h80.642z"
      />
      <path
        fill="#FFBA00"
        d="m215.242 77.71l-37.243-64.514c-2.345-4.106-5.718-7.331-9.677-9.677l-40.32 69.792l47.358 82.109h80.496c0-4.546-1.173-9.09-3.519-13.196z"
      />
    </svg>
  );
}
