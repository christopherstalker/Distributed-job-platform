import { renderHook, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useToastQueue } from "./useToastQueue";

describe("useToastQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("deduplicates active toasts and respects cooldown windows", () => {
    const { result } = renderHook(() => useToastQueue());

    act(() => {
      result.current.enqueueToast({
        key: "connection-lost",
        tone: "warning",
        title: "Connection degraded",
        cooldownMs: 10_000,
      });
      result.current.enqueueToast({
        key: "connection-lost",
        tone: "warning",
        title: "Connection degraded",
        cooldownMs: 10_000,
      });
    });

    expect(result.current.toasts).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(4_200);
    });

    expect(result.current.toasts).toHaveLength(0);

    act(() => {
      result.current.enqueueToast({
        key: "connection-lost",
        tone: "warning",
        title: "Connection degraded",
        cooldownMs: 10_000,
      });
    });

    expect(result.current.toasts).toHaveLength(0);

    act(() => {
      vi.advanceTimersByTime(10_001);
      result.current.enqueueToast({
        key: "connection-lost",
        tone: "warning",
        title: "Connection degraded",
        cooldownMs: 10_000,
      });
    });

    expect(result.current.toasts).toHaveLength(1);
  });
});
