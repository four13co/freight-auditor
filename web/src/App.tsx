import { APP_NAME } from '@/lib/app-info';

export default function App() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50">
      <div className="rounded-lg bg-white p-8 text-center shadow-md">
        <h1 className="text-2xl font-semibold text-slate-900">{APP_NAME}</h1>
        <p className="mt-2 text-sm text-slate-500">
          Frontend scaffold rebuilding in progress.
        </p>
      </div>
    </main>
  );
}
