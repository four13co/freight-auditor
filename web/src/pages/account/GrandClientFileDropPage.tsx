import { useRef, useState, type DragEvent } from 'react';
import { toast } from 'sonner';
import { Upload } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn } from '@/components/data-table/DataTable';
import { GrandClientSelector } from '@/components/GrandClientSelector';
import { useScopedFiles, type ScopedFile } from '@/lib/in-memory-hierarchy-store';
import { useTenant } from '@/providers/TenantProvider';

const ACCEPTED_EXTENSIONS = ['.pdf', '.csv', '.xls', '.xlsx', '.edi', '.x12'];

function isAcceptedFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => name.endsWith(ext));
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const STATUS_BADGE_VARIANT: Record<ScopedFile['status'], 'outline' | 'secondary' | 'default' | 'destructive'> = {
  submitted: 'outline',
  processing: 'secondary',
  complete: 'default',
  failed: 'destructive',
};

const STATUS_LABEL: Record<ScopedFile['status'], string> = {
  submitted: 'Submitted',
  processing: 'Processing',
  complete: 'Complete',
  failed: 'Failed',
};

interface InFlightUpload {
  id: string;
  name: string;
  progress: number;
}

/**
 * 86e3a6rj8: file drop for a selected Grand Client's documents. No real
 * upload route reaches here -- portal-contract-upload-routes.ts's pattern
 * (the closest real precedent) needs a real client_id and an existing
 * contract/carrier row to attach to; Grand Client is neither, same gap as
 * every other Grand-Client-scoped screen. Routes through the shared
 * in-memory-hierarchy-store's new ScopedFile (Bridge decision on
 * 86e3a6r3b), scoped by `grandClientFiles:<id>`. "Upload" here means
 * accepting the file into that in-memory roster (an "uploading" progress
 * animation, then a `submitted` row) rather than a real network transfer --
 * disclosed in this PR's Uncertainties.
 */
export default function GrandClientFileDropPage() {
  const { activeGrandClient } = useTenant();
  const scopeKey = activeGrandClient ? `grandClientFiles:${activeGrandClient.id}` : null;
  const { files, submit, remove } = useScopedFiles(scopeKey);
  const [inFlight, setInFlight] = useState<InFlightUpload[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleFiles(fileList: FileList | File[]) {
    const incoming = Array.from(fileList);
    for (const file of incoming) {
      if (!isAcceptedFile(file)) {
        toast.error(`${file.name}: unsupported file type. Accepted: PDF, CSV, EDI, Excel.`);
        continue;
      }
      const uploadId = crypto.randomUUID();
      setInFlight((prev) => [...prev, { id: uploadId, name: file.name, progress: 0 }]);

      let progress = 0;
      const interval = setInterval(() => {
        progress += 34;
        if (progress >= 100) {
          clearInterval(interval);
          setInFlight((prev) => prev.filter((u) => u.id !== uploadId));
          submit({ name: file.name, type: file.type || file.name.split('.').pop() || 'unknown', size: file.size });
        } else {
          setInFlight((prev) => prev.map((u) => (u.id === uploadId ? { ...u, progress } : u)));
        }
      }, 60);
    }
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
  }

  const columns: DataTableColumn<ScopedFile>[] = [
    { key: 'name', header: 'File name', sortValue: (f) => f.name, render: (f) => f.name },
    { key: 'type', header: 'Type', sortValue: (f) => f.type, render: (f) => f.type },
    { key: 'size', header: 'Size', sortValue: (f) => f.size, render: (f) => formatSize(f.size) },
    {
      key: 'uploadedAt',
      header: 'Upload date',
      sortValue: (f) => f.uploadedAt,
      render: (f) => new Date(f.uploadedAt).toLocaleDateString(),
    },
    {
      key: 'status',
      header: 'Status',
      sortValue: (f) => f.status,
      render: (f) => <Badge variant={STATUS_BADGE_VARIANT[f.status]}>{STATUS_LABEL[f.status]}</Badge>,
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (f) => (
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" disabled>
            Download
          </Button>
          {f.status === 'submitted' && (
            <Button variant="ghost" size="sm" onClick={() => remove(f.id)}>
              Delete
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Grand Client File Drop</h1>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <GrandClientSelector />
      </div>

      {!activeGrandClient ? (
        <p className="text-sm text-muted-foreground">Select a Grand Client to drop files for it.</p>
      ) : (
        <>
          <div
            role="button"
            tabIndex={0}
            aria-label="Drop files here or click to upload"
            onClick={() => inputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click();
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragOver(true);
            }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={handleDrop}
            className={`flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-10 text-center transition-colors ${
              isDragOver ? 'border-primary bg-primary/5' : 'border-border'
            }`}
          >
            <Upload className="size-8 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm font-medium">Drag and drop files here, or click to browse</p>
            <p className="text-xs text-muted-foreground">PDF, CSV, EDI (210/310), Excel</p>
            <input
              ref={inputRef}
              type="file"
              multiple
              className="sr-only"
              aria-label="Choose files to upload"
              onChange={(e) => {
                if (e.target.files?.length) handleFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </div>

          {inFlight.length > 0 && (
            <div className="flex flex-col gap-2">
              {inFlight.map((u) => (
                <div key={u.id} className="flex flex-col gap-1">
                  <span className="text-sm">{u.name}</span>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={u.progress} aria-valuemin={0} aria-valuemax={100}>
                    <div className="h-full bg-primary transition-all" style={{ width: `${Math.min(u.progress, 100)}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}

          <DataTable
            rows={files}
            columns={columns}
            getRowId={(f) => f.id}
            searchPlaceholder="Search uploads…"
            searchPredicate={(f, q) => f.name.toLowerCase().includes(q.toLowerCase())}
            emptyState={`No uploads yet for ${activeGrandClient.name}.`}
          />
        </>
      )}
    </div>
  );
}
