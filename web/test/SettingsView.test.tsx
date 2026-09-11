import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsView } from '../src/components/SettingsView.js';

const BRANDING = {
  branded: true,
  logoUrl: 'https://cdn.example.com/logo.png',
  primaryColor: '#112233',
  secondaryColor: '#445566',
};

describe('SettingsView (86e37r2t4)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes('/api/branding')) {
        return Promise.resolve(new Response(JSON.stringify(BRANDING), { status: 200 }));
      }
      if (url.includes('/api/internal/branding')) {
        const body = JSON.parse(String(init?.body ?? '{}'));
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('pre-fills the form from GET /api/branding', async () => {
    render(<SettingsView />);
    await waitFor(() => expect(screen.getByTestId('settings-form')).toBeInTheDocument());
    expect(screen.getByLabelText('Logo URL')).toHaveValue(BRANDING.logoUrl);
    expect(screen.getByLabelText('Primary color')).toHaveValue(BRANDING.primaryColor);
    expect(screen.getByLabelText('Secondary color')).toHaveValue(BRANDING.secondaryColor);
  });

  it('shows a loading state before the fetch resolves', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<SettingsView />);
    expect(screen.getByTestId('settings-loading')).toBeInTheDocument();
  });

  it('AC3: rejects an invalid logo URL client-side, with no PATCH request sent', async () => {
    const user = userEvent.setup();
    render(<SettingsView />);
    await waitFor(() => expect(screen.getByTestId('settings-form')).toBeInTheDocument());
    fetchMock.mockClear();

    await user.clear(screen.getByLabelText('Logo URL'));
    await user.type(screen.getByLabelText('Logo URL'), 'not-a-url');
    await user.click(screen.getByText('Save'));

    expect(await screen.findByTestId('settings-logo-url-error')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/internal/branding'))).toBe(false);
  });

  it('AC3: rejects a non-http(s) logo URL (e.g. ftp)', async () => {
    const user = userEvent.setup();
    render(<SettingsView />);
    await waitFor(() => expect(screen.getByTestId('settings-form')).toBeInTheDocument());
    fetchMock.mockClear();

    await user.clear(screen.getByLabelText('Logo URL'));
    await user.type(screen.getByLabelText('Logo URL'), 'ftp://example.com/logo.png');
    await user.click(screen.getByText('Save'));

    expect(await screen.findByTestId('settings-logo-url-error')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/internal/branding'))).toBe(false);
  });

  it('AC3: rejects an invalid primary color client-side, with no PATCH request sent', async () => {
    const user = userEvent.setup();
    render(<SettingsView />);
    await waitFor(() => expect(screen.getByTestId('settings-form')).toBeInTheDocument());
    fetchMock.mockClear();

    await user.clear(screen.getByLabelText('Primary color'));
    await user.type(screen.getByLabelText('Primary color'), 'red');
    await user.click(screen.getByText('Save'));

    expect(await screen.findByTestId('settings-primary-color-error')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/internal/branding'))).toBe(false);
  });

  it('AC3: rejects an invalid secondary color client-side, with no PATCH request sent', async () => {
    const user = userEvent.setup();
    render(<SettingsView />);
    await waitFor(() => expect(screen.getByTestId('settings-form')).toBeInTheDocument());
    fetchMock.mockClear();

    await user.clear(screen.getByLabelText('Secondary color'));
    await user.type(screen.getByLabelText('Secondary color'), 'blue');
    await user.click(screen.getByText('Save'));

    expect(await screen.findByTestId('settings-secondary-color-error')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/internal/branding'))).toBe(false);
  });

  it('allows a blank secondary color (clears it) without a validation error', async () => {
    const user = userEvent.setup();
    render(<SettingsView />);
    await waitFor(() => expect(screen.getByTestId('settings-form')).toBeInTheDocument());
    fetchMock.mockClear();

    await user.clear(screen.getByLabelText('Secondary color'));
    await user.click(screen.getByText('Save'));

    await waitFor(() => expect(screen.getByTestId('settings-saved')).toBeInTheDocument());
    expect(screen.queryByTestId('settings-secondary-color-error')).not.toBeInTheDocument();
    const call = fetchMock.mock.calls.find(([input]) => String(input).includes('/api/internal/branding'));
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ secondaryColor: null });
  });

  it('submits valid values and shows a save confirmation', async () => {
    const user = userEvent.setup();
    render(<SettingsView />);
    await waitFor(() => expect(screen.getByTestId('settings-form')).toBeInTheDocument());

    await user.clear(screen.getByLabelText('Primary color'));
    await user.type(screen.getByLabelText('Primary color'), '#abcdef');
    await user.click(screen.getByText('Save'));

    await waitFor(() => expect(screen.getByTestId('settings-saved')).toBeInTheDocument());
    const call = fetchMock.mock.calls.find(([input]) => String(input).includes('/api/internal/branding'));
    expect(call).toBeDefined();
    expect(call?.[1]?.method).toBe('PATCH');
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ primaryColor: '#abcdef' });
  });

  it('shows a save-error state when the PATCH request fails', async () => {
    const user = userEvent.setup();
    render(<SettingsView />);
    await waitFor(() => expect(screen.getByTestId('settings-form')).toBeInTheDocument());

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));

    await user.click(screen.getByText('Save'));
    await waitFor(() => expect(screen.getByTestId('settings-save-error')).toBeInTheDocument());
  });

  it('the primary color swatch reflects the current valid hex value', async () => {
    render(<SettingsView />);
    await waitFor(() => expect(screen.getByTestId('settings-form')).toBeInTheDocument());
    expect(screen.getByTestId('settings-primary-color-swatch')).toHaveStyle({ background: '#112233' });
  });
});
