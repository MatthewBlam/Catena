import "./index.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ui/ErrorBoundary";
import { PLATFORM } from "./lib/platform";

// CSS has no way to ask what platform it is on, and the scrollbar rules in
// index.css must apply to Windows only. Stamped before the first render so the
// styling is in place for the first paint rather than a frame late.
if (PLATFORM) document.documentElement.dataset.platform = PLATFORM;

// A rejected promise with no local `.catch` (an IPC call that throws in an event
// handler, say) otherwise vanishes silently. Log it so it is at least
// diagnosable rather than a phantom no-op.
window.addEventListener("unhandledrejection", (event) => {
  console.error("Unhandled promise rejection:", event.reason);
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
