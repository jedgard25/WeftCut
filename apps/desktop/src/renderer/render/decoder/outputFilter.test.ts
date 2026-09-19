import { describe, it, expect } from "vitest";
import { shouldDropPrefixOutput } from "./outputFilter";

describe("shouldDropPrefixOutput", () => {
  it("drops a GOP-prefix frame ending before the target", () => {
    // 30 fps grid: prefix frame [0, 33333) against a target 10 frames in.
    expect(shouldDropPrefixOutput(0, 33333, 333330)).toBe(true);
  });

  it("keeps the frame covering the target", () => {
    expect(shouldDropPrefixOutput(333330 - 1000, 33333, 333330)).toBe(false);
  });

  it("keeps frames ahead of the target (paused lookahead fill)", () => {
    expect(shouldDropPrefixOutput(500000, 33333, 333330)).toBe(false);
  });

  it("keeps a frame ending exactly at the target (EOS-tail safety)", () => {
    expect(shouldDropPrefixOutput(300000, 33330, 333330)).toBe(false);
  });

  it("never drops when duration is unknown (null → 0)", () => {
    expect(shouldDropPrefixOutput(0, 0, 333330)).toBe(false);
    expect(shouldDropPrefixOutput(0, -1, 333330)).toBe(false);
  });
});
