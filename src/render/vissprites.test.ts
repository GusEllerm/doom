import { describe, it, expect } from "vitest";
import { MAXVISSPRITES } from "./vissprites.js";

describe("vissprites stub", () => {
  it("has vanilla MAXVISSPRITES", () => {
    expect(MAXVISSPRITES).toBe(128);
  });
});
