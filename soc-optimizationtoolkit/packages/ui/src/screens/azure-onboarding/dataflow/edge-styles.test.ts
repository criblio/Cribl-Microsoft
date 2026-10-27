import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * Cascade pin for the onboarding dataflow edge styles.
 *
 * check-classnames only proves a selector exists, not that it wins. Every
 * configures edge is rendered with BOTH is-configures and is-no-counter
 * (onboarding-dataflow.tsx builds `azo-flow-edge is-configures is-no-counter`),
 * so a configures rule that loses the cascade to the no-counter group makes a
 * step-to-target edge look exactly like an unmeasured data edge. This resolves
 * the winning declaration the way a browser would for top-level compound
 * class selectors: highest class count, then latest in the file.
 */

const css = readFileSync(resolve(__dirname, "../../../styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

interface Rule {
  selector: string;
  classes: string[];
  body: string;
  order: number;
}

function topLevelRules(text: string): Rule[] {
  const rules: Rule[] = [];
  let depth = 0;
  let start = 0;
  let order = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "{") {
      if (depth === 0) {
        const head = text.slice(start, i).trim();
        const close = text.indexOf("}", i);
        const inner = text.slice(i + 1, close);
        // Only plain rules at the top level; @media and friends are skipped.
        if (!head.startsWith("@") && !inner.includes("{")) {
          for (const sel of head.split(",").map((s) => s.trim())) {
            if (/^(\.[\w-]+)+$/.test(sel)) {
              rules.push({ selector: sel, classes: sel.slice(1).split("."), body: inner, order: order++ });
            }
          }
        }
      }
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) start = i + 1;
    }
  }
  return rules;
}

const RULES = topLevelRules(css);

function computed(classList: string[], property: string): string | undefined {
  const have = new Set(classList);
  let best: { spec: number; order: number; value: string } | undefined;
  for (const r of RULES) {
    if (!r.classes.every((c) => have.has(c))) continue;
    const m = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`).exec(r.body);
    if (!m) continue;
    const cand = { spec: r.classes.length, order: r.order, value: m[1].trim() };
    if (!best || cand.spec > best.spec || (cand.spec === best.spec && cand.order > best.order)) best = cand;
  }
  return best?.value;
}

const CONFIGURES = ["azo-flow-edge", "is-configures", "is-no-counter"];
const NO_COUNTER = ["azo-flow-edge", "is-no-counter"];

describe("onboarding dataflow edge cascade", () => {
  it("a configures edge is dashed differently from an unmeasured data edge, after cascade", () => {
    const configuresDash = computed(CONFIGURES, "stroke-dasharray");
    const noCounterDash = computed(NO_COUNTER, "stroke-dasharray");
    expect(noCounterDash).toBe("4 4");
    expect(configuresDash).toBeDefined();
    expect(configuresDash).not.toBe(noCounterDash);
  });

  it("a configures edge also takes a different stroke colour than a no-counter edge", () => {
    expect(computed(CONFIGURES, "stroke")).not.toBe(computed(NO_COUNTER, "stroke"));
  });

  it("the resolver honours specificity and order (self-check)", () => {
    // is-flowing edges are solid accent; no-counter is faint 4 4.
    expect(computed(["azo-flow-edge", "is-flowing"], "stroke")).toBe("var(--accent)");
    expect(computed(["azo-flow-edge"], "stroke")).toBe("var(--border)");
  });
});
