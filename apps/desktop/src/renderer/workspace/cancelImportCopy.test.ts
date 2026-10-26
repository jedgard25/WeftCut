import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc", () => ({
  importCancel: vi.fn(),
  setMediaExternal: vi.fn().mockResolvedValue(undefined),
}));

import { importCancel, setMediaExternal } from "../ipc";
import { cancelImportCopy } from "./cancelImportCopy";

afterEach(() => vi.clearAllMocks());

describe("cancelImportCopy", () => {
  it("marks the item external once the copy is cancelled", async () => {
    vi.mocked(importCancel).mockResolvedValue(true);
    await cancelImportCopy("m1");
    expect(setMediaExternal).toHaveBeenCalledExactlyOnceWith("m1", true);
  });

  it("leaves the item alone when there was no copy to cancel", async () => {
    vi.mocked(importCancel).mockResolvedValue(false);
    await cancelImportCopy("m1");
    expect(setMediaExternal).not.toHaveBeenCalled();
  });

  it("does not mark anything when the cancel itself fails", async () => {
    vi.mocked(importCancel).mockRejectedValue(new Error("gone"));
    await cancelImportCopy("m1");
    expect(setMediaExternal).not.toHaveBeenCalled();
  });
});
