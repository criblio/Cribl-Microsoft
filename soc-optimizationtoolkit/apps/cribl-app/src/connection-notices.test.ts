import { describe, expect, it } from 'vitest';
import { deriveJourney } from '@soc/core';
import type { AzureConnectivity, JourneyFacts } from '@soc/core';
import { NOT_NEEDED_HINT, buildStepperItems, deriveNextActionView } from '@soc/ui';
import { clearNotice } from './clear-notice';
import { connectionIncompleteText, secretNotice } from './connection-notices';
import { JOURNEY_LINKS, SETUP_GITHUB_ANCHOR } from './journey-links';

// The sections hidden under Disconnected; no text a Disconnected operator sees
// may send them there.
const HIDDEN_SECTION = /App registration and connect|Select resources and grant permissions/;

const MISSING = ['tenantId', 'clientId', 'subscriptionId'];

describe('connection notices follow the connectivity choice (I4)', () => {
  it.each(['onboard', 'batch'] as const)(
    'the %s Connection incomplete panel never points a Disconnected operator at a hidden section',
    (page) => {
      const text = connectionIncompleteText('disconnected', MISSING, page);
      expect(text).not.toMatch(HIDDEN_SECTION);
      expect(text).toMatch(/not connected/i);
      expect(text).toMatch(/How will this app work with Azure\?/);
      // The gate reason stays on screen.
      expect(text).toContain('tenantId, clientId, subscriptionId');
    },
  );

  it.each(['full', 'partial'] as const)(
    'keeps the connect-first guidance under %s',
    (connectivity: AzureConnectivity) => {
      expect(connectionIncompleteText(connectivity, MISSING, 'onboard')).toMatch(
        /App registration and connect section/,
      );
      expect(connectionIncompleteText(connectivity, MISSING, 'batch')).toMatch(
        /App registration and connect section/,
      );
    },
  );

  it('the secret notice never points a Disconnected operator at the connect section', () => {
    for (const probe of [
      { state: 'missing' as const },
      { state: 'failed' as const, detail: 'refused' },
    ]) {
      const text = secretNotice('disconnected', false, probe);
      expect(text).not.toBeNull();
      expect(text).not.toMatch(HIDDEN_SECTION);
      expect(text).toMatch(/not connected/i);
    }
  });

  it('keeps the verified secret notices under full', () => {
    expect(secretNotice('full', false, { state: 'missing' })).toMatch(
      /No client secret is stored/,
    );
    expect(secretNotice('full', false, { state: 'failed', detail: 'boom' })).toMatch(
      /FAILED verification.*Detail: boom/s,
    );
    expect(secretNotice('full', true, { state: 'missing' })).toBeNull();
    expect(secretNotice('full', false, { state: 'checking' })).toBeNull();
  });

  it('the Clear stored secret notice under Disconnected does not ask to re-authenticate in a hidden section', () => {
    const text = clearNotice('secret', 'disconnected');
    expect(text).not.toMatch(HIDDEN_SECTION);
    expect(text).not.toMatch(/re-authenticate/);
    expect(clearNotice('secret', 'full')).toBe(clearNotice('secret'));
  });
});

describe('the cloud shell journey links (I4, M2)', () => {
  const disconnected: JourneyFacts = {
    accepted: true,
    identityPresent: true,
    secretLive: 'unknown',
    scopeCommitted: false,
    connectivity: 'disconnected',
  };

  it('a not-needed stage, with the REAL shell links, has no route and no hidden-section hint', () => {
    const items = buildStepperItems(deriveJourney(disconnected).firstRun, JOURNEY_LINKS);
    for (const id of ['connect', 'target']) {
      const item = items.find((i) => i.id === id);
      expect(item?.status).toBe('not-needed');
      expect(item?.routeId).toBeNull();
      expect(item?.hint).toBe(NOT_NEEDED_HINT);
      expect(item?.hint ?? '').not.toMatch(HIDDEN_SECTION);
    }
  });

  it('binds the github stage to the Setup page Repositories section', () => {
    expect(JOURNEY_LINKS.github?.routeId).toBe('home');
    expect(JOURNEY_LINKS.github?.anchorId).toBe(SETUP_GITHUB_ANCHOR);
  });

  it('gives the github next-action card a button', () => {
    const view = deriveNextActionView(
      { ...disconnected, tokenRequired: true, tokenPresent: false },
      JOURNEY_LINKS,
    );
    expect(view?.stageId).toBe('github');
    expect(view?.routeId).toBe('home');
    expect(view?.anchorId).toBe(SETUP_GITHUB_ANCHOR);
  });
});
