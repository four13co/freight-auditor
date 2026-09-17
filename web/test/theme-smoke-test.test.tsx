import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ThemeSmokeTest from '@/pages/theme-smoke-test';

/**
 * Direct unit coverage of the shadcn/ui smoke surface, split out of
 * App.test.tsx (86e3a6rbe): that test rendered <App /> end-to-end and
 * relied on the dev-header path's default employee home landing on this
 * component, which stopped being true once EmployeeHomePage replaced the
 * shared placeholder HomePage at /employee/home. The underlying guarantee
 * (Tailwind + shadcn primitives render correctly) is unchanged, just
 * asserted directly against the component instead of indirectly through
 * routing that no longer reaches it by default.
 */
describe('ThemeSmokeTest', () => {
  it('renders Card, Button, Input, and Table primitives with sample data', () => {
    render(<ThemeSmokeTest />);
    expect(screen.getByText('shadcn/ui smoke test')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Primary action' })).toBeInTheDocument();
    expect(screen.getByLabelText('Carrier')).toBeInTheDocument();
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('SH-1001')).toBeInTheDocument();
  });
});
