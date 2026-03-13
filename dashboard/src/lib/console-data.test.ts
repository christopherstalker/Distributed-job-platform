import { describe, expect, it } from "vitest";

import { createDemoConsoleData, stabilizeConsoleData } from "./console-data";

describe("stabilizeConsoleData", () => {
  it("reuses unchanged collections across live refreshes", () => {
    const previous = createDemoConsoleData();
    const next = clone(previous);
    next.lastHydratedAt = "2026-03-12T22:10:00Z";

    const stabilized = stabilizeConsoleData(previous, next);

    expect(stabilized.jobs).toBe(previous.jobs);
    expect(stabilized.events).toBe(previous.events);
    expect(stabilized.snapshot).toBe(previous.snapshot);
    expect(stabilized.snapshot.workers).toBe(previous.snapshot.workers);
  });

  it("preserves unchanged items when only one job changes", () => {
    const previous = createDemoConsoleData();
    const next = clone(previous);
    const [firstJob, ...rest] = next.jobs;

    next.jobs = [
      {
        ...firstJob,
        state: "failed",
        updatedAt: "2026-03-12T22:11:00Z",
      },
      ...rest,
    ];

    const stabilized = stabilizeConsoleData(previous, next);

    expect(stabilized.jobs).not.toBe(previous.jobs);
    expect(stabilized.jobs[0]).not.toBe(previous.jobs[0]);
    expect(stabilized.jobs[1]).toBe(previous.jobs[1]);
  });
});

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
