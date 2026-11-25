// @vitest-environment happy-dom
/**
 * DBT-188: THE SHELL'S WIRING OF THE APPOPTIONS READ, pinned on the mounted app.
 *
 * Every decision about the appOptions read is pure and pinned in
 * packages/ui/src/frame/options-read.test.ts (DBT-158, DBT-172, DBT-173,
 * DBT-180), and each screen's half - a read-only toggle, a refused Run - is
 * pinned on the screen. What none of those can see is THIS file's half: that
 * App.tsx hands the notice to every route that shows the options, withholds
 * the DCE toggle's save, passes the Run refusal to Onboard and Batch, and
 * re-reads only appOptions on Retry. A regression in that wiring passed every
 * test before this one, so it mounts the real <App/> - the real frame, routes,
 * ports and PlatformSecretsStore - over a stubbed fetch.
 *
 * NOTHING HERE REACHES A REAL SYSTEM. fetch is stubbed for the whole file: the
 * KV keys the boot reads answer from the table below, the worker-group listing
 * answers one Stream group, and everything else (Azure, GitHub, the content
 * cache) answers 404, which the screens already treat as a failure to report.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DEFAULT_APP_OPTIONS, serializeAppOptions } from '@soc/core';
import {
  OPTIONS_RUN_RETRYING_REASON,
  OPTIONS_RUN_UNREADABLE_REASON,
  OPTIONS_UNREADABLE_NOTICE,
  PollRegistryProvider,
} from '@soc/ui';
import App from './App';

const API = 'https://leader.test/api/v1';
const KV = `${API}/kvstore/`;

/**
 * The operator's real options: DCE ON, where the default is off, and the
 * SECOND listed worker group saved as the default - so a screen that kept the
 * listing's automatic first-row pick after the read answered is caught.
 */
const SAVED_GROUP = 'prod';
const SAVED_RAW = serializeAppOptions({
  ...DEFAULT_APP_OPTIONS,
  operation: { ...DEFAULT_APP_OPTIONS.operation, createDCE: true },
  cribl: { ...DEFAULT_APP_OPTIONS.cribl, workerGroup: SAVED_GROUP },
});

const PROFILES = JSON.stringify({
  profiles: [
    {
      id: 'p1',
      name: 'Default',
      config: {
        clientId: 'client-1',
        tenantId: 'tenant-1',
        subscriptionId: 'sub-1',
        resourceGroup: 'rg-1',
        workspaceName: 'law-1',
        setupPath: 'existing',
      },
    },
  ],
  activeProfileId: 'p1',
});

/** The boot reads other than appOptions, which a Retry must not repeat. */
const OTHER_BOOT_KEYS = ['auaAcceptance', 'setupComplete', 'appTheme', 'azureProfiles'];

interface Call {
  method: string;
  url: string;
  body: string | null;
}

let calls: Call[] = [];
/** How the next GET of appOptions answers. A function lets a test hold it. */
let answerAppOptions: () => Promise<Response> = async () => new Response('refused', { status: 500 });

function kvGets(key: string): number {
  return calls.filter((c) => c.method === 'GET' && c.url === `${KV}${key}`).length;
}

function optionsPuts(): Call[] {
  return calls.filter((c) => c.method === 'PUT' && c.url === `${KV}appOptions`);
}

beforeEach(() => {
  calls = [];
  answerAppOptions = async () => new Response('refused', { status: 500 });
  Object.defineProperty(window, 'CRIBL_API_URL', { value: API, configurable: true });
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: typeof init?.body === 'string' ? init.body : null });
    if (method === 'GET' && url === `${KV}auaAcceptance`) {
      return new Response('{"acceptedAt":"2026-10-01T00:00:00Z"}');
    }
    if (method === 'GET' && url === `${KV}setupComplete`) {
      return new Response('{"completedAt":"2026-10-01T00:00:00Z"}');
    }
    if (method === 'GET' && url === `${KV}azureProfiles`) {
      return new Response(PROFILES);
    }
    if (method === 'GET' && url === `${KV}appOptions`) {
      return answerAppOptions();
    }
    if (method === 'PUT' && url === `${KV}appOptions`) {
      return new Response('');
    }
    if (method === 'POST' && url === `${KV}keys`) {
      return new Response('[]');
    }
    if (method === 'GET' && url === `${API}/master/groups`) {
      return new Response(
        JSON.stringify({
          count: 2,
          items: [
            { id: 'default', product: 'stream' },
            { id: SAVED_GROUP, product: 'stream' },
          ],
        }),
      );
    }
    return new Response('not stubbed', { status: 404 });
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mountApp(): void {
  render(
    <PollRegistryProvider>
      <App />
    </PollRegistryProvider>,
  );
}

/** Click a sidebar route by its label. */
async function openRoute(label: string): Promise<void> {
  const item = await waitFor(() => {
    const found = [...document.querySelectorAll<HTMLButtonElement>('.app-frame-nav-item')].find(
      (b) => b.querySelector('.app-frame-nav-item-label')?.textContent === label,
    );
    expect(found).toBeTruthy();
    return found!;
  });
  fireEvent.click(item);
}

/** On the DCR Automation route, open one of its tabs. */
function openDcrTab(name: 'Single table' | 'Batch'): void {
  fireEvent.click(screen.getByRole('tab', { name }));
}

function noticeCount(): number {
  return screen.queryAllByText(OPTIONS_UNREADABLE_NOTICE).length;
}

function dceToggle(): HTMLInputElement {
  const text = screen.getByText(/^Create a DCE \((enabled|disabled)\)/);
  const input = text.closest('label')?.querySelector('input[type="checkbox"]');
  expect(input).toBeTruthy();
  return input as HTMLInputElement;
}

function runButton(name: 'Run onboarding' | 'Run batch onboarding'): HTMLButtonElement {
  return screen.getByRole('button', { name }) as HTMLButtonElement;
}

/** The hints rendered beside a Run button, in its own controls row. */
function hintsBeside(button: HTMLButtonElement): string[] {
  return [...button.parentElement!.querySelectorAll('.field-hint')].map((el) => el.textContent ?? '');
}

/** The worker group the visible screen has selected. */
function selectedGroup(): string {
  const label = [...document.querySelectorAll<HTMLElement>('label.field')].find(
    (el) => el.querySelector('.field-label')?.textContent === 'Cribl worker group',
  );
  expect(label).toBeTruthy();
  return label!.querySelector('.searchable-select-control')?.textContent ?? '';
}

/** List one table on the Batch tab, so Run has something to run. */
function listOneTable(): void {
  fireEvent.change(screen.getByPlaceholderText(/SecurityEvent/), { target: { value: 'SecurityEvent' } });
}

describe('App - a refused appOptions read (DBT-158, DBT-188)', () => {
  it('Integrate shows the notice once, and its DCE toggle is read-only and sends no PUT', async () => {
    mountApp();
    await openRoute('Sentinel Integration');
    await waitFor(() => expect(noticeCount()).toBe(1));
    const toggle = dceToggle();
    // The defaults render (DCE off) - and are said to be the defaults.
    expect(toggle.checked).toBe(false);
    expect(toggle.disabled).toBe(true);
    fireEvent.click(toggle);
    // A save is async: give one the chance to go out before saying none did.
    // That the save itself refuses here is pinned in options-save.test.ts.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(optionsPuts()).toHaveLength(0);
    expect(kvGets('appOptions')).toBe(1);
  });

  it('Onboard shows the notice and refuses Run with the reason beside it', async () => {
    mountApp();
    await openRoute('DCR Automation');
    openDcrTab('Single table');
    await waitFor(() => expect(noticeCount()).toBe(1));
    // The worker group listed, so the refusal is the only thing holding Run.
    await waitFor(() => expect(screen.getByText('default')).toBeTruthy());
    const run = runButton('Run onboarding');
    expect(run.disabled).toBe(true);
    expect(run.title).toBe(OPTIONS_RUN_UNREADABLE_REASON);
    expect(hintsBeside(run)).toEqual([OPTIONS_RUN_UNREADABLE_REASON]);
  });

  it('Batch shows the notice and refuses Run with the reason beside it', async () => {
    mountApp();
    await openRoute('DCR Automation');
    openDcrTab('Batch');
    await waitFor(() => expect(noticeCount()).toBe(1));
    listOneTable();
    await waitFor(() => expect(screen.getByText('default')).toBeTruthy());
    const run = runButton('Run batch onboarding');
    expect(run.disabled).toBe(true);
    expect(run.title).toBe(OPTIONS_RUN_UNREADABLE_REASON);
    expect(hintsBeside(run)).toEqual([OPTIONS_RUN_UNREADABLE_REASON]);
  });

  it('Retry re-reads ONLY appOptions; while it is in flight Run says so, and an answer lifts everything', async () => {
    mountApp();
    await openRoute('DCR Automation');
    openDcrTab('Single table');
    await waitFor(() => expect(noticeCount()).toBe(1));
    await waitFor(() => expect(screen.getByText('default')).toBeTruthy());
    const before = Object.fromEntries(OTHER_BOOT_KEYS.map((k) => [k, kvGets(k)]));
    expect(before).toEqual({ auaAcceptance: 1, setupComplete: 1, appTheme: 1, azureProfiles: 1 });
    expect(kvGets('appOptions')).toBe(1);

    // Hold the retry's read open, to see the in-flight state.
    let release: (value: Response) => void = () => {};
    answerAppOptions = () => new Promise<Response>((resolve) => { release = resolve; });
    fireEvent.click(screen.getByRole('button', { name: 'Retry reading options' }));
    await waitFor(() => expect(kvGets('appOptions')).toBe(2));
    const retrying = screen.getByRole('button', { name: 'Retrying...' }) as HTMLButtonElement;
    expect(retrying.disabled).toBe(true);
    expect(runButton('Run onboarding').title).toBe(OPTIONS_RUN_RETRYING_REASON);
    expect(hintsBeside(runButton('Run onboarding'))).toEqual([OPTIONS_RUN_RETRYING_REASON]);

    // The read answers with the operator's real options.
    release(new Response(SAVED_RAW));
    await waitFor(() => expect(noticeCount()).toBe(0));
    expect(Object.fromEntries(OTHER_BOOT_KEYS.map((k) => [k, kvGets(k)]))).toEqual(before);
    expect(kvGets('appOptions')).toBe(2);

    // Onboard: Run unlocks, no reason beside it - and it would deploy to the
    // SAVED worker group, not the first-row pick made over the defaults.
    await waitFor(() => expect(selectedGroup()).toBe(SAVED_GROUP));
    const run = runButton('Run onboarding');
    expect(run.disabled).toBe(false);
    expect(run.title).toBe('');
    expect(hintsBeside(run)).toEqual([]);

    // Batch: the same.
    openDcrTab('Batch');
    expect(noticeCount()).toBe(0);
    listOneTable();
    await waitFor(() => expect(runButton('Run batch onboarding').disabled).toBe(false));
    expect(selectedGroup()).toBe(SAVED_GROUP);
    expect(hintsBeside(runButton('Run batch onboarding'))).toEqual([]);

    // Integrate: the real options show, the toggle saves, and the save is a
    // PATCH of the stored record carrying the change.
    await openRoute('Sentinel Integration');
    await waitFor(() => expect(dceToggle().checked).toBe(true));
    expect(noticeCount()).toBe(0);
    const toggle = dceToggle();
    expect(toggle.disabled).toBe(false);
    fireEvent.click(toggle);
    await waitFor(() => expect(optionsPuts()).toHaveLength(1));
    const written = JSON.parse(optionsPuts()[0]!.body ?? 'null') as {
      operation: { createDCE: boolean };
    };
    expect(written.operation.createDCE).toBe(false);
    await waitFor(() => expect(dceToggle().checked).toBe(false));
    expect(within(document.body).queryAllByText(OPTIONS_UNREADABLE_NOTICE)).toHaveLength(0);
  });
});
