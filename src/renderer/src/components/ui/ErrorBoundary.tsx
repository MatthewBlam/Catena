import { Component } from "react";
import type { ReactNode, ErrorInfo } from "react";
import { Button } from "./button";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  // When any value in this array changes, a boundary that is currently showing
  // its error state clears it and re-renders `children`. Pass the identity of
  // whatever the subtree depends on (e.g. the current page) so navigating away
  // from a broken screen recovers instead of staying stuck on the fallback.
  resetKeys?: unknown[];
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface State {
  error: Error | null;
}

function keysChanged(
  a: unknown[] | undefined,
  b: unknown[] | undefined,
): boolean {
  if (a === b) return false;
  if (!a || !b || a.length !== b.length) return true;
  return a.some((val, i) => !Object.is(val, b[i]));
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("ErrorBoundary caught:", error, info.componentStack);
    this.props.onError?.(error, info);
  }

  componentDidUpdate(prev: Props): void {
    // A deterministic render error would re-throw the instant we cleared it, so
    // we only auto-reset when the caller signals the underlying inputs changed.
    if (this.state.error && keysChanged(prev.resetKeys, this.props.resetKeys)) {
      this.setState({ error: null });
    }
  }

  render(): ReactNode {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
          <h2 className="text-lg font-semibold text-foreground">
            Something went wrong
          </h2>
          <p className="text-sm text-muted-foreground max-w-md">
            {this.state.error.message}
          </p>
          <Button size="sm" onClick={() => this.setState({ error: null })}>
            Try again
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}
