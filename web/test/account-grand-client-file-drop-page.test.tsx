import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import GrandClientFileDropPage from '@/pages/account/GrandClientFileDropPage';

let nextId = 0;
function freshGrandClient() {
  nextId += 1;
  return { id: `gc-file-drop-${nextId}`, name: `Grand Client ${nextId}` };
}

let activeGrandClient: { id: string; name: string } | null = null;
vi.mock('@/providers/TenantProvider', () => ({
  useTenant: () => ({ activeGrandClient, setActiveGrandClient: () => {} }),
}));

function makeFile(name: string, type: string, content = 'x'.repeat(10)) {
  return new File([content], name, { type });
}

/** Waits until every in-flight upload's progress bar has resolved (submit() landed the row in the store). */
async function waitForUploadsToSettle() {
  await waitFor(() => expect(screen.queryAllByRole('progressbar')).toHaveLength(0), { timeout: 3000 });
}

describe('GrandClientFileDropPage', () => {
  it('AC: prompts to select a Grand Client when none is active', () => {
    activeGrandClient = null;
    render(<GrandClientFileDropPage />);
    expect(screen.getByText('Select a Grand Client to drop files for it.')).toBeInTheDocument();
  });

  it('AC: click-to-upload works, shows a progress bar, then lands in the recent uploads table', async () => {
    activeGrandClient = freshGrandClient();
    const user = userEvent.setup();
    render(<GrandClientFileDropPage />);

    const file = makeFile('invoice.pdf', 'application/pdf');
    await user.upload(screen.getByLabelText('Choose files to upload'), file);

    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    await waitForUploadsToSettle();

    expect(screen.getByText('invoice.pdf').closest('tr')).not.toBeNull();
    expect(within(screen.getByText('invoice.pdf').closest('tr')!).getByText('Submitted')).toBeInTheDocument();
  });

  it('AC: drag-and-drop works and multiple files are supported', async () => {
    activeGrandClient = freshGrandClient();
    render(<GrandClientFileDropPage />);

    const dropzone = screen.getByRole('button', { name: 'Drop files here or click to upload' });
    const files = [makeFile('rates.csv', 'text/csv'), makeFile('contract.pdf', 'application/pdf')];
    fireEvent.drop(dropzone, { dataTransfer: { files } });

    await waitForUploadsToSettle();

    expect(screen.getByText('rates.csv').closest('tr')).not.toBeNull();
    expect(screen.getByText('contract.pdf').closest('tr')).not.toBeNull();
  });

  it('AC: client-side file type validation rejects unsupported types', async () => {
    activeGrandClient = freshGrandClient();
    const user = userEvent.setup();
    render(<GrandClientFileDropPage />);

    const file = makeFile('malware.exe', 'application/octet-stream');
    await user.upload(screen.getByLabelText('Choose files to upload'), file);

    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.getByText(`No uploads yet for ${activeGrandClient.name}.`)).toBeInTheDocument();
  });

  it('AC: uploads shown are scoped to the selected Grand Client only', async () => {
    const gcA = freshGrandClient();
    const gcB = freshGrandClient();
    const user = userEvent.setup();

    activeGrandClient = gcA;
    const { unmount } = render(<GrandClientFileDropPage />);
    await user.upload(screen.getByLabelText('Choose files to upload'), makeFile('only-a.pdf', 'application/pdf'));
    await waitForUploadsToSettle();
    expect(screen.getByText('only-a.pdf').closest('tr')).not.toBeNull();
    unmount();

    activeGrandClient = gcB;
    render(<GrandClientFileDropPage />);
    expect(screen.queryByText('only-a.pdf')).not.toBeInTheDocument();
  });

  it('AC: Delete row action removes a still-pending (submitted) upload', async () => {
    activeGrandClient = freshGrandClient();
    const user = userEvent.setup();
    render(<GrandClientFileDropPage />);

    await user.upload(screen.getByLabelText('Choose files to upload'), makeFile('invoice.pdf', 'application/pdf'));
    await waitForUploadsToSettle();

    const row = screen.getByText('invoice.pdf').closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Delete' }));

    expect(screen.queryByText('invoice.pdf')).not.toBeInTheDocument();
  });

  it('AC: responsive table scrolls horizontally (overflow-x-auto container)', () => {
    activeGrandClient = freshGrandClient();
    const { container } = render(<GrandClientFileDropPage />);
    expect(container.querySelector('[data-slot="table-container"].overflow-x-auto')).not.toBeNull();
  });
});
