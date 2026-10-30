import { describe, expect, it } from "vitest";
import { openWhen } from "./open-when";

describe("openWhen", () => {
  it("is true or undefined, never false - false would lock the disclosure under React's control", () => {
    expect(openWhen(true)).toBe(true);
    expect(openWhen(false)).toBeUndefined();
  });
});
