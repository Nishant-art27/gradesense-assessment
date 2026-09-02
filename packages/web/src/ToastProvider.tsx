import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

/**
 * Transient confirmations, so an edit that persisted silently still shows
 * feedback.
 *
 * This is a context rather than a prop because `SetupWizard` used to receive
 * `toast` and `onError` through its props purely so it could reach the stack in
 * `App` — the first thing that breaks when a component moves.
 */

export type ToastTone = 'ok' | 'err';

interface Toast {
  id: number;
  text: string;
  tone: ToastTone;
}

const ToastContext = createContext<((text: string, tone?: ToastTone) => void) | null>(null);

const DISMISS_AFTER = 2600;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  // The old implementation left its timeouts running past unmount.
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const toast = useCallback((text: string, tone: ToastTone = 'ok') => {
    const id = (seq.current += 1);
    setToasts((current) => [...current, { id, text, tone }]);
    timers.current.push(
      setTimeout(() => setToasts((current) => current.filter((entry) => entry.id !== id)), DISMISS_AFTER),
    );
  }, []);

  const value = useMemo(() => toast, [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((entry) => (
          <div key={entry.id} className={entry.tone === 'ok' ? 'toast' : 'toast toast--err'}>
            <span className="toast__glyph" aria-hidden="true">
              {entry.tone === 'ok' ? '✓' : '!'}
            </span>
            {entry.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): (text: string, tone?: ToastTone) => void {
  const toast = useContext(ToastContext);
  if (!toast) throw new Error('useToast must be used inside a ToastProvider.');
  return toast;
}
