import { useState } from 'react';
import {
  answerClarifyingQuestion,
  fetchClarifyingQuestions,
  type ClarificationAnswerSource,
  type ClarifyingQuestion,
} from '../lib/api.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_OPTIONS: Array<{ value: ClarificationAnswerSource; label: string }> = [
  { value: 'read_from_doc', label: 'Read from document' },
  { value: 'analyst_knowledge', label: 'Analyst knowledge' },
  { value: 'carrier_confirmed', label: 'Carrier confirmed' },
];

type LoadState = 'idle' | 'loading' | 'ready' | 'error';

function QuestionCard({ question, onSaved }: { question: ClarifyingQuestion; onSaved: (answer: string, source: ClarificationAnswerSource) => void }) {
  const [answer, setAnswer] = useState(question.answer ?? '');
  const [source, setSource] = useState<ClarificationAnswerSource>(question.answer_source ?? 'read_from_doc');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const dirty = answer.trim() !== (question.answer ?? '') || source !== (question.answer_source ?? 'read_from_doc');

  return <article className="border-t-2 border-[rgba(32,30,29,.18)] py-4" data-testid="clarifying-question">
    <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
      <div>
        <div className="font-mono text-[11px] font-bold text-[rgba(32,30,29,.55)]">{question.field_path}</div>
        <h3 className="mt-1 text-sm font-extrabold">{question.question}</h3>
      </div>
      <span className="bg-[#e5d9d5] px-2 py-1 text-[10px] font-extrabold uppercase tracking-wide text-[#792311]">
        {question.abstention_status === 'NOT_FOUND' ? 'Not found' : 'Ambiguous'}
      </span>
    </div>
    <div className="mb-3 text-[11px] text-[rgba(32,30,29,.6)]">
      Reason: {question.abstention_reason.replaceAll('_', ' ').toLowerCase()} · Policy: {question.policy_version}
    </div>
    <label className="block text-[11px] font-extrabold uppercase tracking-wide" htmlFor={`answer-${question.id}`}>Answer</label>
    <textarea id={`answer-${question.id}`} value={answer} onChange={(event) => setAnswer(event.target.value)} rows={2}
      className="mt-1 w-full resize-y border border-[rgba(32,30,29,.35)] bg-white px-3 py-2 text-sm outline-none focus:border-[#ec3013]" />
    <div className="mt-2 flex flex-wrap items-end gap-2">
      <label className="flex min-w-[210px] flex-1 flex-col gap-1 text-[11px] font-extrabold uppercase tracking-wide">
        Answer source
        <select aria-label={`Answer source for ${question.field_path}`} value={source} onChange={(event) => setSource(event.target.value as ClarificationAnswerSource)}
          className="h-9 border border-[rgba(32,30,29,.35)] bg-white px-2 text-xs font-semibold normal-case tracking-normal">
          {SOURCE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
      <button type="button" disabled={saving || !answer.trim() || !dirty} className="h-9 bg-[#201e1d] px-4 text-xs font-extrabold text-white disabled:cursor-not-allowed disabled:opacity-35"
        onClick={() => {
          setSaving(true); setError(false);
          void answerClarifyingQuestion(question.id, answer.trim(), source).then(() => onSaved(answer.trim(), source), () => setError(true)).finally(() => setSaving(false));
        }}>{saving ? 'Saving…' : question.answer ? 'Update answer' : 'Save answer'}</button>
    </div>
    {question.answer && !dirty && <div className="mt-2 text-xs font-bold text-[#33705a]" role="status">Answered · {SOURCE_OPTIONS.find((option) => option.value === question.answer_source)?.label}</div>}
    {error && <div className="mt-2 text-xs font-bold text-[#b3261e]" role="alert">Answer could not be saved. Review the current record and try again.</div>}
  </article>;
}

export function ExtractionReview() {
  const [documentId, setDocumentId] = useState('');
  const [questions, setQuestions] = useState<ClarifyingQuestion[]>([]);
  const [state, setState] = useState<LoadState>('idle');
  const validId = UUID.test(documentId.trim());

  function load() {
    if (!validId) return;
    setState('loading');
    void fetchClarifyingQuestions(documentId.trim()).then((rows) => { setQuestions(rows); setState('ready'); }, () => setState('error'));
  }

  const answered = questions.filter((question) => question.answer).length;
  return <section data-testid="extraction-review" className="flex-none border border-[rgba(32,30,29,.3)] bg-[#f3f2f2]">
    <div className="border-b border-[rgba(32,30,29,.2)] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="text-base font-extrabold">Extraction review</h2><p className="mt-1 text-xs text-[rgba(32,30,29,.62)]">Resolve fields the extraction policy could not determine. Answers are source-labeled and audited.</p></div>
        {state === 'ready' && <span className="text-xs font-extrabold">{answered} of {questions.length} answered</span>}
      </div>
      <form className="mt-3 flex gap-2" onSubmit={(event) => { event.preventDefault(); load(); }}>
        <label className="sr-only" htmlFor="extraction-source-document">Source document ID</label>
        <input id="extraction-source-document" value={documentId} onChange={(event) => setDocumentId(event.target.value)} placeholder="Source document UUID"
          className="h-9 min-w-0 flex-1 border border-[rgba(32,30,29,.35)] bg-white px-3 font-mono text-xs outline-none focus:border-[#ec3013]" />
        <button type="submit" disabled={!validId || state === 'loading'} className="h-9 bg-[#ec3013] px-4 text-xs font-extrabold text-white disabled:cursor-not-allowed disabled:opacity-35">Review</button>
      </form>
      {documentId && !validId && <p className="mt-1 text-[11px] text-[#b3261e]">Enter a well-formed source-document UUID.</p>}
    </div>
    {state === 'loading' && <div className="p-4 text-sm text-[rgba(32,30,29,.6)]">Loading extraction questions…</div>}
    {state === 'error' && <div className="p-4 text-sm text-[#b3261e]" role="alert">Questions could not be loaded. Check the document ID and try again.</div>}
    {state === 'ready' && !questions.length && <div className="p-4 text-sm text-[rgba(32,30,29,.65)]">No clarification is needed for this document.</div>}
    {state === 'ready' && questions.length > 0 && <div className="max-h-[420px] overflow-y-auto px-4">
      {questions.map((question) => <QuestionCard key={`${question.id}:${question.answer ?? ''}:${question.answer_source ?? ''}`} question={question}
        onSaved={(answer, answer_source) => setQuestions((rows) => rows.map((row) => row.id === question.id ? { ...row, answer, answer_source } : row))} />)}
    </div>}
  </section>;
}
