import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ThemeProvider, useTheme } from '@/providers/theme-provider';

function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme-value">{theme}</span>
      <button onClick={() => setTheme('dark')}>go dark</button>
      <button onClick={() => setTheme('light')}>go light</button>
    </div>
  );
}

describe('ThemeProvider', () => {
  it('applies the dark class to the document root when switched to dark', async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider defaultTheme="light">
        <ThemeSwitcher />
      </ThemeProvider>,
    );

    expect(document.documentElement.classList.contains('dark')).toBe(false);

    await user.click(screen.getByRole('button', { name: 'go dark' }));

    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(screen.getByTestId('theme-value')).toHaveTextContent('dark');
  });

  it('switches back to light and removes the dark class', async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider defaultTheme="dark">
        <ThemeSwitcher />
      </ThemeProvider>,
    );

    expect(document.documentElement.classList.contains('dark')).toBe(true);

    await user.click(screen.getByRole('button', { name: 'go light' }));

    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});
