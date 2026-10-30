/// <reference types="node" />
// main.tsx must render <App/> INSIDE <PollRegistryProvider>: App's one
// useConsolidatedPolling call merges screen registrations through
// useMergedPolls, which returns only the shell's static polls outside a
// provider - so a screen poll (the Azure onboarding live flow) would register
// into nothing and never run, with no error. main.tsx calls createRoot at
// module load, so this pins the source text; the runtime merge itself is pinned
// in packages/ui/src/polling/poll-registry.dom.test.tsx.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MAIN = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'main.tsx'), 'utf8');

/** The JSX passed to render(...), comments removed. */
function renderedTree(src: string): string {
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const m = /\.render\(([\s\S]*)\)\s*;?\s*$/.exec(noComments.trim());
  return m ? m[1]! : '';
}

describe('main.tsx', () => {
  const tree = renderedTree(MAIN);

  it('renders <App /> inside <PollRegistryProvider>', () => {
    const open = tree.search(/<PollRegistryProvider[\s>]/);
    const app = tree.search(/<App\s*\/>/);
    const close = tree.indexOf('</PollRegistryProvider>');
    expect(open).toBeGreaterThanOrEqual(0);
    expect(app).toBeGreaterThan(open);
    expect(close).toBeGreaterThan(app);
  });

  it('imports PollRegistryProvider from @soc/ui', () => {
    expect(MAIN).toMatch(/import\s*\{[^}]*\bPollRegistryProvider\b[^}]*\}\s*from\s*'@soc\/ui'/);
  });

  it('renders exactly one <App />', () => {
    expect(tree.match(/<App\s*\/>/g)).toHaveLength(1);
  });
});
