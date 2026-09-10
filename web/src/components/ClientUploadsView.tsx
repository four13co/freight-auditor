import { useState } from 'react';
import {
  uploadPortalInvoiceDraft,
  confirmPortalInvoiceDraft,
  rejectPortalInvoiceDraft,
  type PortalInvoiceDraft,
  type PortalInvoiceCharge,
} from '../lib/api.js';

interface DocumentType {
  id: string;
  label: string;
}

/**
 * 86e36yj9d: Invoice is the only document type today; the sibling
 * contract-upload task (86e36yrne) appends a 'contract' entry here once it
 * lands -- kept as a short, concrete list rather than a speculative
 * plugin-style abstraction (the item's own Rabbit holes/No-gos).
 */
const DOCUMENT_TYPES: DocumentType[] = [{ id: 'invoice', label: 'Invoice' }];

type ChargeField = 'code' | 'category' | 'amount' | 'currency';

/**
 * Upload -> LLM-extracted review -> confirm/reject, driving
 * /api/portal/invoice-drafts* (portal-uploads-routes.ts). Deliberately a
 * self-contained flow component (not useClientPortalResource, which is
 * GET-only shaped) -- this is a multi-step write flow with local review
 * state, not a single resource fetch.
 */
function InvoiceUploadFlow() {
  const [file, setFile] = useState<File | null>(null);
  const [draft, setDraft] = useState<PortalInvoiceDraft | null>(null);
  const [carrierId, setCarrierId] = useState('');
  const [charges, setCharges] = useState<PortalInvoiceCharge[]>([]);
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ kind: 'confirmed'; auditRunId: string } | { kind: 'rejected' } | null>(null);

  async function handleUpload() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const bytes = await file.arrayBuffer();
      const result = await uploadPortalInvoiceDraft(bytes);
      setDraft(result);
      setInvoiceNumber(result.extractedPayload.invoiceNumber ?? '');
      setCharges(result.extractedPayload.charges);
      setCarrierId(result.carrierCandidates[0]?.carrierId ?? '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'upload failed');
    } finally {
      setBusy(false);
    }
  }

  function updateCharge(index: number, field: ChargeField, value: string) {
    setCharges((prev) => prev.map((charge, i) => (i === index ? { ...charge, [field]: value } : charge)));
  }

  async function handleConfirm() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const correctedPayload = {
        ...draft.extractedPayload,
        invoiceNumber: invoiceNumber || undefined,
        charges,
      };
      const result = await confirmPortalInvoiceDraft(draft.id, {
        carrierId: carrierId || undefined,
        correctedPayload,
      });
      setOutcome({ kind: 'confirmed', auditRunId: result.auditRunId });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'confirm failed');
    } finally {
      setBusy(false);
    }
  }

  async function handleReject() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      await rejectPortalInvoiceDraft(draft.id);
      setOutcome({ kind: 'rejected' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'reject failed');
    } finally {
      setBusy(false);
    }
  }

  if (outcome?.kind === 'confirmed') {
    return (
      <div role="status" data-testid="invoice-upload-success" className="text-xs font-semibold text-[rgba(32,30,29,0.85)]">
        Invoice confirmed — audit run {outcome.auditRunId} created.
      </div>
    );
  }
  if (outcome?.kind === 'rejected') {
    return (
      <div role="status" data-testid="invoice-upload-rejected" className="text-xs font-semibold text-[rgba(32,30,29,0.85)]">
        Draft rejected.
      </div>
    );
  }

  return (
    <div data-testid="invoice-upload-flow" className="flex flex-col gap-3">
      {error && (
        <span role="alert" data-testid="invoice-upload-error" className="text-xs font-semibold text-[#7c1405]">
          {error}
        </span>
      )}

      {!draft && (
        <div className="flex items-center gap-2">
          <input
            type="file"
            accept="application/pdf"
            data-testid="invoice-upload-input"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <button
            type="button"
            data-testid="invoice-upload-submit"
            disabled={!file || busy}
            onClick={handleUpload}
            className="border border-[rgba(32,30,29,.3)] px-2 py-1 text-xs font-semibold disabled:opacity-50"
          >
            Upload
          </button>
        </div>
      )}

      {draft && (
        <form
          data-testid="invoice-review-form"
          className="flex flex-col gap-2 border border-[rgba(32,30,29,.3)] p-3"
          onSubmit={(e) => e.preventDefault()}
        >
          <label className="flex flex-col text-xs font-semibold">
            Invoice number
            <input
              type="text"
              data-testid="invoice-review-invoice-number"
              value={invoiceNumber}
              onChange={(e) => setInvoiceNumber(e.target.value)}
              className="border border-[rgba(32,30,29,.3)] px-2 py-1 text-xs font-normal"
            />
          </label>

          <label className="flex flex-col text-xs font-semibold">
            Carrier
            {draft.carrierCandidates.length > 0 ? (
              <select
                data-testid="invoice-review-carrier"
                value={carrierId}
                onChange={(e) => setCarrierId(e.target.value)}
                className="border border-[rgba(32,30,29,.3)] px-2 py-1 text-xs font-normal"
              >
                {draft.carrierCandidates.map((candidate) => (
                  <option key={candidate.carrierId} value={candidate.carrierId}>{candidate.name}</option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                data-testid="invoice-review-carrier"
                value={carrierId}
                onChange={(e) => setCarrierId(e.target.value)}
                placeholder="carrier id"
                className="border border-[rgba(32,30,29,.3)] px-2 py-1 text-xs font-normal"
              />
            )}
          </label>

          <table data-testid="invoice-review-charges" className="w-full text-xs">
            <thead>
              <tr className="border-b text-left">
                <th className="py-1 pr-2">Code</th>
                <th className="py-1 pr-2">Category</th>
                <th className="py-1 pr-2">Amount</th>
                <th className="py-1 pr-2">Currency</th>
              </tr>
            </thead>
            <tbody>
              {charges.map((charge, index) => (
                <tr key={index} data-testid="invoice-review-charge-row" className="border-t">
                  <td className="py-1 pr-2">
                    <input
                      type="text"
                      value={charge.code ?? ''}
                      onChange={(e) => updateCharge(index, 'code', e.target.value)}
                      className="w-20 border border-[rgba(32,30,29,.3)] px-1 py-0.5"
                    />
                  </td>
                  <td className="py-1 pr-2">
                    <input
                      type="text"
                      value={charge.category ?? ''}
                      onChange={(e) => updateCharge(index, 'category', e.target.value)}
                      className="w-24 border border-[rgba(32,30,29,.3)] px-1 py-0.5"
                    />
                  </td>
                  <td className="py-1 pr-2">
                    <input
                      type="text"
                      data-testid="invoice-review-charge-amount"
                      value={charge.amount ?? ''}
                      onChange={(e) => updateCharge(index, 'amount', e.target.value)}
                      className="w-20 border border-[rgba(32,30,29,.3)] px-1 py-0.5"
                    />
                  </td>
                  <td className="py-1 pr-2">
                    <input
                      type="text"
                      value={charge.currency}
                      onChange={(e) => updateCharge(index, 'currency', e.target.value)}
                      className="w-14 border border-[rgba(32,30,29,.3)] px-1 py-0.5"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="flex gap-2">
            <button
              type="button"
              data-testid="invoice-review-confirm"
              disabled={busy}
              onClick={handleConfirm}
              className="border border-[rgba(32,30,29,.3)] px-2 py-1 text-xs font-semibold disabled:opacity-50"
            >
              Confirm
            </button>
            <button
              type="button"
              data-testid="invoice-review-reject"
              disabled={busy}
              onClick={handleReject}
              className="border border-[rgba(32,30,29,.3)] px-2 py-1 text-xs font-semibold disabled:opacity-50"
            >
              Reject
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/**
 * 86e36yj9d: the client-portal Uploads section's shell -- a document-type
 * list/selector (Invoice today; Contract is the sibling task's addition),
 * not an Invoice-specific page, so that sibling task only adds an entry
 * here rather than reworking this shell. Gated at the route layer
 * (registerClientAdminAuthPreHandler on the server, and the nav item itself
 * hidden for client_viewer in PortalApp.tsx) -- this component doesn't
 * re-check role itself.
 */
export function ClientUploadsView() {
  const [selectedType, setSelectedType] = useState<string | null>(null);

  return (
    <section data-testid="client-uploads-view" className="border border-[rgba(32,30,29,.3)] bg-[#f3f2f2] p-3">
      <h2 className="mb-2 text-sm font-extrabold">Uploads</h2>

      <div data-testid="upload-document-type-list" className="mb-3 flex gap-2">
        {DOCUMENT_TYPES.map((type) => (
          <button
            key={type.id}
            type="button"
            data-testid={`upload-document-type-${type.id}`}
            aria-pressed={selectedType === type.id}
            onClick={() => setSelectedType(type.id)}
            className={`border border-[rgba(32,30,29,.3)] px-2 py-1 text-xs font-semibold ${
              selectedType === type.id ? 'bg-[rgba(32,30,29,0.1)]' : ''
            }`}
          >
            {type.label}
          </button>
        ))}
      </div>

      {selectedType === 'invoice' && <InvoiceUploadFlow key="invoice" />}
    </section>
  );
}
