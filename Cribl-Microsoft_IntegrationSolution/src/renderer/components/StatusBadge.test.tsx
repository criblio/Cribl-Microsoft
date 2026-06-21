// @vitest-environment jsdom
// Smoke test proving the DOM test stack (jsdom + @testing-library/react + the react plugin)
// works for the renderer. Component/hook tests that need the DOM start with the docblock above.

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import StatusBadge from './StatusBadge';

afterEach(cleanup);

describe('StatusBadge', () => {
  it('renders the default label for a status', () => {
    render(<StatusBadge status="success" />);
    expect(screen.getByText('Complete')).toBeTruthy();
  });

  it('renders a custom label when provided', () => {
    render(<StatusBadge status="running" label="Deploying..." />);
    expect(screen.getByText('Deploying...')).toBeTruthy();
  });
});
