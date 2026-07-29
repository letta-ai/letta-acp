import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export interface SessionRegistryRecord {
  agentId: string;
  sessionId: string;
  cwd: string;
  recordedAt: string;
}

/**
 * Adapter-owned persistence for ACP runtime metadata that Letta conversations
 * do not store. One file per conversation keeps concurrent editor processes
 * from overwriting unrelated sessions.
 */
export class SessionRegistry {
  private readonly records = new Map<string, SessionRegistryRecord>();
  private readonly pendingWrites = new Map<string, Promise<void>>();
  private readonly directory: string | null;

  constructor(rootDirectory: string | null, scope: string) {
    const namespace = createHash("sha256").update(scope).digest("hex").slice(0, 20);
    this.directory = rootDirectory ? resolve(rootDirectory, namespace) : null;
  }

  async record(agentId: string, sessionId: string, cwd: string): Promise<void> {
    if (!isAbsolute(cwd)) {
      throw new Error(`Cannot record ACP session ${sessionId}: cwd must be absolute`);
    }
    const record: SessionRegistryRecord = {
      agentId,
      sessionId,
      cwd: resolve(cwd),
      recordedAt: new Date().toISOString(),
    };
    this.records.set(sessionId, record);
    if (!this.directory) return;

    const previous = this.pendingWrites.get(sessionId) ?? Promise.resolve();
    const write = previous.catch(() => {}).then(async () => {
      await mkdir(this.directory!, { recursive: true, mode: 0o700 });
      const destination = this.pathFor(sessionId);
      const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      await rename(temporary, destination);
    });
    this.pendingWrites.set(sessionId, write);
    try {
      await write;
    } finally {
      if (this.pendingWrites.get(sessionId) === write) {
        this.pendingWrites.delete(sessionId);
      }
    }
  }

  async list(agentId: string, cwd?: string | null): Promise<SessionRegistryRecord[]> {
    await this.load();
    const normalizedCwd = cwd ? resolve(cwd) : null;
    return [...this.records.values()]
      .filter(
        (record) =>
          record.agentId === agentId &&
          (normalizedCwd === null || record.cwd === normalizedCwd),
      )
      .sort(
        (left, right) =>
          Date.parse(right.recordedAt) - Date.parse(left.recordedAt) ||
          left.sessionId.localeCompare(right.sessionId),
      );
  }

  async remove(sessionId: string): Promise<void> {
    this.records.delete(sessionId);
    if (!this.directory) return;
    await rm(this.pathFor(sessionId), { force: true });
  }

  private async load(): Promise<void> {
    if (!this.directory) return;
    let entries: string[];
    try {
      entries = await readdir(this.directory);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }

    const recordFiles = entries.filter((entry) => entry.endsWith(".json"));
    const presentSessionIds = new Set(
      recordFiles.flatMap((entry) => {
        try {
          return [decodeURIComponent(entry.slice(0, -".json".length))];
        } catch {
          return [];
        }
      }),
    );
    const diskRecords = await Promise.all(
      recordFiles.map(async (entry) => {
        try {
          const raw = await readFile(resolve(this.directory!, entry), "utf8");
          return parseRecord(JSON.parse(raw));
        } catch {
          // Ignore partial or corrupt records; a later successful open rewrites them.
          return null;
        }
      }),
    );

    for (const record of diskRecords) {
      if (!record) continue;
      const current = this.records.get(record.sessionId);
      if (!current || Date.parse(record.recordedAt) > Date.parse(current.recordedAt)) {
        this.records.set(record.sessionId, record);
      }
    }
    // Another adapter process may remove a record. Mirror that deletion without
    // pruning a same-process record whose serialized write is still pending.
    for (const sessionId of this.records.keys()) {
      if (!presentSessionIds.has(sessionId) && !this.pendingWrites.has(sessionId)) {
        this.records.delete(sessionId);
      }
    }
  }

  private pathFor(sessionId: string): string {
    return resolve(this.directory!, `${encodeURIComponent(sessionId)}.json`);
  }
}

function parseRecord(value: unknown): SessionRegistryRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.agentId !== "string" ||
    typeof record.sessionId !== "string" ||
    typeof record.cwd !== "string" ||
    !isAbsolute(record.cwd) ||
    typeof record.recordedAt !== "string" ||
    !Number.isFinite(Date.parse(record.recordedAt))
  ) {
    return null;
  }
  return {
    agentId: record.agentId,
    sessionId: record.sessionId,
    cwd: resolve(record.cwd),
    recordedAt: record.recordedAt,
  };
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
