import { describe, expect, it } from "vitest";

import { PackTree, PackTreeError } from "./pack-tree";

describe("PackTree", () => {
  it("stores and retrieves files, preserving insertion order", () => {
    const tree = new PackTree();
    tree.set("package.json", "{}").set("default/pack.yml", "x");
    expect(tree.get("package.json")).toBe("{}");
    expect(tree.has("default/pack.yml")).toBe(true);
    expect(tree.paths()).toEqual(["package.json", "default/pack.yml"]);
    expect(tree.size).toBe(2);
  });

  it("replaces content on re-set", () => {
    const tree = new PackTree().set("a", "1").set("a", "2");
    expect(tree.get("a")).toBe("2");
    expect(tree.size).toBe(1);
  });

  it("encodes string and binary content into tar entries", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const entries = new PackTree().set("t.txt", "hi").set("b.bin", bytes).toTarEntries();
    expect(entries[0].content).toBeInstanceOf(Uint8Array);
    expect([...entries[1].content]).toEqual([1, 2, 3]);
  });

  it("rejects unsafe paths", () => {
    const tree = new PackTree();
    expect(() => tree.set("", "x")).toThrow(PackTreeError);
    expect(() => tree.set("/abs", "x")).toThrow(PackTreeError);
    expect(() => tree.set("a\\b", "x")).toThrow(PackTreeError);
    expect(() => tree.set("../escape", "x")).toThrow(PackTreeError);
    expect(() => tree.set("a/./b", "x")).toThrow(PackTreeError);
  });
});
