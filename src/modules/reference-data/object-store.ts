import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Immutable, content-addressed blob storage for raw EDI + contract PDFs
 * (Master Spec §6.3, §6.9 — the immutable source layer Phase 0 must provide).
 *
 * The store is addressed by the sha256 of the bytes: storing the same bytes
 * twice yields the same URI and writes once (idempotent). Blobs are never
 * mutated or deleted — "edits" upstream become new documents.
 *
 * The backend is pluggable behind {@link ObjectStore}; prod may use an
 * S3-compatible store while dev uses local disk. Callers depend only on the
 * interface.
 */
export interface ObjectStore {
  /**
   * Store `bytes` and return its content address. Idempotent: re-storing
   * identical bytes returns the same URI without a second write.
   */
  put(bytes: Buffer): Promise<{ sha256: string; uri: string; byteSize: number }>;
  /** Fetch bytes by their sha256. Throws if absent. */
  get(sha256: string): Promise<Buffer>;
  /** Whether a blob with this sha256 already exists. */
  has(sha256: string): Promise<boolean>;
}

/** The sha256 hex digest of `bytes`. */
export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Local-disk {@link ObjectStore} for development / tests. Content-addressed
 * fan-out: <root>/ab/cd/<full-sha>. Prod swaps this for an S3-backed impl
 * behind the same interface.
 */
export class LocalDiskObjectStore implements ObjectStore {
  constructor(private readonly root: string) {}

  private pathFor(sha256: string): string {
    return join(this.root, sha256.slice(0, 2), sha256.slice(2, 4), sha256);
  }

  uriFor(sha256: string): string {
    return `file://${this.pathFor(sha256)}`;
  }

  async has(sha256: string): Promise<boolean> {
    try {
      await access(this.pathFor(sha256));
      return true;
    } catch {
      return false;
    }
  }

  async put(bytes: Buffer): Promise<{ sha256: string; uri: string; byteSize: number }> {
    const sha256 = sha256Hex(bytes);
    const path = this.pathFor(sha256);
    if (!(await this.has(sha256))) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    }
    return { sha256, uri: this.uriFor(sha256), byteSize: bytes.byteLength };
  }

  async get(sha256: string): Promise<Buffer> {
    return readFile(this.pathFor(sha256));
  }
}
