import { useState, type ChangeEvent } from 'react';
import {
  confirmPortalInvoiceDraft,
  rejectPortalInvoiceDraft,
  uploadPortalInvoiceDraft,
  type PortalInvoiceDraft,
  type PortalInvoiceDraftCharge,
  type PortalInvoiceDraftPayload,
} from '../lib/api.js';

/**
 * 86e36yj9d: the client portal's Uploads section -- a document-type list/
 * selector (currently just "Invoice"; the sibling contract-upload task adds
 * a second entry here without reworking this shell) plus, for the selected
 * type, the upload -> LLM-extracted review -> confirm/reject flow against
 * portal-invoice-upload-routes.ts's client_admin-gated
 * /api/portal/invoice-drafts.
 *
 * No GET-driven list backs this section (the document-type list is a fixed,
 * known-small array, not fetched data), so useClientPortalResource's fetch/
 * loading/error shape doesn't apply here -- see that hook's own header
 * comment ("collapses the fetch/loading/error state+effect logic... across
 * the portal's ... Client*View components"; this view's state is a user-
 * driven upload/review flow, not a mount-effect fetch).
 */

type DocumentTypeId = 'invoice';

const DOCUMENT_TYPES: Array<{ id: DocumentTypeId; label: string }> = [
  { id: 'invoice', label: 'Invoice' },
];

type FlowState =
  | { phase: 'idle' }
  | { phase: 'uploading' }
  | { phase: 'upload-error'; message: string }
  | { phase: 'review'; draft: PortalInvoiceDraft; edited: PortalInvoiceDraftPayload; carrierId: string; actionError: string | null }
  | { phase: 'submitting'; draft: PortalInvoiceDraft; edited: PortalInvoiceDraftPayload; action: 'confirm' | 'reject' }
  | { phase: 'confirmed'; auditRunId: string }
  | { phase: 'rejected' };

function updateCharge(edited: PortalInvoiceDraftPayload, index: number, patch: Partial<PortalInvoiceDraftCharge>): PortalInvoiceDraftPayload {
  return { ...edited, charges: edited.charges.map((charge, i) => (i === index ? { ...charge, ...patch } : charge)) };
}

function InvoiceUploadPanel() {
  const [state, setState] = useState<FlowState>({ phase: 'idle' });

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setState({ phase: 'uploading' });
    void file.arrayBuffer().then(
      (bytes) => uploadPortalInvoiceDraft(bytes).then(
        (draft) => setState({ phase: 'review', draft, edited: draft.extractedPayload, carrierId: '', actionError: null }),
        () => setState({ phase: 'upload-error', message: 'Upload failed. Check the file and try again.' }),
      ),
      () => setState({ phase: 'upload-error', message: 'Upload failed. Check the file and try again.' }),
    );
  }

  function handleConfirm() {
    if (state.phase !== 'review') return;
    const needsCarrier = state.draft.status === 'needs_carrier_review';
    if (needsCarrier && !state.carrierId) return;
    const { draft, edited, carrierId } = state;
    setState({ phase: 'submitting', draft, edited, action: 'confirm' });
    void confirmPortalInvoiceDraft(draft.id, edited, carrierId || undefined).then(
      (result) => setState({ phase: 'confirmed', auditRunId: result.auditRunId }),
      () => setState({ phase: 'review', draft, edited, carrierId, actionError: 'Confirm failed. Review the fields and try again.' }),
    );
  }

  function handleReject() {
    if (state.phase !== 'review') return;
    const { draft, edited, carrierId } = state;
    setState({ phase: 'submitting', draft, edited, action: 'reject' });
    void rejectPortalInvoiceDraft(draft.id).then(
      () => setState({ phase: 'rejected' }),
      () => setState({ phase: 'review', draft, edited, carrierId, actionError: 'Reject failed. Try again.' }),
    );
  }

  return (
    <div data-testid="invoice-upload-panel" className="border border-[rgba(32,30,29,.3)] bg-[#f3f2f2] p-3">
      {(state.phase === 'idle' || state.phase === 'uploading' || state.phase === 'upload-error') && (
        <div className="flex flex-col gap-2">
          <label htmlFor="invoice-upload-input" className="text-xs font-extrabold">Upload an invoice PDF</label>
          <input
            id="invoice-upload-input"
            data-testid="invoice-upload-input"
            type="file"
            accept="application/pdf"
            disabled={state.phase === 'uploading'}
            onChange={handleFileChange}
            className="text-xs"
          />
          {state.phase === 'uploading' && (
            <span data-testid="invoice-upload-uploading" className="text-xs font-semibold text-[rgba(32,30,29,0.65)]">Uploading…</span>
          )}
          {state.phase === 'upload-error' && (
            <span role="alert" data-testid="invoice-upload-error" className="text-xs font-semibold text-[#7c1405]">{state.message}</span>
          )}
        </div>
      )}

      {(state.phase === 'review' || state.phase === 'submitting') && (
        <form
          data-testid="invoice-review-form"
          className="flex flex-col gap-3"
          onSubmit={(e) => e.preventDefault()}
        >
          <div className="flex gap-3">
            <label className="flex flex-1 flex-col text-xs font-semibold">
              Invoice #
              <input
                data-testid="invoice-review-invoice-number"
                value={state.edited.invoiceNumber ?? ''}
                disabled={state.phase === 'submitting'}
                onChange={(e) => setState((prev) => (prev.phase === 'review' ? { ...prev, edited: { ...prev.edited, invoiceNumber: e.target.value } } : prev))}
                className="border border-[rgba(32,30,29,.3)] px-2 py-1 text-xs font-normal"
              />
            </label>
            <label className="flex flex-1 flex-col text-xs font-semibold">
              Currency
              <input
                data-testid="invoice-review-header-currency"
                value={state.edited.headerCurrency ?? ''}
                disabled={state.phase === 'submitting'}
                onChange={(e) => setState((prev) => (prev.phase === 'review' ? { ...prev, edited: { ...prev.edited, headerCurrency: e.target.value } } : prev))}
                className="border border-[rgba(32,30,29,.3)] px-2 py-1 text-xs font-normal"
              />
            </label>
          </div>

          <table data-testid="invoice-review-charges-table" className="w-full text-xs">
            <thead>
              <tr className="border-b text-left">
                <th className="py-1 pr-2">Code</th>
                <th className="py-1 pr-2">Category</th>
                <th className="py-1 pr-2">Amount</th>
                <th className="py-1 pr-2">Currency</th>
              </tr>
            </thead>
            <tbody>
              {state.edited.charges.map((charge, index) => (
                <tr key={index} data-testid="invoice-review-charge-row" className="border-t">
                  <td className="py-1 pr-2">
                    <input
                      aria-label={`Charge ${index + 1} code`}
                      value={charge.code ?? ''}
                      disabled={state.phase === 'submitting'}
                      onChange={(e) => setState((prev) => (prev.phase === 'review' ? { ...prev, edited: updateCharge(prev.edited, index, { code: e.target.value }) } : prev))}
                      className="w-full border border-[rgba(32,30,29,.3)] px-1 py-0.5"
                    />
                  </td>
                  <td className="py-1 pr-2">
                    <input
                      aria-label={`Charge ${index + 1} category`}
                      value={charge.category ?? ''}
                      disabled={state.phase === 'submitting'}
                      onChange={(e) => setState((prev) => (prev.phase === 'review' ? { ...prev, edited: updateCharge(prev.edited, index, { category: e.target.value }) } : prev))}
                      className="w-full border border-[rgba(32,30,29,.3)] px-1 py-0.5"
                    />
                  </td>
                  <td className="py-1 pr-2">
                    <input
                      aria-label={`Charge ${index + 1} amount`}
                      value={charge.amount ?? ''}
                      disabled={state.phase === 'submitting'}
                      onChange={(e) => setState((prev) => (prev.phase === 'review' ? { ...prev, edited: updateCharge(prev.edited, index, { amount: e.target.value }) } : prev))}
                      className="w-full border border-[rgba(32,30,29,.3)] px-1 py-0.5"
                    />
                  </td>
                  <td className="py-1 pr-2">
                    <input
                      aria-label={`Charge ${index + 1} currency`}
                      value={charge.currency}
                      disabled={state.phase === 'submitting'}
                      onChange={(e) => setState((prev) => (prev.phase === 'review' ? { ...prev, edited: updateCharge(prev.edited, index, { currency: e.target.value }) } : prev))}
                      className="w-full border border-[rgba(32,30,29,.3)] px-1 py-0.5"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {state.phase === 'review' && state.draft.status === 'needs_carrier_review' && (
            <label className="flex flex-col text-xs font-semibold">
              Carrier
              <select
                data-testid="invoice-review-carrier-select"
                value={state.carrierId}
                onChange={(e) => setState((prev) => (prev.phase === 'review' ? { ...prev, carrierId: e.target.value } : prev))}
                className="border border-[rgba(32,30,29,.3)] px-2 py-1 text-xs font-normal"
              >
                <option value="">Select a carrier…</option>
                {state.draft.carrierCandidates.map((c) => (
                  <option key={c.carrierId} value={c.carrierId}>{c.name}</option>
                ))}
              </select>
            </label>
          )}

          {state.phase === 'review' && state.actionError && (
            <span role="alert" data-testid="invoice-review-action-error" className="text-xs font-semibold text-[#7c1405]">{state.actionError}</span>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              data-testid="invoice-confirm-button"
              disabled={state.phase === 'submitting' || (state.phase === 'review' && state.draft.status === 'needs_carrier_review' && !state.carrierId)}
              onClick={handleConfirm}
              className="px-3 py-1 text-xs font-extrabold text-white disabled:cursor-not-allowed disabled:opacity-35"
              style={{ backgroundColor: 'var(--brand-primary, #ec3013)' }}
            >
              {state.phase === 'submitting' && state.action === 'confirm' ? 'Confirming…' : 'Confirm'}
            </button>
            <button
              type="button"
              data-testid="invoice-reject-button"
              disabled={state.phase === 'submitting'}
              onClick={handleReject}
              className="border border-[rgba(32,30,29,.3)] px-3 py-1 text-xs font-extrabold disabled:cursor-not-allowed disabled:opacity-35"
            >
              {state.phase === 'submitting' && state.action === 'reject' ? 'Rejecting…' : 'Reject'}
            </button>
          </div>
        </form>
      )}

      {state.phase === 'confirmed' && (
        <span role="status" data-testid="invoice-confirmed-status" className="text-xs font-semibold text-[#33705a]">
          Invoice confirmed — audit run {state.auditRunId} created.
        </span>
      )}

      {state.phase === 'rejected' && (
        <span role="status" data-testid="invoice-rejected-status" className="text-xs font-semibold text-[rgba(32,30,29,0.65)]">
          Draft rejected. No audit run was created.
        </span>
      )}
    </div>
  );
}

export function ClientUploadsView() {
  const [selectedType, setSelectedType] = useState<DocumentTypeId>('invoice');

  return (
    <section data-testid="client-uploads-view" className="flex flex-col gap-3">
      <h2 className="text-sm font-extrabold">Uploads</h2>
      <div data-testid="uploads-document-type-list" className="flex gap-2">
        {DOCUMENT_TYPES.map((type) => (
          <button
            key={type.id}
            type="button"
            data-testid="uploads-document-type-item"
            aria-pressed={selectedType === type.id}
            onClick={() => setSelectedType(type.id)}
            className={`px-3 py-1 text-xs font-extrabold ${selectedType === type.id ? 'text-white' : 'border border-[rgba(32,30,29,.3)]'}`}
            style={selectedType === type.id ? { backgroundColor: 'var(--brand-primary, #ec3013)' } : undefined}
          >
            {type.label}
          </button>
        ))}
      </div>
      {selectedType === 'invoice' && <InvoiceUploadPanel />}
    </section>
  );
}
