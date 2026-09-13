import type { Toast } from "./useToaster";

export function Toaster({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number) => void }) {
  return (
    // Polite, so a screen reader hears confirmations without being cut off
    // mid-sentence by the next tick of the simulation.
    <div className="toaster" role="status" aria-live="polite">
      {toasts.map((t) => (
        <button
          key={t.id}
          type="button"
          className={`toast toast-${t.tone}`}
          onClick={() => dismiss(t.id)}
          title="Dismiss"
        >
          {t.message}
        </button>
      ))}
    </div>
  );
}
