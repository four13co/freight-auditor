import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import AuthLayout from '@/layouts/AuthLayout';

function renderWithChild(child: React.ReactNode) {
  return render(
    <MemoryRouter initialEntries={['/child']}>
      <Routes>
        <Route element={<AuthLayout />}>
          <Route path="/child" element={child} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('AuthLayout', () => {
  it('renders the wordmark and the outlet content together', () => {
    renderWithChild(<p>form content</p>);
    expect(screen.getByText('Freight Auditor')).toBeInTheDocument();
    expect(screen.getByText('form content')).toBeInTheDocument();
  });

  it('renders a footer with a copyright line', () => {
    renderWithChild(<p>form content</p>);
    expect(screen.getByText(new RegExp(`${new Date().getFullYear()} Freight Auditor`))).toBeInTheDocument();
  });
});
