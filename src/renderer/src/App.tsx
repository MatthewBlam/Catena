import { useEffect, useState, useCallback, useRef } from "react";
import { SearchIcon, FolderSyncIcon, SettingsIcon } from "lucide-react";
import { OnboardingWizard } from "@renderer/components/setup/OnboardingWizard";
import { SearchPage } from "@renderer/pages/SearchPage";
import { SourcesPage } from "@renderer/pages/SourcesPage";
import { SettingsPage } from "@renderer/pages/SettingsPage";
import { ErrorBoundary } from "@renderer/components/ui/ErrorBoundary";
import { Spinner } from "@renderer/components/ui/spinner";
import { cn } from "@renderer/lib/utils";

function DragRegion({ className }: { className?: string }): React.JSX.Element {
  const rafRef = useRef(0);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    window.electronDrag.startDrag();

    const onMove = (): void => {
      if (rafRef.current) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        window.electronDrag.dragging();
      });
    };
    const onUp = (): void => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
      el.releasePointerCapture(e.pointerId);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("lostpointercapture", onUp);
      window.electronDrag.stopDrag();
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("lostpointercapture", onUp);
  }, []);

  return <div className={className} onPointerDown={handlePointerDown} />;
}

type Page = "search" | "sources" | "settings";

const NAV_ITEMS: { id: Page; label: string; icon: typeof SearchIcon }[] = [
  { id: "search", label: "Search", icon: SearchIcon },
  { id: "sources", label: "Sources", icon: FolderSyncIcon },
  { id: "settings", label: "Settings", icon: SettingsIcon },
];

function getInitialDark(): boolean {
  const stored = localStorage.getItem("commons-theme");
  if (stored) return stored === "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function App(): React.JSX.Element {
  const [ready, setReady] = useState<boolean | null>(null);
  const [page, setPage] = useState<Page>("search");
  const [dark, setDark] = useState(getInitialDark);
  const [visited, setVisited] = useState<Set<Page>>(() => new Set(["search"]));

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("commons-theme", dark ? "dark" : "light");
  }, [dark]);

  const checkReady = useCallback((): void => {
    window.api
      .getEmbeddingProvider()
      .then(async (provider) => {
        if (provider === "ollama") {
          setReady(true);
          return;
        }
        const key = await window.api.loadSecret("cohere_api_key");
        const isReady = key !== null;
        setReady(isReady);
        if (!isReady) setVisited(new Set(["search"]));
      })
      .catch((err) => {
        console.error("Failed to check embedding provider:", err);
        setReady(false);
        setVisited(new Set(["search"]));
      });
  }, []);

  useEffect(() => {
    checkReady();
  }, [checkReady]);

  const handleToggleTheme = useCallback(() => setDark((d) => !d), []);

  const handleProviderReset = useCallback(() => {
    checkReady();
  }, [checkReady]);

  const handlePageChange = useCallback((p: Page) => {
    setPage(p);
    setVisited((prev) => {
      if (prev.has(p)) return prev;
      const next = new Set(prev);
      next.add(p);
      return next;
    });
  }, []);

  if (ready === null)
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <DragRegion className="absolute inset-x-0 top-0 h-10" />
        <Spinner className="size-6 text-muted-foreground" />
      </div>
    );

  if (!ready) {
    return (
      <div className="h-screen bg-background">
        <DragRegion className="absolute inset-x-0 top-0 h-10" />
        <OnboardingWizard
          onComplete={() => {
            setReady(true);
            setPage("search");
          }}
        />
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-background">
      <div className="w-54 shrink-0 p-3 flex flex-col">
        <nav className="h-full bg-sidebar rounded-xl p-2 flex flex-col border border-border">
          <DragRegion className="h-8 shrink-0" />
          <div className="flex-1 space-y-0.5">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => handlePageChange(item.id)}
                className={cn(
                  "w-full flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/24",
                  page === item.id
                    ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                    : "text-sidebar-foreground hover:bg-sidebar-accent/50",
                )}
              >
                <item.icon className="size-4 opacity-60" />
                {item.label}
              </button>
            ))}
          </div>
          <div className="flex items-center justify-center gap-1 pb-2">
            <svg
              viewBox="0 0 5000 5000"
              fill="currentColor"
              className="ml-[-5.5px] size-8 shrink-0 text-sidebar-primary"
            >
              <path d="M2815.7,4021c43.8,30.2,88.8,59.1,135,86.5c14.5,8.6,11.1,33-5,36.3c-160.4,33.4-325.6,50.3-493.9,50.3 c-274.2,0-540.2-44.8-790.5-133.1c-241.8-85.3-459-207.5-645.6-363.1c-186.6-155.6-333.1-336.8-435.3-538.6 c-105.8-208.8-159.5-430.6-159.5-659.4s53.7-450.6,159.5-659.4c102.3-201.7,248.7-382.9,435.3-538.6 c186.6-155.6,403.8-277.8,645.6-363.1c250.3-88.3,516.2-133.1,790.5-133.1c169.5,0,335.9,17.1,497.3,51c16.2,3.4,19.5,27.7,5,36.4 c-108.1,64-210,135.9-305.1,215.1c-216.9,180.9-387.1,391.5-506.1,626.1c-123.2,243-185.7,501-185.7,766.9s62.4,523.9,185.7,766.9 c118.9,234.6,289.2,445.3,506.1,626.2C2702.4,3939,2758,3981.2,2815.7,4021z" />
              <path d="M4579.2,2500c0,228.8-53.7,450.6-159.5,659.4c-102.3,201.7-248.7,382.9-435.3,538.6c-74.7,62.3-154.3,119.3-238.5,170.6 c-74.5,45.5-152.6,86.6-234,123.2c-20.3,9.1-42.9,9.1-63.2,0c-172-77.6-329.3-175.6-469.3-292.4 c-186.6-155.6-333.1-336.8-435.3-538.6c-105.8-208.8-159.5-430.6-159.5-659.4c0-228.8,53.7-450.6,159.5-659.4 c102.3-201.7,248.7-382.9,435.3-538.5c74.7-62.3,154.3-119.3,238.5-170.6c74.5-45.5,152.6-86.6,234-123.2c20.3-9.1,42.9-9.1,63.2,0 c172,77.6,329.3,175.6,469.3,292.4c186.6,155.6,333.1,336.8,435.3,538.6C4525.5,2049.4,4579.2,2271.2,4579.2,2500z" />
            </svg>
            <span className="text-xl font-black text-sidebar-primary">
              COMMONS
            </span>
          </div>
        </nav>
      </div>

      <div className="flex flex-1 flex-col min-w-0">
        <DragRegion className="h-10 shrink-0" />
        <main className="flex-1 min-h-0 overflow-y-auto pr-3">
          <ErrorBoundary>
            <div style={{ display: page === "search" ? undefined : "none" }}>
              <SearchPage visible={page === "search"} />
            </div>
          </ErrorBoundary>
          {visited.has("sources") && (
            <ErrorBoundary>
              <div style={{ display: page === "sources" ? undefined : "none" }}>
                <SourcesPage visible={page === "sources"} />
              </div>
            </ErrorBoundary>
          )}
          {visited.has("settings") && (
            <ErrorBoundary>
              <div
                style={{ display: page === "settings" ? undefined : "none" }}
              >
                <SettingsPage
                  visible={page === "settings"}
                  dark={dark}
                  onToggleTheme={handleToggleTheme}
                  onProviderReset={handleProviderReset}
                />
              </div>
            </ErrorBoundary>
          )}
        </main>
      </div>
    </div>
  );
}

export default App;
