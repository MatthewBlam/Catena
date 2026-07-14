import { useState } from "react";
import { Button } from "@renderer/components/ui/button";
import { Spinner } from "@renderer/components/ui/spinner";
import { NotionPicker } from "./NotionPicker";

interface ConnectNotionButtonProps {
  onSourceAdded: () => void;
}

export function ConnectNotionButton({
  onSourceAdded,
}: ConnectNotionButtonProps): React.JSX.Element {
  const [step, setStep] = useState<"idle" | "waiting" | "pick">("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleConnect(): Promise<void> {
    setError(null);
    try {
      // Two changes here. hasSecret rather than loadSecret: we only need to know
      // *whether* a token exists, and loadSecret would pull the raw OAuth token
      // across the context bridge into renderer memory to answer that.
      //
      // And inside the try, where it always belonged. handleConnect is a floating
      // promise off onClick, so a throw out here — hasSecret rejects on an unknown
      // key, and the DB can be locked — rejected it unhandled and left the button
      // simply dead: no spinner, no error, nothing.
      if (await window.api.hasSecret("notion_token")) {
        setStep("pick");
        return;
      }
      setStep("waiting");
      await window.api.startNotionOAuth();
      setStep("pick");
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Failed to connect to Notion";
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
    window.api.cancelNotionOAuth().catch(() => {});
  }

  async function handlePickAdd(
    selections: Array<{ id: string; name: string }>,
  ): Promise<{ added: number; failed: number }> {
    setError(null);
    const results = await Promise.allSettled(
      selections.map(({ id, name }) =>
        window.api.addSource({ provider: "notion", rootPageId: id, name }),
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
      <div className="space-y-1">
        <h3 className="text-sm font-medium">Add Notion source</h3>
        <NotionPicker onAdd={handlePickAdd} onClose={() => setStep("idle")} />
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
        <span>Waiting for Notion authorization…</span>
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
        <NotionIcon />
        Connect Notion
      </Button>
      {error && <p className="text-sm text-destructive-foreground">{error}</p>}
    </div>
  );
}

function NotionIcon(): React.JSX.Element {
  return (
    <svg
      fill="currentColor"
      fillRule="evenodd"
      height="16"
      width="16"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        clipRule="evenodd"
        d="M15.257.055l-13.31.98C.874 1.128.5 1.83.5 2.667v14.559c0 .654.233 1.213.794 1.96l3.129 4.06c.513.653.98.794 1.962.745l15.457-.932c1.307-.093 1.681-.7 1.681-1.727V4.954c0-.53-.21-.684-.829-1.135l-.106-.078L18.34.755c-1.027-.746-1.45-.84-3.083-.7zm-8.521 4.63c-1.263.086-1.549.105-2.266-.477L2.647 2.76c-.186-.187-.092-.42.375-.466l12.796-.933c1.074-.094 1.634.28 2.054.606l2.195 1.587c.093.047.326.326.047.326l-13.216.794-.162.01zM5.263 21.193V7.287c0-.606.187-.886.748-.933l15.176-.886c.515-.047.748.28.748.886v13.81c0 .609-.093 1.122-.934 1.168l-14.523.84c-.842.047-1.215-.232-1.215-.98zm14.338-13.16c.093.422 0 .842-.422.89l-.699.139v10.264c-.608.327-1.168.513-1.635.513-.747 0-.934-.232-1.495-.932l-4.576-7.185v6.952l1.448.327s0 .84-1.169.84l-3.221.186c-.094-.187 0-.654.327-.747l.84-.232V9.853L7.832 9.76c-.093-.42.14-1.026.794-1.073l3.456-.232 4.763 7.279v-6.44l-1.214-.14c-.094-.513.28-.887.747-.933l3.223-.187z"
      />
    </svg>
  );
}
