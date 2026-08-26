import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RubricConflictQueue } from '../src/components/RubricConflictQueue.js';

describe('RubricConflictQueue', () => {
  it('shows the criterion, conflict type, and stable reason', () => {
    render(<RubricConflictQueue rows={[{ id: '1', criterion_key: 'RATE', conflict_type: 'NON_MONOTONE_TIGHTEN',
      detail: { reason: 'BOUND_WEAKENED' }, recorded_at: '2026-01-01' }]} />);
    expect(screen.getByTestId('rubric-conflict-queue')).toHaveTextContent('RATE');
    expect(screen.getByText('BOUND_WEAKENED')).toBeInTheDocument();
  });
});
