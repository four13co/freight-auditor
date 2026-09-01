import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PaymentApprovalQueue } from '../src/components/PaymentApprovalQueue.js';

const row = { auditRunId: 'run1', invoiceId: 'inv1', invoiceNumber: 'INV-1', carrierName: 'ACME', currency: 'USD', heldAt: '2026-01-01T00:00:00Z', rationale: null };

describe('PaymentApprovalQueue', () => {
  it('renders nothing when the queue is empty', () => {
    const { container } = render(<PaymentApprovalQueue rows={[]} onDecided={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists a held invoice with its carrier', () => {
    render(<PaymentApprovalQueue rows={[row]} onDecided={() => {}} />);
    expect(screen.getByText('INV-1')).toBeInTheDocument();
    expect(screen.getByText('ACME')).toBeInTheDocument();
  });

  it('approves a held invoice and reports the decision', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 })); vi.stubGlobal('fetch', fetch);
    const done = vi.fn();
    render(<PaymentApprovalQueue rows={[row]} onDecided={done} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(done).toHaveBeenCalledWith('run1'));
    expect(fetch).toHaveBeenCalledWith('/api/audit-runs/run1/payment-authorization', expect.any(Object));
    expect(JSON.parse((fetch.mock.calls[0]?.[1] as RequestInit).body as string)).toMatchObject({ action: 'approve' });
    vi.unstubAllGlobals();
  });

  it('disables its own button while a decision is in flight, not a sibling row', async () => {
    let resolveFetch: (() => void) | undefined;
    const fetch = vi.fn().mockReturnValue(new Promise((resolve) => { resolveFetch = () => resolve(new Response('{}', { status: 200 })); }));
    vi.stubGlobal('fetch', fetch);
    const rowB = { ...row, auditRunId: 'run2', invoiceNumber: 'INV-2' };
    render(<PaymentApprovalQueue rows={[row, rowB]} onDecided={() => {}} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Approve' })[0]!);
    const buttons = screen.getAllByRole('button', { name: 'Approve' });
    expect(buttons[0]).toBeDisabled();
    expect(buttons[1]).not.toBeDisabled();
    resolveFetch?.();
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Approve' })[0]).not.toBeDisabled());
    vi.unstubAllGlobals();
  });
});
