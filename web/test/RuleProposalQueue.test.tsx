import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RuleProposalQueue } from '../src/components/RuleProposalQueue.js';

describe('RuleProposalQueue', () => {
  it('ratifies a proposed rule only to shadow, passing the real new row id from the response (86e33t9n0)', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ruleVersionId: 'new-shadow-id' }), { status: 201 })); vi.stubGlobal('fetch', fetch);
    const done = vi.fn(); render(<RuleProposalQueue onRatified={done} rows={[{ id: 'rv', slug: 'fuel', rule_type: 'CONTRACT_CONFORMANCE', hardness: 'AI_DOCS', lifecycle_state: 'PROPOSED', ast_hash: 'h', recorded_at: 'x' }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ratify to shadow' }));
    // 86e33t9n0: onRatified must receive the REAL new row id the server
    // returns ('new-shadow-id'), not just the pre-ratify row id ('rv') --
    // acting on the stale old id a second time (e.g. Activate right after
    // Ratify, no reload) would target the wrong, already-superseded row.
    await waitFor(() => expect(done).toHaveBeenCalledWith('rv', 'new-shadow-id', 'SHADOW'));
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
