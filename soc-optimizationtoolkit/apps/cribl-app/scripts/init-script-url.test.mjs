// Pins for which Live Preview init script the dev server injects (DBT-146).
//
// The defect these guard: the first ?init= the dev server saw was injected
// into every later load, so a second browser (Edge after Chrome) booted with
// the first browser's session script and landed in the setup flow until the
// dev server restarted.

import { describe, expect, it } from "vitest";
import { initScriptUrlFor } from "./init-script-url.mjs";

const CHROME = "https://leader.example/app-ui/__local__/init.js?session=chrome";
const EDGE = "https://leader.example/app-ui/__local__/init.js?session=edge";

describe("initScriptUrlFor", () => {
  it("injects the request's own init script, not the one remembered from another browser", () => {
    expect(initScriptUrlFor(EDGE, CHROME)).toBe(EDGE);
  });

  it("falls back to the remembered init script when the load carries none", () => {
    expect(initScriptUrlFor(null, CHROME)).toBe(CHROME);
    expect(initScriptUrlFor("", CHROME)).toBe(CHROME);
  });

  it("is null when there is neither", () => {
    expect(initScriptUrlFor(null, null)).toBeNull();
  });
});
