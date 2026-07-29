import { useCallback, useEffect, useRef, useState } from "react";
import { toErrorMessage } from "@renderer/lib/errors";
import type { OllamaProgress } from "../../../shared/types";

export interface OllamaJob {
  /** Latest progress event, or null before a run starts. */
  progress: OllamaProgress | null;
  running: boolean;
  error: string | null;
  /**
   * Starts a managed job (`window.api.ollamaSetup` or `pullOllamaChatModel`).
   * `onDone` fires only on genuine success (`phase: "ready"` / clean resolve),
   * not on cancel. A no-op if a job is already running.
   */
  start: (invoke: () => Promise<void>, onDone?: () => void) => void;
  cancel: () => void;
}

/**
 * Drives a managed-Ollama job and its progress stream. Owns the `onOllamaProgress`
 * subscription for the job's lifetime, distinguishes a user cancel from a real
 * failure (cancel rejects the invoke but must not surface as an error), and
 * cleans up on unmount.
 */
export function useOllamaSetup(): OllamaJob {
  const [progress, setProgress] = useState<OllamaProgress | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runningRef = useRef(false);
  const cancelledRef = useRef(false);
  const unsubRef = useRef<(() => void) | null>(null);

  // Belt-and-suspenders: drop the subscription if the component unmounts mid-run.
  useEffect(() => {
    return () => unsubRef.current?.();
  }, []);

  const start = useCallback(
    (invoke: () => Promise<void>, onDone?: () => void) => {
      if (runningRef.current) return;
      runningRef.current = true;
      cancelledRef.current = false;
      setRunning(true);
      setError(null);
      setProgress({ phase: "checking" });

      const unsub = window.api.onOllamaProgress((p) => {
        setProgress(p);
        if (p.phase === "error" && p.error) setError(p.error);
      });
      unsubRef.current = unsub;

      invoke()
        .then(() => {
          if (!cancelledRef.current) onDone?.();
        })
        .catch((err) => {
          // A cancel rejects the invoke too; that isn't an error to show.
          if (!cancelledRef.current) {
            setError(toErrorMessage(err, "Ollama setup failed."));
          }
        })
        .finally(() => {
          unsub();
          unsubRef.current = null;
          runningRef.current = false;
          setRunning(false);
        });
    },
    [],
  );

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    void window.api.cancelOllamaSetup();
    setProgress(null);
  }, []);

  return { progress, running, error, start, cancel };
}
