/**
 * Vault I/O.
 *
 * Built on Obsidian's **Vault API**, not the Adapter API. The developer
 * guidelines are explicit about this: the Vault API is cached, is safe across
 * vault adapters, and keeps Obsidian's own file index in step with what we
 * write. The Adapter API is only appropriate for hidden folders, which we never
 * touch.
 *
 * The important method here is {@link VaultIO.process}. Obsidian's
 * `Vault.process()` performs an atomic read-modify-write, so a note is
 * transformed from whatever is on disk at that instant rather than from a copy
 * we read earlier. That is what makes it impossible for this plugin to clobber
 * an edit the user made a moment before a sync wrote the same file - the docs
 * put it plainly: "Always prefer Vault.process() over Vault.read()/Vault.modify()
 * to avoid unintentional loss of data."
 */
import { App, TFile, TFolder, normalizePath } from "obsidian";

export interface VaultIO {
  exists(path: string): Promise<boolean>;
  /** Full contents. Used before a decision that depends on what is on disk. */
  read(path: string): Promise<string>;
  /** Create a new note, including any missing parent folders. */
  create(path: string, content: string): Promise<void>;
  /**
   * Atomically transform an existing note. `fn` must be synchronous and pure;
   * it receives the freshest contents and returns the replacement. Throwing
   * from `fn` aborts the write, leaving the note untouched.
   */
  process(path: string, fn: (data: string) => string): Promise<void>;
  /** Create or wholly replace a generated file. Only for files we own outright. */
  write(path: string, content: string): Promise<void>;
  /** Vault-relative paths of files directly inside `folder`. Empty if absent. */
  listFiles(folder: string): Promise<string[]>;
  /** Move to trash, honouring the user's "Deleted files" preference. */
  trash(path: string): Promise<void>;
}

function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "" : path.slice(0, i);
}

export class ObsidianVaultIO implements VaultIO {
  constructor(private readonly app: App) {}

  async exists(path: string): Promise<boolean> {
    return this.app.vault.getFileByPath(normalizePath(path)) !== null;
  }

  async read(path: string): Promise<string> {
    return this.app.vault.read(this.requireFile(path));
  }

  async create(path: string, content: string): Promise<void> {
    const target = normalizePath(path);
    await this.ensureFolder(parentOf(target));
    try {
      await this.app.vault.create(target, content);
    } catch (err) {
      // Another process may have created it between our check and this call.
      const existing = this.app.vault.getFileByPath(target);
      if (!existing) throw err;
      await this.app.vault.process(existing, () => content);
    }
  }

  async process(path: string, fn: (data: string) => string): Promise<void> {
    await this.app.vault.process(this.requireFile(path), fn);
  }

  async write(path: string, content: string): Promise<void> {
    const target = normalizePath(path);
    const existing = this.app.vault.getFileByPath(target);
    if (existing) {
      await this.app.vault.process(existing, () => content);
      return;
    }
    await this.create(target, content);
  }

  async listFiles(folder: string): Promise<string[]> {
    const target = this.app.vault.getFolderByPath(normalizePath(folder));
    if (!target) return [];
    return target.children
      .filter((child): child is TFile => child instanceof TFile)
      .map((f) => f.path);
  }

  async trash(path: string): Promise<void> {
    const file = this.app.vault.getFileByPath(normalizePath(path));
    if (!file) return;
    await this.app.fileManager.trashFile(file);
  }

  private requireFile(path: string): TFile {
    const target = normalizePath(path);
    const file = this.app.vault.getFileByPath(target);
    if (!file) throw new Error(`File not found in vault: ${target}`);
    return file;
  }

  /** Create a folder and its ancestors, tolerating concurrent creation. */
  private async ensureFolder(path: string): Promise<void> {
    const target = normalizePath(path);
    if (target === "" || target === "/" || target === ".") return;
    if (this.app.vault.getFolderByPath(target) instanceof TFolder) return;

    await this.ensureFolder(parentOf(target));
    try {
      await this.app.vault.createFolder(target);
    } catch {
      // Obsidian throws if it already exists; only a genuine absence is an error.
      if (!(this.app.vault.getFolderByPath(target) instanceof TFolder)) {
        throw new Error(`Could not create folder: ${target}`);
      }
    }
  }
}
