import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ExtractionReview } from '../src/components/ExtractionReview.js';

const documentId = '44444444-4444-4444-8444-444444444444';
const question = {
  id: '33333333-3333-4333-8333-333333333333', source_document_id: documentId,
  field_path: 'contract.currency', question: 'Which currency applies?', answer: null, answer_source: null,
  abstention_status: 'NOT_FOUND', abstention_reason: 'MISSING_REQUIRED_FIELD', policy_version: 'abstention/1',
  question_hash: 'a'.repeat(64), created_at: '2026-08-27T00:00:00Z',
};

describe('ExtractionReview', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => vi.unstubAllGlobals());

  async function loadQuestion() {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ questions: [question] }), { status: 200 }));
    render(<ExtractionReview />);
    await userEvent.type(screen.getByLabelText('Source document ID'), documentId);
    await userEvent.click(screen.getByRole('button', { name: 'Review' }));
    return await screen.findByTestId('clarifying-question');
  }

  it('validates the document id before loading', async () => {
    render(<ExtractionReview />);
    await userEvent.type(screen.getByLabelText('Source document ID'), 'not-a-uuid');
    expect(screen.getByText('Enter a well-formed source-document UUID.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review' })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders extraction provenance and an explicit answer source', async () => {
    const card = await loadQuestion();
    expect(within(card).getByText('contract.currency')).toBeInTheDocument();
    expect(within(card).getByText('Which currency applies?')).toBeInTheDocument();
    expect(within(card).getByText('Not found')).toBeInTheDocument();
    expect(within(card).getByText(/missing required field · Policy: abstention\/1/)).toBeInTheDocument();
    expect(fetchMock.mock.calls[0]![0]).toContain(`source_document_id=${documentId}`);
    expect(screen.getByText('0 of 1 answered')).toBeInTheDocument();
  });

  it('saves a trimmed, source-labeled answer and updates progress', async () => {
    await loadQuestion();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      id: question.id, answer: 'US dollars', answer_source: 'carrier_confirmed', changed: true,
    }), { status: 200 }));
    await userEvent.type(screen.getByLabelText('Answer'), '  US dollars  ');
    await userEvent.selectOptions(screen.getByLabelText('Answer source for contract.currency'), 'carrier_confirmed');
    await userEvent.click(screen.getByRole('button', { name: 'Save answer' }));
    await waitFor(() => expect(screen.getByText('1 of 1 answered')).toBeInTheDocument());
    expect(screen.getByText('Answered · Carrier confirmed')).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe(`/api/clarifying-questions/${question.id}/answer`);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ answer: 'US dollars', answer_source: 'carrier_confirmed' });
  });

  it('distinguishes empty, load-error, and save-error states', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ questions: [] }), { status: 200 }));
    render(<ExtractionReview />);
    await userEvent.type(screen.getByLabelText('Source document ID'), documentId);
    await userEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(await screen.findByText('No clarification is needed for this document.')).toBeInTheDocument();

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));
    await userEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(await screen.findByText('Questions could not be loaded. Check the document ID and try again.')).toBeInTheDocument();
  });

  it('keeps an unsaved answer visible when persistence fails', async () => {
    await loadQuestion(); fetchMock.mockResolvedValueOnce(new Response(null, { status: 409 }));
    await userEvent.type(screen.getByLabelText('Answer'), 'USD');
    await userEvent.click(screen.getByRole('button', { name: 'Save answer' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Answer could not be saved');
    expect(screen.getByLabelText('Answer')).toHaveValue('USD');
    expect(screen.getByText('0 of 1 answered')).toBeInTheDocument();
  });
});
