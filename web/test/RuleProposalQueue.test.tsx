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

  // 86e367r9q: Activate no longer sends a canned rationale string -- the
  // button stays disabled until the analyst types a real one, and it is
  // sent as typed.
  it('requires a typed rationale before Activate is enabled, and sends it to the endpoint', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ruleVersionId: 'new-active-id' }), { status: 201 })); vi.stubGlobal('fetch', fetch);
    render(<RuleProposalQueue onRatified={() => {}} rows={[{ id: 'rv', slug: 'fuel', rule_type: 'CONTRACT_CONFORMANCE', hardness: 'AI_DOCS', lifecycle_state: 'SHADOW', ast_hash: 'h', recorded_at: 'x' }]} />);
    const activateButton = screen.getByRole('button', { name: 'Activate' });
    expect(activateButton).toBeDisabled();

    const input = screen.getByPlaceholderText(/Activation rationale/);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'A different analyst reviewed and confirms activation' } });
    expect(activateButton).not.toBeDisabled();

    fireEvent.click(activateButton);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/rules/rv/activate', expect.any(Object)));
    expect(JSON.parse((fetch.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual({ rationale: 'A different analyst reviewed and confirms activation' });
    vi.unstubAllGlobals();
  });

  it('shows a real error when the server rejects activation for a dual-control violation, instead of failing silently', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'DUAL_CONTROL_REQUIRED' }), { status: 409 })); vi.stubGlobal('fetch', fetch);
    render(<RuleProposalQueue onRatified={() => {}} rows={[{ id: 'rv', slug: 'fuel', rule_type: 'CONTRACT_CONFORMANCE', hardness: 'AI_DOCS', lifecycle_state: 'SHADOW', ast_hash: 'h', recorded_at: 'x' }]} />);

    const input = screen.getByPlaceholderText(/Activation rationale/);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Same analyst tries again' } });
    fireEvent.click(screen.getByRole('button', { name: 'Activate' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/different analyst/i));
    vi.unstubAllGlobals();
  });
});
