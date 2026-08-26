import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RuleProposalQueue } from '../src/components/RuleProposalQueue.js';

describe('RuleProposalQueue', () => {
  it('ratifies a proposed rule only to shadow', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 201 })); vi.stubGlobal('fetch', fetch);
    const done = vi.fn(); render(<RuleProposalQueue onRatified={done} rows={[{ id: 'rv', slug: 'fuel', rule_type: 'CONTRACT_CONFORMANCE', hardness: 'AI_DOCS', lifecycle_state: 'PROPOSED', ast_hash: 'h', recorded_at: 'x' }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ratify to shadow' }));
    await waitFor(() => expect(done).toHaveBeenCalledWith('rv', 'SHADOW'));
    expect(JSON.parse((fetch.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual({ rationale: 'Analyst ratification' });
    vi.unstubAllGlobals();
  });
  it('offers ACTIVE promotion only for shadow rules', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 201 })); vi.stubGlobal('fetch', fetch);
    render(<RuleProposalQueue onRatified={() => {}} rows={[{ id: 'rv', slug: 'fuel', rule_type: 'CONTRACT_CONFORMANCE', hardness: 'AI_DOCS', lifecycle_state: 'SHADOW', ast_hash: 'h', recorded_at: 'x' }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Activate' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/rules/rv/activate', expect.any(Object)));
    vi.unstubAllGlobals();
  });
});
