import { BrowserRouter } from 'react-router-dom';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ThemeProvider } from '@/providers/theme-provider';
import { AuthProvider } from '@/providers/auth-provider';
import { TenantProvider } from '@/providers/TenantProvider';
import { AppRoutes } from '@/app-routes';

export default function App() {
  return (
    <ThemeProvider defaultTheme="system" storageKey="freight-auditor-theme">
      <AuthProvider>
        <TenantProvider>
          <TooltipProvider>
            <BrowserRouter>
              <AppRoutes />
            </BrowserRouter>
            <Toaster />
          </TooltipProvider>
        </TenantProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}
