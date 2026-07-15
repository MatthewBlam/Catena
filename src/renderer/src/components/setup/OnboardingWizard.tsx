import { useState } from "react";
import { Button } from "@renderer/components/ui/button";
import { ErrorBanner } from "@renderer/components/ui/error-banner";
import { ApiKeyForm } from "@renderer/components/setup/ApiKeyForm";
import { OllamaOption } from "@renderer/components/setup/OllamaOption";
import { ConnectNotionButton } from "@renderer/components/sources/ConnectNotionButton";
import { ConnectDriveButton } from "@renderer/components/sources/ConnectDriveButton";
import { SourceList } from "@renderer/components/sources/SourceList";
import type { SourceWithCount } from "../../../../shared/types";

interface OnboardingWizardProps {
  onComplete: () => void;
}

type Step = "welcome" | "provider" | "sources" | "done";
const STEPS: Step[] = ["welcome", "provider", "sources", "done"];

function StepIndicator({ current }: { current: Step }): React.JSX.Element {
  const idx = STEPS.indexOf(current);
  return (
    <div className="flex items-center gap-1.5">
      {STEPS.map((step, i) => (
        <div
          key={step}
          className={`size-1.5 rounded-full transition-colors ${i <= idx ? "bg-primary" : "bg-muted"}`}
        />
      ))}
    </div>
  );
}

export function OnboardingWizard({
  onComplete,
}: OnboardingWizardProps): React.JSX.Element {
  const [step, setStep] = useState<Step>("welcome");
  const [providerMode, setProviderMode] = useState<
    "choose" | "cohere" | "ollama"
  >("choose");
  const [sources, setSources] = useState<SourceWithCount[]>([]);
  const [sourceError, setSourceError] = useState<string | null>(null);

  function loadSources(): void {
    setSourceError(null);
    window.api
      .listSources()
      .then(setSources)
      .catch(() => setSourceError("Failed to load sources."));
  }

  function goToSources(): void {
    setStep("sources");
    loadSources();
  }

  async function handleFinish(): Promise<void> {
    // Persist before handing control back so a relaunch doesn't drop the user
    // back into the wizard. Non-fatal on failure: worst case the wizard
    // reappears next launch, which is strictly better than blocking entry.
    try {
      await window.api.setOnboardingComplete();
    } catch {
      // ignore — see above
    }
    onComplete();
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-8">
      <div className="w-full max-w-md space-y-6">
        <StepIndicator current={step} />

        {step === "welcome" && (
          <div className="space-y-4">
            <div>
              <h1 className="text-2xl font-semibold">Welcome to Commons</h1>
              <p className="text-muted-foreground mt-1">
                Search your club&apos;s docs — Notion pages, Google Drive files,
                all in one place.
              </p>
            </div>
            <p className="text-sm text-muted-foreground">
              We&apos;ll get you set up in a few quick steps.
            </p>
            <Button onClick={() => setStep("provider")} className="w-full">
              Get started
            </Button>
          </div>
        )}

        {step === "provider" && (
          <div className="space-y-4">
            <div>
              <h2 className="text-xl font-semibold">
                Choose an embedding provider
              </h2>
              <p className="text-muted-foreground text-sm mt-1">
                Commons needs an embedding provider to search your docs.
              </p>
            </div>

            {providerMode === "choose" && (
              <div className="space-y-3">
                <div className="space-y-2">
                  <Button
                    onClick={() => setProviderMode("cohere")}
                    className="w-full"
                  >
                    Use Cohere API
                  </Button>
                  <p className="text-xs text-muted-foreground text-center">
                    Cloud-based, high quality. Free tier available.
                  </p>
                </div>
                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <span className="w-full border-t" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-background px-2 text-muted-foreground">
                      or
                    </span>
                  </div>
                </div>
                <div className="space-y-2">
                  <Button
                    variant="outline"
                    onClick={() => setProviderMode("ollama")}
                    className="w-full"
                  >
                    Use Ollama (Local)
                  </Button>
                  <p className="text-xs text-muted-foreground text-center">
                    Runs on your machine. No API key needed.
                  </p>
                </div>
              </div>
            )}

            {providerMode === "cohere" && (
              <div className="space-y-3">
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => setProviderMode("choose")}
                >
                  &larr; Back
                </Button>
                <ApiKeyForm onSuccess={goToSources} />
              </div>
            )}

            {providerMode === "ollama" && (
              <div className="space-y-3">
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => setProviderMode("choose")}
                >
                  &larr; Back
                </Button>
                <OllamaOption onSuccess={goToSources} />
              </div>
            )}
          </div>
        )}

        {step === "sources" && (
          <div className="space-y-4">
            <div>
              <h2 className="text-xl font-semibold">Connect your docs</h2>
              <p className="text-muted-foreground text-sm mt-1">
                Add at least one source to start searching.
              </p>
            </div>

            <div className="space-y-2">
              <ConnectNotionButton onSourceAdded={loadSources} />
              <ConnectDriveButton onSourceAdded={loadSources} />
            </div>

            {sourceError && (
              <ErrorBanner variant="error">{sourceError}</ErrorBanner>
            )}

            {sources.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-xs font-medium text-muted-foreground">
                  Connected
                </h3>
                <SourceList sources={sources} onRefresh={loadSources} />
              </div>
            )}

            <div className="flex gap-2 pt-2">
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  setProviderMode("choose");
                  setStep("provider");
                }}
              >
                &larr; Back
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setStep("done")}
              >
                Skip for now
              </Button>
              {sources.length > 0 && (
                <Button size="sm" onClick={() => setStep("done")}>
                  Continue
                </Button>
              )}
            </div>
          </div>
        )}

        {step === "done" && (
          <div className="space-y-4">
            <div>
              <h2 className="text-xl font-semibold">You&apos;re all set!</h2>
              <p className="text-muted-foreground text-sm mt-1">
                {sources.length > 0
                  ? "Sync your sources, then search across all your docs."
                  : "You can connect sources later from the Sources tab."}
              </p>
            </div>
            <Button onClick={() => void handleFinish()} className="w-full">
              Start searching
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
