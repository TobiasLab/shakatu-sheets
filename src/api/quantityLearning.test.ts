import { expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { quantityLearning } from "./quantityLearning";

it("orders mutations after in-flight saves and continues after failure", async () => {
    let reject!: (reason: Error) => void;
    invoke
        .mockImplementationOnce(
            () =>
                new Promise((_, fail) => {
                    reject = fail;
                }),
        )
        .mockResolvedValueOnce({ enabled: false, autoAllow: false, examples: [] });
    const first = quantityLearning({ kind: "settings", enabled: true, autoAllow: false });
    const reset = quantityLearning({ kind: "reset" });
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledTimes(1);
    reject(new Error("Storage unavailable"));
    await expect(first).rejects.toThrow("Storage unavailable");
    await expect(reset).resolves.toEqual({ enabled: false, autoAllow: false, examples: [] });
    expect(invoke.mock.calls[1]).toEqual(["quantity_learning", { operation: { kind: "reset" } }]);
});
