/**
 * Pure planning core for the conflict-aware sync in `sync-guard.mjs`.
 *
 * No network, no filesystem: callers hand in three maps of
 * `path -> Buffer` (or, for the baseline, `path -> sha256`) and get back the
 * actions to execute. That keeps every classification rule testable without an
 * Overleaf account, the same reasoning as olcli's own `diff.ts` / `rename-plan.ts`.
 *
 * The baseline is the content both sides agreed on at the end of the previous
 * sync. Everything below is a three-way comparison against it:
 *
 *   localChanged  = local side differs from the baseline
 *   remoteChanged = remote side differs from the baseline
 *
 * "Only one side changed" is safe to propagate in that direction. "Both sides
 * changed" is a conflict unless both produced the same bytes; the executor may
 * still resolve it with a three-way merge, but it must never be resolved by
 * silently preferring one side.
 */
import { createHash } from 'node:crypto';

/** Content hash used for every baseline comparison. */
export function hashBuffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Classify every path that appears in the local tree, the remote tree, or the
 * baseline.
 *
 * @param {{
 *   local: Map<string, Buffer>,
 *   remote: Map<string, Buffer>,
 *   base: Map<string, string>,
 *   protectedPaths?: Set<string>,
 * }} input
 *   `base` maps path -> sha256 of the last agreed content. `protectedPaths` are
 *   paths with unsaved editor buffers: any action that would write or delete
 *   them is downgraded to a conflict instead.
 * @returns {{
 *   pull: string[],
 *   push: string[],
 *   deleteRemote: string[],
 *   deleteLocal: string[],
 *   unchanged: string[],
 *   conflicts: Array<{ path: string, kind: string, protected?: boolean }>,
 * }}
 */
export function planSync({ local, remote, base, protectedPaths = new Set() }) {
  const plan = {
    pull: [],
    push: [],
    deleteRemote: [],
    deleteLocal: [],
    unchanged: [],
    conflicts: [],
  };
  const paths = new Set([...local.keys(), ...remote.keys(), ...base.keys()]);
  for (const path of [...paths].sort()) {
    const localContent = local.get(path);
    const remoteContent = remote.get(path);
    const baseHash = base.get(path);
    const localExists = localContent !== undefined;
    const remoteExists = remoteContent !== undefined;
    const baseExists = baseHash !== undefined;
    const localHash = localExists ? hashBuffer(localContent) : undefined;
    const remoteHash = remoteExists ? hashBuffer(remoteContent) : undefined;
    const localChanged = localExists !== baseExists || (localExists && baseExists && localHash !== baseHash);
    const remoteChanged = remoteExists !== baseExists || (remoteExists && baseExists && remoteHash !== baseHash);
    const isProtected = protectedPaths.has(path);

    if (!localChanged && !remoteChanged) {
      plan.unchanged.push(path);
      continue;
    }
    // Only local changed: publishing that change cannot lose remote work.
    if (localChanged && !remoteChanged) {
      if (localExists) plan.push.push(path);
      else plan.deleteRemote.push(path);
      continue;
    }
    // Only remote changed: pulling it cannot lose local work, unless an editor
    // holds unsaved changes for that path.
    if (!localChanged && remoteChanged) {
      if (isProtected) {
        plan.conflicts.push({ path, kind: 'local-unsaved', protected: true });
      } else if (remoteExists) {
        plan.pull.push(path);
      } else {
        plan.deleteLocal.push(path);
      }
      continue;
    }
    // Both changed from the same baseline.
    if (!localExists && !remoteExists) {
      // Both sides deleted it; nothing to do, the baseline entry just retires.
      plan.unchanged.push(path);
      continue;
    }
    if (localExists && remoteExists && localHash === remoteHash) {
      // Both sides converged on the same bytes; no conflict, just re-baseline.
      plan.unchanged.push(path);
      continue;
    }
    if (isProtected) {
      plan.conflicts.push({ path, kind: 'local-unsaved', protected: true });
      continue;
    }
    if (localExists && remoteExists) {
      plan.conflicts.push({ path, kind: baseExists ? 'both-modified' : 'both-added' });
    } else if (localExists) {
      plan.conflicts.push({ path, kind: 'remote-deleted-local-modified' });
    } else {
      plan.conflicts.push({ path, kind: 'local-deleted-remote-modified' });
    }
  }
  return plan;
}

/**
 * Reconstruct a baseline for a directory that predates `sync-guard.mjs`, using
 * the state `olcli pull` / `olcli sync` left behind.
 *
 * The old sync only recorded `lastPull` (a timestamp) and the remote path
 * manifest, never content hashes, so the baseline can only be inferred:
 *
 * - bytes equal on both sides -> both agreed, use them;
 * - bytes differ, local mtime newer than `lastPull` -> the remote copy was the
 *   agreed one (local edited it);
 * - bytes differ, local not newer -> the local copy was the agreed one
 *   (remote edited it), which matches olcli's own push/pull rule;
 * - no `lastPull` at all -> prefer the local copy, matching `--all` push
 *   semantics, so the first safe sync cannot silently discard local edits;
 * - a file missing on one side is invisible to that rule, so the manifest is
 *   the only signal: tracked-only-on-remote means the local copy is... absent
 *   because it was deleted locally; tracked-only-locally means the remote copy
 *   was deleted remotely.
 *
 * The inference is a one-time bootstrap: after the first run every path has a
 * real hash baseline.
 *
 * @param {{
 *   local: Map<string, Buffer>,
 *   remote: Map<string, Buffer>,
 *   localMtimes?: Map<string, number>,
 *   manifest?: string[],
 *   lastPull?: string,
 * }} input
 * @returns {{ base: Map<string, string>, baseContent: Map<string, Buffer> }}
 */
export function bootstrapBase({ local, remote, localMtimes = new Map(), manifest = [], lastPull }) {
  const base = new Map();
  const baseContent = new Map();
  const manifestSet = new Set(manifest);
  const lastPullMs = lastPull ? Date.parse(lastPull) : Number.NaN;
  const hasLastPull = Number.isFinite(lastPullMs);
  const paths = new Set([...local.keys(), ...remote.keys(), ...manifestSet]);
  for (const path of [...paths].sort()) {
    const localContent = local.get(path);
    const remoteContent = remote.get(path);
    const localExists = localContent !== undefined;
    const remoteExists = remoteContent !== undefined;
    let agreed;
    if (localExists && remoteExists) {
      agreed = hashBuffer(localContent) === hashBuffer(remoteContent)
        ? localContent
        : hasLastPull && (localMtimes.get(path) ?? 0) > lastPullMs
          ? remoteContent
          : hasLastPull
            ? localContent
            : remoteContent; // no timestamp: local wins, matching a full push
    } else if (localExists) {
      // Only locally: either a new local file, or a remote deletion. With a
      // manifest entry and an unchanged mtime the deletion was remote's.
      const locallyEdited = hasLastPull && (localMtimes.get(path) ?? 0) > lastPullMs;
      agreed = manifestSet.has(path) && !locallyEdited ? localContent : undefined;
    } else if (remoteExists) {
      // Only remotely: either a new remote file, or a local deletion.
      agreed = manifestSet.has(path) ? remoteContent : undefined;
    }
    if (agreed !== undefined) {
      base.set(path, hashBuffer(agreed));
      baseContent.set(path, agreed);
    }
  }
  return { base, baseContent };
}
