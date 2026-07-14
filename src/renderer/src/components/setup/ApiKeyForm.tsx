import { useState } from "react";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";

interface ApiKeyFormProps {
  onSuccess: () => void;
}

export function ApiKeyForm({ onSuccess }: ApiKeyFormProps): React.JSX.Element {
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState<
    "idle" | "validating" | "valid" | "invalid"
  >("idle");

  async function handleValidate(): Promise<void> {
    if (!apiKey.trim()) return;
    setStatus("validating");
    try {
      const result = await window.api.validateCohereKey(apiKey.trim());
      if (result.valid) {
        await window.api.saveSecret("cohere_api_key", apiKey.trim());
        await window.api.setEmbeddingProvider("cohere");
        setStatus("valid");
        onSuccess();
      } else {
        setStatus("invalid");
      }
    } catch {
      setStatus("invalid");
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <label htmlFor="cohere-key" className="text-sm font-medium">
          Cohere API Key
        </label>
        <Input
          id="cohere-key"
          type="password"
          placeholder="Paste your API key..."
          value={apiKey}
          onChange={(e) => {
            setApiKey(e.target.value);
            if (status === "invalid") setStatus("idle");
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleValidate();
          }}
        />
      </div>
      {status === "invalid" && (
        <p className="text-sm text-destructive-foreground">
          Invalid API key. Check your key and try again.
        </p>
      )}
      {status === "valid" && (
        <p className="text-sm text-success-foreground">
          API key validated successfully.
        </p>
      )}
      <Button
        onClick={handleValidate}
        loading={status === "validating"}
        disabled={!apiKey.trim()}
        className="w-full"
      >
        Validate & Save
      </Button>
      <p className="text-xs text-muted-foreground">
        Get a free API key at{" "}
        <button
          type="button"
          className="underline underline-offset-2 hover:text-foreground"
          onClick={() =>
            window.api.openExternal("https://dashboard.cohere.com/api-keys")
          }
        >
          dashboard.cohere.com
        </button>
      </p>
    </div>
  );
}
