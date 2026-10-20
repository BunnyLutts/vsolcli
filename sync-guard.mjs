#!/usr/bin/env node
/**
 * Conflict-aware bidirectional sync between a local directory and an Overleaf
 * project.
 *
 * `olcli sync` (the CLI this extension wraps) resolves a split by modification
 * time: whichever side's file is newer than the last pull wins, and the other
 * side is overwritten without a warning. That is fine for a single writer and
 * the wrong tool for two machines or a collaborator in the web editor.
 *
 * This script keeps a content baseline of the last agreed state, runs a real
 * three-way comparison (local vs remote vs baseline), and then:
 *
 *   only local changed  -> upload
 *   only remote changed -> download (or delete locally)
 *   both changed        -> three-way merge when git can do it cleanly,
 *                          otherwise keep both versions and report a conflict
 *
 * Nothing is ever overwritten just because it is older. Bytes on disk win only
 * when the other side did not change since the baseline.
 *
 * Usage:
 *   node sync-guard.mjs <baseUrl> <cookieName> <timeoutMs>
 *        [--dry-run] [--prefer-local | --prefer-remote]
 *
 * Environment:
 *   OVERLEAF_SESSION        session cookie (required)
 *   OLCLI_PROTECTED_PATHS   JSON array of project-relative paths whose editor
 *                           buffer has unsaved changes; they are never written
 *                           or deleted by this run
 *   OLCLI_LOCK_WAIT_MS      how long to wait for a concurrent sync's lock
 *
 * stdout: one JSON summary object. stderr + exit 1: hard failure (auth,
 * network, bad usage).
 *
 * Local bookkeeping (all dot-prefixed, so olcli's scan skips them):
 *   .olcli-sync-state.json  path -> sha256 baseline of the last agreed state
 *   .olcli-base/            baseline content, used as the merge base
 *   .olcli-conflicts/       remote copies kept for unresolved conflicts
 *   .olcli-sync.lock        advisory lock against concurrent runs
 *
 * `.olcli.json` is updated after a conflict-free run so that plain `olcli`
 * commands keep working against a sensible lastPull/manifest.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { planSync, bootstrapBase, hashBuffer } from './sync-plan.mjs';
import { mergeThreeWay } from './sync-merge.mjs';

const require = createRequire(import.meta.url);
const cliEntry = require.resolve('@aloth/olcli/cli');
const olcliRequire = createRequire(cliEntry);
const packageDirectory = path.dirname(cliEntry);
const loadPackageModule = name => import(pathToFileURL(path.join(packageDirectory, name)).href);
const { OverleafClient } = await loadPackageModule('client.js');
const { scanLocalFiles } = await loadPackageModule('scan.js');
const { loadIgnore } = await loadPackageModule('ignore.js');
const { resolveWithin } = await loadPackageModule('paths.js');
const { filterRemoteTree } = await loadPackageModule('diff.js');
const AdmZip = olcliRequire('adm-zip');

const STATE_FILE = '.olcli-sync-state.json';
const BASE_DIR = '.olcli-base';
const CONFLICT_DIR = '.olcli-conflicts';
const LOCK_FILE = '.olcli-sync.lock';
const STATE_VERSION = 1;
const STALE_LOCK_MS = 10 * 60 * 1000;
const DEFAULT_LOCK_WAIT_MS = 2000;

// ─── Command line ────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flags = new Set();
const positional = [];
for (const argument of argv) {
  if (argument === '--dry-run' || argument === '--prefer-local' || argument === '--prefer-remote') flags.add(argument);
  else positional.push(argument);
}
const [baseUrl, cookieName = 'overleaf_session2', timeoutArgument] = positional;
const timeoutMs = Number(timeoutArgument) > 0 ? Number(timeoutArgument) : 60000;
const dryRun = flags.has('--dry-run');
const prefer = flags.has('--prefer-local') ? 'local' : flags.has('--prefer-remote') ? 'remote' : undefined;

function fail(message) {
  process.stderr.write(message);
  process.exit(1);
}

if (!baseUrl) fail('usage: sync-guard.mjs <baseUrl> <cookieName> <timeoutMs> [--dry-run] [--prefer-local|--prefer-remote]');
if (flags.has('--prefer-local') && flags.has('--prefer-remote')) fail('cannot combine --prefer-local and --prefer-remote');

// ─── Small helpers ───────────────────────────────────────────────────────────

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function writeJson(file, value) {
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, JSON.stringify(value, null, 2));
  renameSync(temporary, file);
}

function localMeta(directory) {
  return readJson(path.join(directory, '.olcli.json')) ?? {};
}

function projectIdIn(directory) {
  // Mirrors the extension's compile wrapper: .olcli.json is what the CLI writes
  // on pull/sync, .olcli-project.json is what the extension writes on pull.
  for (const name of ['.olcli.json', '.olcli-project.json']) {
    const file = path.join(directory, name);
    if (!existsSync(file)) continue;
    const meta = readJson(file);
    if (meta && typeof meta.projectId === 'string' && meta.projectId) return meta.projectId;
  }
  return undefined;
}

function protectedPathsFromEnvironment() {
  const raw = process.env.OLCLI_PROTECTED_PATHS;
  if (!raw) return new Set();
  try {
    const list = JSON.parse(raw);
    return new Set(Array.isArray(list) ? list.filter(entry => typeof entry === 'string') : []);
  } catch {
    return new Set();
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// ─── Advisory lock ───────────────────────────────────────────────────────────

/**
 * Prevent two runs in the same project directory from interleaving. This is
 * per-directory, so it protects multiple editor windows on one machine; two
 * machines still race, which is why the baseline comparison exists.
 *
 * Returns a release function, or null when another live run holds the lock for
 * longer than the wait budget.
 */
async function acquireLock(directory) {
  const lockPath = path.join(directory, LOCK_FILE);
  const waitBudget = Number(process.env.OLCLI_LOCK_WAIT_MS) >= 0
    ? Number(process.env.OLCLI_LOCK_WAIT_MS)
    : DEFAULT_LOCK_WAIT_MS;
  const started = Date.now();
  for (;;) {
    try {
      const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const descriptor = openSync(lockPath, 'wx');
      writeSync(descriptor, JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString(), token }));
      closeSync(descriptor);
      return () => {
        try {
          // Only remove the lock if it is still ours: a run that outlived the
          // stale-lock timeout could otherwise delete its successor's lock.
          const holder = readJson(lockPath);
          if (!holder || holder.token === token) unlinkSync(lockPath);
        } catch {
          // Already gone - nothing to release.
        }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const holder = readJson(lockPath);
      const stale = !holder
        || !Number.isFinite(Date.parse(holder.at))
        || Date.now() - Date.parse(holder.at) > STALE_LOCK_MS
        || (holder.host === hostname() && !pidAlive(holder.pid));
      if (stale) {
        try {
          unlinkSync(lockPath);
        } catch {
          // Another run removed it first; retry.
        }
        continue;
      }
      if (Date.now() - started >= waitBudget) return null;
      await sleep(100);
    }
  }
}

// ─── Baseline persistence ────────────────────────────────────────────────────

function loadState(directory, projectId) {
  const stored = readJson(path.join(directory, STATE_FILE));
  if (!stored || typeof stored.files !== 'object' || stored.files === null) return undefined;
  // A copied or swapped project directory must not reuse another project's
  // baseline: that would classify files against the wrong history.
  if (stored.projectId && projectId && stored.projectId !== projectId) return undefined;
  const hashes = new Map();
  const contents = new Map();
  const baseDirectory = path.join(directory, BASE_DIR);
  for (const [relative, hash] of Object.entries(stored.files)) {
    if (typeof hash !== 'string') continue;
    hashes.set(relative, hash);
    const absolute = resolveWithin(baseDirectory, relative);
    if (!absolute) continue;
    try {
      contents.set(relative, readFileSync(absolute));
    } catch {
      // Shadow copy missing: the baseline hash still works for classification,
      // only automatic merging is disabled for this path.
    }
  }
  return { hashes, contents };
}

function pruneShadow(directory, keep, prefix = '') {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      pruneShadow(absolute, keep, relative);
    } else if (!keep.has(relative)) {
      try {
        unlinkSync(absolute);
      } catch {
        // Best effort: a stale shadow copy only wastes space.
      }
    }
  }
}

function saveState({ directory, projectId, previous, hashes, contents }) {
  const baseDirectory = path.join(directory, BASE_DIR);
  mkdirSync(baseDirectory, { recursive: true });
  for (const [relative, content] of contents) {
    if (content === undefined) continue;
    const hash = hashBuffer(content);
    if (previous && previous.hashes.get(relative) === hash && previous.contents.has(relative)) continue;
    const absolute = resolveWithin(baseDirectory, relative);
    if (!absolute) continue;
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  pruneShadow(baseDirectory, new Set(hashes.keys()));
  const files = {};
  for (const relative of [...hashes.keys()].sort()) files[relative] = hashes.get(relative);
  writeJson(path.join(directory, STATE_FILE), {
    version: STATE_VERSION,
    projectId,
    updatedAt: new Date().toISOString(),
    files,
  });
}

function updateOlcliMetadata({ directory, projectId, remote, pushed, merged, deletedRemote }) {
  const metaPath = path.join(directory, '.olcli.json');
  if (!existsSync(metaPath)) return;
  const meta = readJson(metaPath) ?? {};
  const remotePaths = new Set(remote.keys());
  for (const relative of pushed) remotePaths.add(relative);
  for (const relative of merged) remotePaths.add(relative);
  for (const relative of deletedRemote) remotePaths.delete(relative);
  const now = new Date().toISOString();
  meta.projectId = meta.projectId ?? projectId;
  meta.lastPull = now;
  meta.lastSync = now;
  meta.remoteManifest = [...remotePaths].sort();
  writeJson(metaPath, meta);
}

// ─── Execution ───────────────────────────────────────────────────────────────

async function execute({ directory, client, projectId, plan, local, remote, base, baseContent, previous }) {
  const pulled = [];
  const pushed = [];
  const deletedRemote = [];
  const deletedLocal = [];
  const merged = [];
  const conflicts = [];
  const errors = [];
  const hashes = new Map(base);
  const contents = new Map();

  const absolute = relative => resolveWithin(directory, relative);

  // A file may have been saved, deleted or created by the editor after the scan
  // that produced the plan. Re-check content before writing anything, so a save
  // that lands mid-sync is never overwritten (the old CLI had exactly this
  // race and could lose a save made in the first seconds of a sync).
  const unchangedSinceScan = relative => {
    const snapshot = local.get(relative);
    const target = absolute(relative);
    try {
      if (snapshot === undefined) {
        if (!target) return false;
        readFileSync(target);
        return false; // Was absent at scan time, exists now.
      }
      if (!target) return false;
      return hashBuffer(readFileSync(target)) === hashBuffer(snapshot);
    } catch (error) {
      return error.code === 'ENOENT' && snapshot === undefined;
    }
  };

  const writeLocal = (relative, content) => {
    const target = absolute(relative);
    if (!target) throw new Error(`path escapes the project directory: ${relative}`);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  };

  const upload = async relative => {
    const target = absolute(relative);
    if (!target) throw new Error(`path escapes the project directory: ${relative}`);
    let content;
    try {
      content = readFileSync(target);
    } catch (error) {
      throw new Error(`file disappeared during sync: ${error.message}`);
    }
    await client.uploadFile(projectId, null, relative, content);
    pushed.push(relative);
    hashes.set(relative, hashBuffer(content));
    contents.set(relative, content);
  };

  for (const relative of plan.pull) {
    const content = remote.get(relative);
    if (content === undefined) continue;
    if (!unchangedSinceScan(relative)) {
      conflicts.push({ path: relative, kind: 'changed-during-sync' });
      continue;
    }
    try {
      writeLocal(relative, content);
      pulled.push(relative);
      hashes.set(relative, hashBuffer(content));
      contents.set(relative, content);
    } catch (error) {
      errors.push({ path: relative, message: error.message });
    }
  }

  for (const relative of plan.deleteLocal) {
    if (!unchangedSinceScan(relative)) {
      conflicts.push({ path: relative, kind: 'changed-during-sync' });
      continue;
    }
    try {
      const target = absolute(relative);
      if (target) unlinkSync(target);
      deletedLocal.push(relative);
      hashes.delete(relative);
    } catch (error) {
      if (error.code === 'ENOENT') {
        deletedLocal.push(relative);
        hashes.delete(relative);
      } else {
        errors.push({ path: relative, message: error.message });
      }
    }
  }

  for (const relative of plan.deleteRemote) {
    try {
      await client.deleteByPath(projectId, relative);
      deletedRemote.push(relative);
      hashes.delete(relative);
    } catch (error) {
      errors.push({ path: relative, message: error.message });
    }
  }

  for (const relative of plan.push) {
    try {
      await upload(relative);
    } catch (error) {
      errors.push({ path: relative, message: error.message });
    }
  }

  // Keep the local copies of files that are already in agreement (and the
  // previous baseline of unresolved conflicts) in the shadow directory, so an
  // upgrade from the old CLI-only sync has a merge base from the first run on.
  for (const relative of plan.unchanged) {
    const content = local.get(relative);
    if (content !== undefined) contents.set(relative, content);
  }
  for (const [relative, content] of baseContent) {
    if (hashes.has(relative) && !contents.has(relative)) contents.set(relative, content);
  }

  let conflictStamp;
  const conflictsDirectory = () => {
    if (!conflictStamp) conflictStamp = new Date().toISOString().replace(/[:.]/g, '-');
    const root = resolveWithin(directory, CONFLICT_DIR) ?? path.join(directory, CONFLICT_DIR);
    const target = path.join(root, conflictStamp);
    mkdirSync(target, { recursive: true });
    return target;
  };
  const writeRemoteCopy = relative => {
    const content = remote.get(relative);
    if (content === undefined) return undefined;
    // Flattening the path avoids nested directories inside the conflict folder;
    // the hash suffix keeps 'a/b.tex' and 'a__b.tex' from sharing a copy.
    const flattened = relative.replace(/[\\/]/g, '__');
    const suffix = hashBuffer(Buffer.from(relative)).slice(0, 8);
    const name = `${flattened}.${suffix}.remote`;
    writeFileSync(path.join(conflictsDirectory(), name), content);
    return name;
  };

  for (const conflict of plan.conflicts) {
    const relative = conflict.path;
    if (prefer === 'local') {
      try {
        if (local.get(relative) !== undefined) {
          await upload(relative);
        } else {
          await client.deleteByPath(projectId, relative);
          deletedRemote.push(relative);
          hashes.delete(relative);
        }
      } catch (error) {
        errors.push({ path: relative, message: error.message });
      }
      continue;
    }
    if (prefer === 'remote') {
      try {
        if (remote.get(relative) !== undefined) {
          if (!unchangedSinceScan(relative)) {
            conflicts.push({ path: relative, kind: 'changed-during-sync' });
            continue;
          }
          const content = remote.get(relative);
          writeLocal(relative, content);
          pulled.push(relative);
          hashes.set(relative, hashBuffer(content));
          contents.set(relative, content);
        } else {
          if (!unchangedSinceScan(relative)) {
            conflicts.push({ path: relative, kind: 'changed-during-sync' });
            continue;
          }
          const target = absolute(relative);
          if (target) {
            try {
              unlinkSync(target);
            } catch (error) {
              if (error.code !== 'ENOENT') throw error;
            }
          }
          deletedLocal.push(relative);
          hashes.delete(relative);
        }
      } catch (error) {
        errors.push({ path: relative, message: error.message });
      }
      continue;
    }

    // Default policy: try a clean three-way merge; otherwise keep both sides.
    let reason;
    if (conflict.kind === 'both-modified' && !conflict.protected) {
      const merge = mergeThreeWay({
        base: baseContent.get(relative),
        local: local.get(relative),
        remote: remote.get(relative),
      });
      if (!merge.conflict && merge.merged) {
        if (!unchangedSinceScan(relative)) {
          conflicts.push({ path: relative, kind: 'changed-during-sync' });
          continue;
        }
        try {
          writeLocal(relative, merge.merged);
          await client.uploadFile(projectId, null, relative, merge.merged);
          merged.push(relative);
          hashes.set(relative, hashBuffer(merge.merged));
          contents.set(relative, merge.merged);
        } catch (error) {
          errors.push({ path: relative, message: error.message });
        }
        continue;
      }
      reason = merge.reason;
    }
    const remoteCopy = writeRemoteCopy(relative);
    conflicts.push({
      path: relative,
      kind: conflict.kind,
      ...(reason ? { reason } : {}),
      ...(remoteCopy ? { remoteCopy } : {}),
      ...(conflict.protected ? { protected: true } : {}),
    });
  }

  let conflictsDirRelative;
  if (conflicts.length > 0) {
    const directory = conflictsDirectory();
    writeFileSync(path.join(directory, 'conflicts.json'), JSON.stringify({
      projectId,
      createdAt: new Date().toISOString(),
      conflicts,
    }, null, 2));
    conflictsDirRelative = path.relative(process.cwd(), directory).split(path.sep).join('/');
  }

  saveState({ directory, projectId, previous, hashes, contents });

  // Keep plain `olcli` commands usable, but only when the directory really is
  // in agreement: with an unresolved conflict, updating lastPull would let a
  // later `olcli sync` believe the local copy is unchanged and overwrite it.
  if (conflicts.length === 0 && errors.length === 0) {
    updateOlcliMetadata({ directory, projectId, remote, pushed, merged, deletedRemote });
  }

  return {
    pulled: pulled.length,
    pushed: pushed.length,
    deletedRemote: deletedRemote.length,
    deletedLocal: deletedLocal.length,
    merged: merged.length,
    unchanged: plan.unchanged.length,
    conflicts,
    errors,
    conflictsDir: conflictsDirRelative ?? null,
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const directory = process.cwd();
  const projectId = projectIdIn(directory);
  if (!projectId) fail('No .olcli.json or .olcli-project.json found in the project directory');
  const session = process.env.OVERLEAF_SESSION;
  if (!session) fail('sync-guard.mjs requires OVERLEAF_SESSION');

  const release = dryRun ? undefined : await acquireLock(directory);
  if (!dryRun && !release) {
    process.stdout.write(JSON.stringify({ projectId, skipped: true, reason: 'locked' }));
    return;
  }
  try {
    const client = await OverleafClient.fromSessionCookie(session, baseUrl, cookieName || 'overleaf_session2');
    client.setGlobalTimeout(timeoutMs);
    const endpoint = baseUrl;

    const ignoreContext = loadIgnore(directory, {});
    const scan = scanLocalFiles(directory, ignoreContext);
    const local = new Map();
    const localMtimes = new Map();
    for (const file of scan.files) {
      const content = readFileSync(file.path);
      local.set(file.relativePath, content);
      localMtimes.set(file.relativePath, file.mtime.getTime());
    }

    const zipBuffer = await client.downloadProject(projectId, timeoutMs);
    const zip = new AdmZip(zipBuffer);
    const remote = filterRemoteTree(
      zip.getEntries()
        .filter(entry => !entry.isDirectory)
        .map(entry => ({ path: entry.entryName, data: entry.getData() })),
      ignoreContext,
      candidate => resolveWithin(directory, candidate) !== null,
    );

    const previous = loadState(directory, projectId);
    let base;
    let baseContent;
    if (previous) {
      base = previous.hashes;
      baseContent = previous.contents;
    } else {
      const meta = localMeta(directory);
      const bootstrapped = bootstrapBase({
        local,
        remote,
        localMtimes,
        manifest: Array.isArray(meta.remoteManifest) ? meta.remoteManifest : [],
        lastPull: typeof meta.lastPull === 'string' ? meta.lastPull : undefined,
      });
      base = bootstrapped.base;
      baseContent = bootstrapped.baseContent;
    }

    const protectedPaths = protectedPathsFromEnvironment();
    const plan = planSync({ local, remote, base, protectedPaths });

    if (dryRun) {
      process.stdout.write(JSON.stringify({
        projectId,
        endpoint,
        dryRun: true,
        pulled: plan.pull.length,
        pushed: plan.push.length,
        deletedRemote: plan.deleteRemote.length,
        deletedLocal: plan.deleteLocal.length,
        unchanged: plan.unchanged.length,
        conflicts: plan.conflicts,
        errors: [],
        conflictsDir: null,
        paths: plan,
      }));
      return;
    }

    const result = await execute({ directory, client, projectId, plan, local, remote, base, baseContent, previous });
    process.stdout.write(JSON.stringify({ projectId, endpoint, dryRun: false, skipped: false, ...result }));
  } finally {
    if (release) release();
  }
}

main().catch(error => {
  process.stderr.write(error?.message ?? String(error));
  process.exitCode = 1;
});
