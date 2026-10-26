// Drift pin: the board's menu list against the app's real route table.
//
// board.mjs MENUS names "which part of the product a card is about" using the
// app's own route ids, and MENU_LABELS claims to match the nav "exactly where a
// route exists". Nothing held either claim to App.tsx: a route could ship while
// the board still called its menu PLANNED (azure-onboarding was exactly that
// until AZR-18), or a nav label could be renamed and the rollup keep the old
// one. Both are silent - the board renders, CI passes, and the rollup simply
// describes a product that no longer exists.
//
// The route table is read as TEXT, because App.tsx is a React module this
// script-level test cannot import. The parse is pinned to find a plausible
// number of rows AND to parse every row opener in the table, so a reformatted
// table - or one new row in a different shape - fails loudly instead of being
// skipped and passing every assertion vacuously.
//
// This file depends on board.mjs listing azure-onboarding as a routed
// development menu (not PLANNED); it must land in the same commit as that
// board.mjs change or `npm test` goes red.
//
// Runs under `npm test` (vitest picks up scripts/*.test.mjs), which CI runs on
// every PR touching soc-optimizationtoolkit/.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MENUS, MENU_LABELS, PLANNED_MENUS, plannedMenusSentence, renderBoard } from './board.mjs';

const appTsx = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'App.tsx'),
  'utf8',
);

/**
 * The rows of App.tsx's `routes: AppRoute[]` table, in nav order. Comment
 * lines inside the table are skipped; only object literals with an id are rows.
 */
export function routeRows(source) {
  return parseRouteTable(source).rows;
}

/**
 * The parsed rows plus the number of row OPENERS (`{ id: '...'`) in the table.
 * The strict row pattern only matches the one-line shape the table uses today;
 * a row written another way (split across lines, `requires: []`) would be
 * skipped silently. Counting openers separately lets the guard below demand
 * that every row in the table was parsed, not just that enough of them were.
 */
export function parseRouteTable(source) {
  const start = source.indexOf('const routes: AppRoute[] = [');
  if (start < 0) return { rows: [], openers: 0 };
  const end = source.indexOf('\n  ];', start);
  const table = source.slice(start, end < 0 ? undefined : end);
  const row =
    /^\s*\{\s*id:\s*'([^']+)',\s*label:\s*'([^']+)',\s*requires:\s*capabilitiesForRoute\('([^']+)'\),\s*section:\s*'([^']+)'/gm;
  const rows = [...table.matchAll(row)].map((m) => ({
    id: m[1],
    label: m[2],
    requiresId: m[3],
    section: m[4],
  }));
  const openers = [...table.matchAll(/^\s*\{\s*id:\s*'/gm)].length;
  return { rows, openers };
}

const { rows, openers } = parseRouteTable(appTsx);
const routeIds = rows.map((r) => r.id);
const NOT_ROUTES = new Set([...PLANNED_MENUS, 'none']);

describe('board MENUS against the App.tsx route table', () => {
  it('parses the route table (guards every assertion below from passing vacuously)', () => {
    expect(rows.length).toBeGreaterThanOrEqual(15);
    expect(new Set(routeIds).size).toBe(routeIds.length);
  });

  it('parses EVERY row in the table - a row in another shape fails here, not silently', () => {
    expect(rows.length).toBe(openers);
  });

  it('counts a row the strict pattern cannot parse (self-check of the guard above)', () => {
    const table = [
      '  const routes: AppRoute[] = [',
      "    { id: 'a', label: 'A', requires: capabilitiesForRoute('a'), section: 'x', element: null },",
      "    { id: 'b',",
      "      label: 'B', requires: [], section: 'x', element: null },",
      '  ];',
    ].join('\n');
    const parsed = parseRouteTable(table);
    expect(parsed.rows.map((r) => r.id)).toEqual(['a']);
    expect(parsed.openers).toBe(2);
  });

  it('every route id is a board menu', () => {
    expect(routeIds.filter((id) => !MENUS.includes(id))).toEqual([]);
  });

  it('every non-planned menu has a route', () => {
    const unrouted = MENUS.filter((m) => !NOT_ROUTES.has(m) && !routeIds.includes(m));
    expect(unrouted).toEqual([]);
  });

  it('no PLANNED menu has a route - a shipped screen is not planned', () => {
    expect(PLANNED_MENUS.filter((m) => routeIds.includes(m))).toEqual([]);
  });

  it('lists the routed menus in nav order', () => {
    expect(MENUS.filter((m) => routeIds.includes(m))).toEqual(routeIds);
  });

  it('labels each routed menu exactly as the nav does', () => {
    const mismatched = rows
      .filter((r) => MENU_LABELS[r.id] !== r.label)
      .map((r) => `${r.id}: board "${MENU_LABELS[r.id]}" vs nav "${r.label}"`);
    expect(mismatched).toEqual([]);
  });

  it('asks capabilitiesForRoute for its own id on every row', () => {
    expect(rows.filter((r) => r.requiresId !== r.id).map((r) => r.id)).toEqual([]);
  });
});

describe('azure-onboarding (AZR-18)', () => {
  it('is a development-section route labelled as the board labels it', () => {
    const row = rows.find((r) => r.id === 'azure-onboarding');
    expect(row).toEqual({
      id: 'azure-onboarding',
      label: 'Azure Native Source Onboarding',
      requiresId: 'azure-onboarding',
      section: 'development',
    });
    expect(MENU_LABELS['azure-onboarding']).toBe('Azure Native Source Onboarding');
  });

  it('sits directly after eventhub-discovery, its prerequisite screen', () => {
    expect(routeIds.indexOf('azure-onboarding')).toBe(routeIds.indexOf('eventhub-discovery') + 1);
  });

  it('is no longer PLANNED', () => {
    expect(PLANNED_MENUS).not.toContain('azure-onboarding');
  });
});

describe('the rollup sentence about PLANNED menus', () => {
  // It was hard-coded "Two menus are PLANNED" and survived AZR-18 routing
  // azure-onboarding, because check-board only compares board.md with a
  // render of the same stale string.
  it('counts PLANNED_MENUS rather than restating a number', () => {
    expect(plannedMenusSentence()).toBe('One menu is PLANNED and has no route yet.');
    expect(plannedMenusSentence(['a', 'b'])).toBe('Two menus are PLANNED and have no route yet.');
    expect(plannedMenusSentence([])).toBe('No menus are PLANNED and have no route yet.');
  });

  it('is the sentence the rendered board carries', () => {
    const md = renderBoard({ epics: [], features: [], stories: [] }, '2026-10-21');
    expect(md).toContain(`operator sees on any screen. ${plannedMenusSentence()}`);
    expect(md).not.toContain('Two menus are PLANNED');
  });
});
