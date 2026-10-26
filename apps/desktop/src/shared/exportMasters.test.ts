import { describe, expect, it } from "vitest";
import { buildsMastersOnImport, isExportMasters } from "./exportMasters";

describe("buildsMastersOnImport", () => {
  it("auto builds only when the native export decoder is unavailable", () => {
    expect(buildsMastersOnImport("auto", true)).toBe(false);
    expect(buildsMastersOnImport("auto", false)).toBe(true);
  });

  it("on_import and on_demand ignore decoder availability", () => {
    for (const native of [true, false]) {
      expect(buildsMastersOnImport("on_import", native)).toBe(true);
      expect(buildsMastersOnImport("on_demand", native)).toBe(false);
    }
  });

  it("recognises only the three values", () => {
    expect(isExportMasters("auto")).toBe(true);
    expect(isExportMasters(true)).toBe(false);
    expect(isExportMasters("always")).toBe(false);
  });
});
