import { useCallback, useEffect, useRef, useState } from "react";

export type ToastTone = "info" | "good" | "warn" | "bad";

export interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
}

const VISIBLE_MS = 4200;
/** Rapid clicking should not bury the map under a column of toasts. Older
 *  ones drop off; each still names what happened while it is up. */
const MAX_VISIBLE = 3;

/**
 * Confirmation that a control did something.
 *
 * The scenario buttons were working all along, but a new vehicle is one dot
 * among twenty-six and an injected hazard appears on a road you have to hunt
 * for — so the honest impression was that nothing happened. A toast that
 * names the affected road or vehicle closes that gap.
 */
export function useToaster() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((t) => window.clearTimeout(t));
  }, []);

  const push = useCallback((message: string, tone: ToastTone = "info") => {
    const id = nextId.current++;
    setToasts((current) => [...current, { id, message, tone }].slice(-MAX_VISIBLE));
    timers.current.push(
      window.setTimeout(
        () => setToasts((current) => current.filter((t) => t.id !== id)),
        VISIBLE_MS,
      ),
    );
  }, []);

  const dismiss = useCallback(
    (id: number) => setToasts((current) => current.filter((t) => t.id !== id)),
    [],
  );

  return { toasts, push, dismiss };
}
