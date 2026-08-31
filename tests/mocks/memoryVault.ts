/** An in-memory VaultIO, so engine tests never touch a real filesystem. */
import { VaultIO } from "../../src/markdown/vaultIo";

export class MemoryVault implements VaultIO {
  readonly files = new Map<string, string>();
  /** Every path ever written, in order - used to assert write counts. */
  readonly writeLog: string[] = [];
  /** Paths moved to trash, so tests can assert nothing was hard-deleted. */
  readonly trashed: string[] = [];
  /** Set to a path to make writes to it throw. */
  failWritesTo: string | null = null;

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async read(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`ENOENT: ${path}`);
    return value;
  }

  async create(path: string, content: string): Promise<void> {
    await this.write(path, content);
  }

  /**
   * Mirrors Vault.process: the callback sees the current contents, and a throw
   * from it aborts the write rather than corrupting the file.
   */
  async process(path: string, fn: (data: string) => string): Promise<void> {
    const current = this.files.get(path);
    if (current === undefined) throw new Error(`ENOENT: ${path}`);
    const next = fn(current);
    if (this.failWritesTo === path) throw new Error(`simulated write failure: ${path}`);
    this.files.set(path, next);
    this.writeLog.push(path);
  }

  async write(path: string, content: string): Promise<void> {
    if (this.failWritesTo === path) throw new Error(`simulated write failure: ${path}`);
    this.files.set(path, content);
    this.writeLog.push(path);
  }

  async listFiles(folder: string): Promise<string[]> {
    const prefix = folder === "" ? "" : `${folder}/`;
    return [...this.files.keys()].filter(
      (p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"),
    );
  }

  async trash(path: string): Promise<void> {
    if (this.files.delete(path)) this.trashed.push(path);
  }
}
