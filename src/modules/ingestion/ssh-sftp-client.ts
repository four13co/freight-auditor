import SftpClientLibrary from 'ssh2-sftp-client';
import type { SftpClient, SftpRemoteEntry } from './sftp-intake.js';

export interface SshSftpConfig {
  host: string;
  port: number;
  username: string;
  privateKey: string;
  hostKeySha256: string;
}

export class SshSftpClient implements SftpClient {
  private readonly client = new SftpClientLibrary('freight-auditor-sftp');
  private connected = false;

  constructor(private readonly config: SshSftpConfig) {}

  private async connect(): Promise<void> {
    if (this.connected) return;
    await this.client.connect({
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      privateKey: this.config.privateKey,
      hostHash: 'sha256',
      hostVerifier: (fingerprint: string) => fingerprint.toLowerCase() === this.config.hostKeySha256.toLowerCase(),
      readyTimeout: 20_000,
    });
    this.connected = true;
  }

  async list(remotePath: string): Promise<readonly SftpRemoteEntry[]> {
    await this.connect();
    const entries = await this.client.list(remotePath);
    return entries.filter((entry) => entry.type !== 'd').map((entry) => ({
      path: `${remotePath.replace(/\/$/, '')}/${entry.name}`,
      size: entry.size,
      modifiedAt: new Date(entry.modifyTime).toISOString(),
    }));
  }

  async read(path: string): Promise<Buffer> {
    await this.connect();
    const value = await this.client.get(path);
    if (!Buffer.isBuffer(value)) throw new Error('SFTP_NON_BUFFER_RESPONSE');
    return value;
  }

  async close(): Promise<void> {
    if (this.connected) await this.client.end();
    this.connected = false;
  }
}
