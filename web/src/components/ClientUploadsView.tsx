import { useState, type ChangeEvent, type FormEvent } from 'react';
import {
  confirmPortalInvoiceDraft,
  rejectPortalInvoiceDraft,
  uploadPortalInvoiceDraft,
  uploadPortalContract,
  type PortalInvoiceDraft,
  type PortalInvoiceDraftCharge,
  type PortalInvoiceDraftPayload,
} from '../lib/api.js';

/**
 * 86e36yj9d / 86e36yrne: the client portal's Uploads section -- a
 * document-type list/selector (Invoice, Contract) plus, for the selected
 * type, its own upload flow. Invoice goes through an LLM-extracted
 * review -> confirm/reject flow against portal-invoice-upload-routes.ts's
 * client_admin-gated /api/portal/invoice-drafts. Contract has no
 * extraction step -- the client supplies metadata (carrier, name, version
 * label, valid-from/to) directly in its own form, submitted straight to
 * portal-contract-upload-routes.ts's /api/portal/contracts.
 *
 * No GET-driven list backs this section (the document-type list is a fixed,
 * known-small array, not fetched data), so useClientPortalResource's fetch/
 * loading/error shape doesn't apply here -- see that hook's own header
 * comment ("collapses the fetch/loading/error state+effect logic... across
 * the portal's ... Client*View components"; this view's state is a user-
 * driven upload/review flow, not a mount-effect fetch).
 */

type DocumentTypeId = 'invoice' | 'contract';

const DOCUMENT_TYPES: Array<{ id: DocumentTypeId; label: string }> = [
  { id: 'invoice', label: 'Invoice' },
  { id: 'contract', label: 'Contract' },
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CONTRACT_ACCEPT = 'application/pdf,.pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.xlsx';

interface ContractFormFields {
  carrierId: string;
  name: string;
  versionLabel: string;
  validFrom: string;
  validTo: string;
}

const EMPTY_CONTRACT_FORM: ContractFormFields = { carrierId: '', name: '', versionLabel: '', validFrom: '', validTo: '' };

/**
 * 86e36yrne AC4: required-field validation for the Contract form -- carrier,
 * name, and validFrom are required (mirroring ContractUploadMetadataSchema,
 * upload-contract-document.ts: versionLabel/validTo are `.optional()` there
 * too), plus a file. Returns the first violation found, or null when the
 * form is submittable -- never sends an incomplete payload to the server.
 */
function validateContractForm(fields: ContractFormFields, file: File | null): string | null {
  if (!file) return 'Select a PDF or XLSX file to upload.';
  if (!fields.carrierId.trim()) return 'Carrier is required.';
  if (!UUID_RE.test(fields.carrierId.trim())) return 'Carrier must be a valid carrier ID (UUID).';
  if (!fields.name.trim()) return 'Contract name is required.';
  if (!fields.validFrom.trim()) return 'Valid-from date is required.';
  if (!ISO_DATE_RE.test(fields.validFrom.trim())) return 'Valid-from date must be in YYYY-MM-DD format.';
  if (fields.validTo.trim() && !ISO_DATE_RE.test(fields.validTo.trim())) return 'Valid-to date must be in YYYY-MM-DD format.';
  if (fields.validTo.trim() && fields.validTo.trim() <= fields.validFrom.trim()) return 'Valid-to date must be after valid-from date.';
  return null;
}

type ContractFlowState =
  | { phase: 'idle' }
  | { phase: 'submitting' }
  | { phase: 'error'; message: string }
  | { phase: 'success'; contractId: string };

function ContractUploadPanel() {
  const [fields, setFields] = useState<ContractFormFields>(EMPTY_CONTRACT_FORM);
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<ContractFlowState>({ phase: 'idle' });

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    setFile(event.target.files?.[0] ?? null);
  }

  function handleFieldChange(key: keyof ContractFormFields, value: string) {
    setFields((prev) => ({ ...prev, [key]: value }));
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const validationError = validateContractForm(fields, file);
    if (validationError) {
      setState({ phase: 'error', message: validationError });
      return;
    }
    setState({ phase: 'submitting' });
    void file!.arrayBuffer().then(
      (bytes) => uploadPortalContract(bytes, file!.type, {
        carrierId: fields.carrierId.trim(),
        name: fields.name.trim(),
        versionLabel: fields.versionLabel.trim() || undefined,
        validFrom: fields.validFrom.trim(),
        validTo: fields.validTo.trim() || undefined,
      }).then(
        (result) => setState({ phase: 'success', contractId: result.contractId }),
        () => setState({ phase: 'error', message: 'Upload failed. Check the file and metadata, then try again.' }),
      ),
      () => setState({ phase: 'error', message: 'Upload failed. Check the file and try again.' }),
    );
  }

  const submitting = state.phase === 'submitting';

  return (
    <div data-testid="contract-upload-panel" className="border border-[rgba(32,30,29,.3)] bg-[#f3f2f2] p-3">
      <form data-testid="contract-upload-form" className="flex flex-col gap-3" onSubmit={handleSubmit}>
        <label className="flex flex-col text-xs font-semibold">
          Carrier ID
          <input
            data-testid="contract-upload-carrier-input"
            value={fields.carrierId}
            disabled={submitting}
            onChange={(e) => handleFieldChange('carrierId', e.target.value)}
            className="border border-[rgba(32,30,29,.3)] px-2 py-1 text-xs font-normal"
          />
        </label>
        <label className="flex flex-col text-xs font-semibold">
          Contract name
          <input
            data-testid="contract-upload-name-input"
            value={fields.name}
            disabled={submitting}
            onChange={(e) => handleFieldChange('name', e.target.value)}
            className="border border-[rgba(32,30,29,.3)] px-2 py-1 text-xs font-normal"
          />
        </label>
        <label className="flex flex-col text-xs font-semibold">
          Version label (optional)
          <input
            data-testid="contract-upload-version-label-input"
            value={fields.versionLabel}
            disabled={submitting}
            onChange={(e) => handleFieldChange('versionLabel', e.target.value)}
            className="border border-[rgba(32,30,29,.3)] px-2 py-1 text-xs font-normal"
          />
        </label>
        <div className="flex gap-3">
          <label className="flex flex-1 flex-col text-xs font-semibold">
            Valid from
            <input
              data-testid="contract-upload-valid-from-input"
              value={fields.validFrom}
              placeholder="YYYY-MM-DD"
              disabled={submitting}
              onChange={(e) => handleFieldChange('validFrom', e.target.value)}
              className="border border-[rgba(32,30,29,.3)] px-2 py-1 text-xs font-normal"
            />
          </label>
          <label className="flex flex-1 flex-col text-xs font-semibold">
            Valid to (optional)
            <input
              data-testid="contract-upload-valid-to-input"
              value={fields.validTo}
              placeholder="YYYY-MM-DD"
              disabled={submitting}
              onChange={(e) => handleFieldChange('validTo', e.target.value)}
              className="border border-[rgba(32,30,29,.3)] px-2 py-1 text-xs font-normal"
            />
          </label>
        </div>
        <label htmlFor="contract-upload-input" className="text-xs font-extrabold">Upload a contract (PDF or XLSX)</label>
        <input
          id="contract-upload-input"
          data-testid="contract-upload-input"
          type="file"
          accept={CONTRACT_ACCEPT}
          disabled={submitting}
          onChange={handleFileChange}
          className="text-xs"
        />

        {state.phase === 'error' && (
          <span role="alert" data-testid="contract-upload-error" className="text-xs font-semibold text-[#7c1405]">{state.message}</span>
        )}
        {state.phase === 'success' && (
          <span role="status" data-testid="contract-upload-success" className="text-xs font-semibold text-[#33705a]">
            Contract created — {state.contractId}.
          </span>
        )}

        <button
          type="submit"
          data-testid="contract-upload-submit-button"
          disabled={submitting}
          className="px-3 py-1 text-xs font-extrabold text-white disabled:cursor-not-allowed disabled:opacity-35"
          style={{ backgroundColor: 'var(--brand-primary, #ec3013)' }}
        >
          {submitting ? 'Uploading…' : 'Upload contract'}
        </button>
      </form>
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
      {selectedType === 'contract' && <ContractUploadPanel />}
    </section>
  );
}
