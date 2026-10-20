/**
 * Three-way merge for text files that changed on both sides.
 *
 * Delegates to `git merge-file`, which is a real diff3 implementation rather
 * than a reimplementation of one: the merged result is only used when every
 * hunk can be resolved without overlap, and the temporary files it needs are
 * always cleaned up. When git is missing or the merge overlaps, the caller
 * keeps both versions as conflict copies instead of guessing.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Same sniff window git uses: a NUL byte near the start means "not text". */
const BINARY_SNIFF_BYTES = 8000;

export function isBinary(buffer) {
  if (!buffer) return false;
  const end = Math.min(buffer.length, BINARY_SNIFF_BYTES);
  for (let index = 0; index < end; index += 1) {
    if (buffer[index] === 0) return true;
  }
  return false;
}

/**
 * Attempt a clean three-way merge.
 *
 * @param {{ base?: Buffer, local?: Buffer, remote?: Buffer, timeoutMs?: number }} input
 * @returns {{ merged?: Buffer, conflict: boolean, reason?: string }}
 *   `merged` is set only when the merge is clean. `reason` explains a refusal
 *   (`missing-side`, `binary`, `overlap`, `git-missing`, `merge-failed`).
 */
export function mergeThreeWay({ base, local, remote, timeoutMs = 15000 }) {
  if (!base || !local || !remote) return { conflict: true, reason: 'missing-side' };
  if (isBinary(base) || isBinary(local) || isBinary(remote)) return { conflict: true, reason: 'binary' };

  const directory = mkdtempSync(join(tmpdir(), 'olcli-merge-'));
  try {
    const basePath = join(directory, 'base');
    const localPath = join(directory, 'local');
    const remotePath = join(directory, 'remote');
    writeFileSync(basePath, base);
    writeFileSync(localPath, local);
    writeFileSync(remotePath, remote);
    try {
      const merged = execFileSync(
        'git',
        ['merge-file', '-p', '--diff3', '-L', 'local', '-L', 'base', '-L', 'remote', localPath, basePath, remotePath],
        { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      );
      return { merged, conflict: false };
    } catch (error) {
      // git merge-file exits 1 when the file contains conflicting hunks and >1
      // when it could not run at all.
      if (error && error.status === 1) return { conflict: true, reason: 'overlap' };
      return { conflict: true, reason: error && error.code === 'ENOENT' ? 'git-missing' : 'merge-failed' };
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
