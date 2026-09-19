import { describe, it, expect, vi, afterEach } from "vitest";
import { installPerformanceMeasureGuard } from "./performanceMeasureGuard";

describe("installPerformanceMeasureGuard", () => {
  const originalMeasure = performance.measure;

  afterEach(() => {
    (performance as unknown as { measure: typeof originalMeasure }).measure = originalMeasure;
    vi.restoreAllMocks();
  });

  it("retries without detail on DataCloneError and warns once per component", () => {
    const seen: Array<Record<string, unknown>> = [];
    (performance as unknown as { measure: unknown }).measure = vi.fn(
      (_name: string, opts?: Record<string, unknown>) => {
        seen.push(opts ?? {});
        if (opts && "detail" in opts) {
          throw new DOMException("Data cannot be cloned, out of memory", "DataCloneError");
        }
        return {} as PerformanceMeasure;
      },
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    installPerformanceMeasureGuard();
    const name = "\u200bTimeline";
    performance.measure(name, {
      start: 0,
      end: 1,
      detail: { devtools: { properties: [1, 2, 3] } },
    } as PerformanceMeasureOptions);

    expect(seen.length).toBe(2);
    expect(seen[1]).not.toHaveProperty("detail");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("Timeline");

    // Same component again: no duplicate warning.
    performance.measure(name, {
      start: 0,
      end: 1,
      detail: { devtools: { properties: [1] } },
    } as PerformanceMeasureOptions);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("passes through a successful measure untouched", () => {
    const measure = vi.fn(
      (_name: string, _opts?: PerformanceMeasureOptions) => ({}) as PerformanceMeasure,
    );
    (performance as unknown as { measure: unknown }).measure = measure;
    installPerformanceMeasureGuard();

    performance.measure("x", { start: 0, end: 1 });
    expect(measure).toHaveBeenCalledTimes(1);
    expect(measure.mock.calls[0]![1]).toMatchObject({ start: 0, end: 1 });
  });

  it("never throws out of measure when a non-clone failure occurs", () => {
    (performance as unknown as { measure: unknown }).measure = vi.fn(() => {
      throw new Error("boom");
    });
    installPerformanceMeasureGuard();
    expect(() => performance.measure("x", { start: 0, end: 1 })).not.toThrow();
  });
});
