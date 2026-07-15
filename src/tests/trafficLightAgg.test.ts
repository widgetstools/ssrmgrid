import { describe, expect, it } from "vitest";
import { foldTrafficLight, isTrafficLightAgg } from "../ssrm/trafficLightAgg";

describe("trafficLightAgg", () => {
  it("recognizes trafficLight and rag", () => {
    expect(isTrafficLightAgg("trafficLight")).toBe(true);
    expect(isTrafficLightAgg("rag")).toBe(true);
    expect(isTrafficLightAgg("min")).toBe(false);
  });

  it("folds min/max to RAG 1|2|3", () => {
    expect(foldTrafficLight(1, 1)).toBe(1);
    expect(foldTrafficLight(3, 3)).toBe(3);
    expect(foldTrafficLight(1, 3)).toBe(2);
    expect(foldTrafficLight(2, 2)).toBe(2);
    expect(foldTrafficLight(null, 1)).toBe(null);
  });
});
