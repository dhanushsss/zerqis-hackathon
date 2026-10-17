import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CopyButton } from './components/ui';

describe('accessible names (QA axe audit regressions)', () => {
  it('an icon-only copy button has an accessible name', () => {
    render(<CopyButton text="https://example.invalid/api/webhooks/github" label="" />);
    expect(screen.getByRole('button', { name: 'Copy to clipboard' })).toBeTruthy();
  });

  it('a labelled copy button keeps its visible label as its name', () => {
    render(<CopyButton text="x" label="Copy diff" />);
    expect(screen.getByRole('button', { name: 'Copy diff' })).toBeTruthy();
  });
});
