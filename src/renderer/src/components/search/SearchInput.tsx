import { SearchIcon } from "lucide-react";
import { Input } from "@renderer/components/ui/input";
import { Spinner } from "@renderer/components/ui/spinner";

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  loading: boolean;
}

export function SearchInput({
  value,
  onChange,
  onSubmit,
  loading,
}: SearchInputProps): React.JSX.Element {
  return (
    <div className="relative">
      <div className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-muted-foreground">
        {loading ? (
          <Spinner className="size-4" />
        ) : (
          <SearchIcon className="size-4" />
        )}
      </div>
      <Input
        type="search"
        placeholder="Ask a question..."
        aria-label="Search your documents"
        value={value}
        onChange={(e) => onChange((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && value.trim() && !loading) onSubmit();
        }}
        className="[&_[data-slot=input]]:pl-9"
        size="lg"
        autoFocus
      />
    </div>
  );
}
