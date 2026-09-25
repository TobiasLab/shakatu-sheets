import { invoke } from "@tauri-apps/api/core";
import type { QuantityExampleInput, QuantityLearning } from "../recognition/quantityLearning";

export type LearningOperation =
    | { kind: "load" }
    | { kind: "settings"; enabled: boolean; autoAllow: boolean }
    | { kind: "save"; example: QuantityExampleInput }
    | { kind: "delete"; id: string }
    | { kind: "reset" };

let queue: Promise<unknown> = Promise.resolve();
export function quantityLearning(operation: LearningOperation): Promise<QuantityLearning> {
    const result = queue.then(() => invoke<QuantityLearning>("quantity_learning", { operation }));
    queue = result.catch(() => undefined);
    return result;
}
