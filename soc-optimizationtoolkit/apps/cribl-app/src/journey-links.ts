/**
 * The cloud shell's journey stage bindings (ux-flow-plan 4.4, Unit 6.5),
 * moved out of App.tsx so they can be pinned: the Home test mounted the rail
 * WITHOUT these links and so missed a not-needed stage still linking into a
 * section hidden under Disconnected (DBT-246, I4).
 *
 * Cross-links are DATA passed to the shared screens; shared prose never names
 * shell-specific UI. Pure: no IO, no React.
 */

import { mergeJourneyLinks } from '@soc/ui';
import type { JourneyLinks } from '@soc/ui';

/** Element ids the Setup page wraps its sections in (same-route actions scroll there). */
export const SETUP_CONNECT_ANCHOR = 'setup-connect-section';
export const SETUP_GITHUB_ANCHOR = 'setup-github-section';

// The CLOUD-specific cross-links: identity entry lives in the App registration
// and connect section of the Setup page, and the GitHub token in its
// Repositories section on the same page.
const SHELL_LINK_OVERRIDES: JourneyLinks = {
  github: {
    routeId: 'home',
    anchorId: SETUP_GITHUB_ANCHOR,
  },
  connect: {
    routeId: 'home',
    // Same-route action: the anchor scrolls Setup down to the section so the
    // button visibly lands somewhere (user report 2026-07-28).
    anchorId: SETUP_CONNECT_ANCHOR,
    hint:
      'Identity entry lives in the App registration and connect section of the Setup ' +
      'page: Save and connect stores the secret and verifies it by acquiring an ARM token.',
  },
};

// The integrate-arc stages the single-page Integrate flagship serves
// (choose-content / configure / deploy) cross-link to the 'integrate' route -
// Setup's Integrate rail opens the one page (legacy-flow-analysis.md).
export const JOURNEY_LINKS: JourneyLinks = mergeJourneyLinks({
  ...SHELL_LINK_OVERRIDES,
  'choose-content': {
    routeId: 'integrate',
    hint: 'Start on the Sentinel Integration page - the single-page flow from Azure resources through deploy.',
  },
  configure: {
    routeId: 'integrate',
    hint: 'Configure Azure resources and Cribl on the Sentinel Integration page.',
  },
  deploy: {
    routeId: 'integrate',
    hint: 'Deploy the native table on the Sentinel Integration page.',
  },
});
