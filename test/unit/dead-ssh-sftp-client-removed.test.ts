import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');

/**
 * 86e367qyz: SshSftpClient (src/modules/ingestion/ssh-sftp-client.ts) had
 * zero call sites outside its own file -- POLL_SFTP_V1, the job that would
 * have constructed it, was removed entirely in 86e32tfxj (no secret-
 * resolution mechanism exists for sftp_connection.private_key_secret_ref).
 * No revival work references it, so this takes the "delete" branch of the
 * task's either/or AC rather than the "document as dormant" branch.
 */
describe('dead SshSftpClient adapter is removed', () => {
  it('ssh-sftp-client.ts no longer exists', () => {
    expect(existsSync(join(ROOT, 'src/modules/ingestion/ssh-sftp-client.ts'))).toBe(false);
  });

  it('package.json no longer lists the ssh2-sftp-client deps', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.dependencies?.['ssh2-sftp-client']).toBeUndefined();
    expect(pkg.devDependencies?.['@types/ssh2-sftp-client']).toBeUndefined();
  });
});
