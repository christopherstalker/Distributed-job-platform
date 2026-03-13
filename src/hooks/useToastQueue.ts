import { useCallback, useEffect, useRef, useState } from "react";

import type { Toast } from "../lib/models";
import { createToastId } from "../lib/safe";

export type ToastInput = Omit<Toast, "id"> & {
  key?: string;
  cooldownMs?: number;
  durationMs?: number;
};

export function useToastQueue() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<Record<string, number>>({});
  const activeKeys = useRef<Record<string, string>>({});
  const keyById = useRef<Record<string, string>>({});
  const lastShownAt = useRef<Record<string, number>>({});

  const dismissToast = useCallback((toastId: string) => {
    const timer = timers.current[toastId];
    if (timer) {
      window.clearTimeout(timer);
      delete timers.current[toastId];
    }

    const key = keyById.current[toastId];
    if (key) {
      delete activeKeys.current[key];
      delete keyById.current[toastId];
    }

    setToasts((current) => current.filter((toast) => toast.id !== toastId));
  }, []);

  const enqueueToast = useCallback((toast: ToastInput) => {
    const key = toast.key ?? `${toast.tone}:${toast.title}:${toast.description ?? ""}`;
    const activeId = activeKeys.current[key];
    const now = Date.now();
    const cooldownMs = toast.cooldownMs ?? 10_000;

    if (activeId) {
      return activeId;
    }

    if (lastShownAt.current[key] && now - lastShownAt.current[key] < cooldownMs) {
      return null;
    }

    const id = createToastId();
    const durationMs = toast.durationMs ?? 4_200;
    const nextToast: Toast = {
      id,
      title: toast.title,
      description: toast.description,
      tone: toast.tone,
    };

    activeKeys.current[key] = id;
    keyById.current[id] = key;
    lastShownAt.current[key] = now;

    setToasts((current) => [nextToast, ...current].slice(0, 5));
    timers.current[id] = window.setTimeout(() => dismissToast(id), durationMs);

    return id;
  }, [dismissToast]);

  useEffect(() => {
    return () => {
      Object.values(timers.current).forEach((timer) => window.clearTimeout(timer));
    };
  }, []);

  return {
    toasts,
    enqueueToast,
    dismissToast,
  };
}
