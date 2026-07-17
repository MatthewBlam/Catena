import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Trailing-edge debounce: a call schedules `fn` to run `ms` after the most
 * recent call, so a burst collapses into one invocation carrying the last
 * call's arguments — the terminal event in a burst still lands. `cancel()`
 * drops a pending call without running it, for use in effect cleanups.
 */
export function debounce<Args extends unknown[]>(
  fn: (...args: Args) => void,
  ms: number,
): ((...args: Args) => void) & { cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const debounced = (...args: Args): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  };
  debounced.cancel = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return debounced;
}
