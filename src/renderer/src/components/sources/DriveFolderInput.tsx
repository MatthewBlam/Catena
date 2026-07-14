import { useState } from "react";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";

interface DriveFolderInputProps {
  onSubmit: (folderId: string, folderName: string) => void;
  onCancel: () => void;
}

function extractFolderIdFromUrl(url: string): string | null {
  const match = url.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  return match?.[1] ?? null;
}

export function DriveFolderInput({
  onSubmit,
  onCancel,
}: DriveFolderInputProps): React.JSX.Element {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(): void {
    const folderId = extractFolderIdFromUrl(url.trim());
    if (!folderId) {
      setError(
        "Could not extract a folder ID. Paste a Google Drive folder URL.",
      );
      return;
    }
    const folderName = name.trim() || "Drive folder";
    onSubmit(folderId, folderName);
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <label
          htmlFor="drive-source-name"
          className="text-sm font-medium text-foreground"
        >
          Source name
        </label>
        <Input
          id="drive-source-name"
          placeholder="e.g. Club Drive"
          value={name}
          onChange={(e) => setName((e.target as HTMLInputElement).value)}
        />
      </div>
      <div className="space-y-1.5">
        <label
          htmlFor="drive-folder-url"
          className="text-sm font-medium text-foreground"
        >
          Drive folder URL
        </label>
        <Input
          id="drive-folder-url"
          placeholder="https://drive.google.com/drive/folders/..."
          value={url}
          onChange={(e) => {
            setUrl((e.target as HTMLInputElement).value);
            setError(null);
          }}
        />
        <p className="text-xs text-muted-foreground">
          Paste the URL of the folder you want to sync. All subfolders will be
          included.
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive-foreground">
          {error}
        </p>
      )}
      <div className="flex gap-2 justify-end">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" onClick={handleSubmit} disabled={!url.trim()}>
          Add source
        </Button>
      </div>
    </div>
  );
}
