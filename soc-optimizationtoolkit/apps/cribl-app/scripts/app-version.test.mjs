// Pins for the version the LIVE PREVIEW footer reports.
//
// The behaviour these guard was verified live on 2026-08-27: with the dev
// server already running, package.json was bumped to a sentinel and the served
// HTML carried the sentinel on the very next request; restoring the file
// restored the real version. So the preview tracks the running code rather
// than the value frozen when the server booted.
//
// What is NOT self-evident, and is what these pins are really for, is the
// failure branch. Every one of these inputs must produce null so the caller
// SKIPS the injection - because the footer resolves
// `window.__APP_VERSION_RUNTIME__ ?? __APP_VERSION__`, and `??` only catches
// null and undefined. Anything else that gets injected wins over the
// build-time define and is rendered verbatim.

import { describe, expect, it } from "vitest";
import { appVersionFrom } from "./app-version.mjs";

describe("appVersionFrom", () => {
  it("returns the version from a normal package.json", () => {
    expect(appVersionFrom('{"name":"soc-optimizationtoolkit","version":"1.12.3"}')).toBe(
      "1.12.3",
    );
  });

  it("returns null for unparseable JSON instead of throwing", () => {
    // It runs inside a Vite hook on EVERY request; a throw there would break
    // the page rather than the version string.
    expect(appVersionFrom("{ not json")).toBeNull();
    expect(appVersionFrom("")).toBeNull();
  });

  it("returns null when there is no version field", () => {
    expect(appVersionFrom('{"name":"x"}')).toBeNull();
  });

  it("returns null for a NON-STRING version", () => {
    // The one that renders wrong rather than failing: `?? ` passes 42
    // straight through and the footer reads "v42".
    expect(appVersionFrom('{"version":42}')).toBeNull();
    expect(appVersionFrom('{"version":null}')).toBeNull();
    expect(appVersionFrom('{"version":{"major":1}}')).toBeNull();
  });

  it("returns null for a blank version", () => {
    // `""` is not null, so `??` keeps it and the footer renders a bare "v".
    expect(appVersionFrom('{"version":""}')).toBeNull();
    expect(appVersionFrom('{"version":"   "}')).toBeNull();
  });

  it("returns null for JSON that is not an object", () => {
    expect(appVersionFrom('"1.2.3"')).toBeNull();
    expect(appVersionFrom("[1,2,3]")).toBeNull();
    expect(appVersionFrom("null")).toBeNull();
  });

  it("keeps prerelease and build metadata verbatim", () => {
    // The packaging script only ever writes x.y.z, but a hand-edited version
    // must not be silently normalised - the footer's job is to report what is
    // actually running.
    expect(appVersionFrom('{"version":"1.12.3-rc.1+build.5"}')).toBe("1.12.3-rc.1+build.5");
  });
});
