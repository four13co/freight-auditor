import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ThemeProvider } from '@/providers/theme-provider';
import ThemeSmokeTest from '@/pages/theme-smoke-test';

export default function App() {
  return (
    <ThemeProvider defaultTheme="system" storageKey="freight-auditor-theme">
      <TooltipProvider>
        <ThemeSmokeTest />
        <Toaster />
      </TooltipProvider>
    </ThemeProvider>
  );
}
