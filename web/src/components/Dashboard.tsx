import { useEffect, useState } from 'react';
import { Sidebar } from './Sidebar.js';
import { Header } from './Header.js';
import { KpiRow } from './KpiRow.js';
import { FindingsTable } from './FindingsTable.js';
import { fetchFindings, fetchFindingsSummary, type FindingRow, type FindingsSummary } from '../lib/api.js';

export function Dashboard() {
  const [summary, setSummary] = useState<FindingsSummary | null>(null);
  const [rows, setRows] = useState<FindingRow[]>([]);
  const [carrierFilter, setCarrierFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  useEffect(() => {
    fetchFindingsSummary().then(setSummary).catch(() => setSummary(null));
  }, []);

  useEffect(() => {
    fetchFindings({ carrier: carrierFilter || undefined, status: statusFilter || undefined })
      .then(setRows)
      .catch(() => setRows([]));
  }, [carrierFilter, statusFilter]);

  return (
    <div className="flex h-screen w-full bg-[#eae9e9] text-[#201e1d]">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Header />
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden p-6">
          {summary && <KpiRow summary={summary} />}
          <FindingsTable
            rows={rows}
            carrierFilter={carrierFilter}
            statusFilter={statusFilter}
            onCarrierFilterChange={setCarrierFilter}
            onStatusFilterChange={setStatusFilter}
          />
        </div>
      </div>
    </div>
  );
}
