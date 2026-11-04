import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sessionFile = /^([0-9a-f]{12})\.json$/;
const sessionIdPattern = /^[0-9a-f]{12}$/;
const home = os.homedir();
const sessionsDir = path.join(home, '.crit', 'sessions');
const plansDir = path.join(home, '.crit', 'plans');

// These keys and the plan slug algorithm are from Crit v0.23.2.
function digest(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}
function sessionKey(cwd, branch, args) {
  const sorted = [...args].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return digest(`${cwd}\0${sorted.length ? sorted.map(arg => `\0${arg}`).join('') : branch}`);
}
function planKey(slug) { return digest(`__plan:${slug}`); }
function liveKey(cwd, origin) { return digest(`${cwd}\0live\0${origin}`); }
function previewKey(cwd, file) { return digest(`${cwd}\0preview\0${file}`); }

function prKey(cwd, spec) {
  const number = value => {
    if (!/^\+?\d+$/.test(value)) return null;
    const parsed = BigInt(value);
    return parsed > 0n && parsed <= 9223372036854775807n ? parsed.toString() : null;
  };
  const bare = number(spec);
  if (bare) return sessionKey(cwd, '', [`pr:${bare}`]);
  let url, parts;
  try {
    url = new URL(spec);
    parts = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, '').split('/');
  } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || parts.length < 4 || parts[2] !== 'pull' || !/^\d+$/.test(parts[3])) return null;
  const n = number(parts[3]);
  if (!n) return null;
  const host = url.hostname.toLowerCase();
  const prefix = host === 'github.com' || host === 'www.github.com' ? '' : `${host}/`;
  return sessionKey(cwd, '', [`pr:${prefix}${parts[0]}/${parts[1]}#${n}`]);
}

function slugify(value) {
  // Go's strings.ToLower uses simple, per-rune mappings rather than JS's
  // context-sensitive string mappings.
  return [...value.trim()].map(char => [...char.toLowerCase()][0])
    .join('').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function two(value) { return String(value).padStart(2, '0'); }
function derivedPlanSlug(file) {
  let content;
  try { content = fs.readFileSync(file, 'utf8'); }
  catch { throw new Error('Could not read the plan input to determine its Crit slug'); }
  const now = new Date();
  const date = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
  for (const line of content.split('\n', 30)) {
    const text = line.trim();
    if (text.startsWith('# ')) {
      const heading = slugify(text.slice(2));
      if (heading) return `${heading}-${date}`;
    }
  }
  return `plan-${date}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
}

function parseArgs(args, cwd, resumeSessionId) {
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new Error('Invalid Crit launch arguments');
  }
  const command = ['review', 'plan', 'live', 'preview'].includes(args[0]) ? args[0] : 'review';
  const start = args[0] === command ? 1 : 0;
  const booleans = new Set(['--no-open', '--quiet', '-q']);
  const values = new Set(['--base-branch', '--pr', '--mr', '--range', '--name', '--session']);
  const flags = new Map();
  const positional = [];
  let afterDash = false;
  for (let i = start; i < args.length; i++) {
    const arg = args[i];
    if (!afterDash && arg === '--') { afterDash = true; continue; }
    if (!afterDash && arg.startsWith('-')) {
      const equals = arg.indexOf('=');
      const flag = equals < 0 ? arg : arg.slice(0, equals);
      if (booleans.has(flag)) continue;
      if (!values.has(flag) || flags.has(flag)) throw new Error('Unsupported Crit launch arguments');
      const value = equals < 0 ? args[++i] : arg.slice(equals + 1);
      if (typeof value !== 'string' || !value) throw new Error('Invalid Crit launch arguments');
      flags.set(flag, value);
    } else positional.push(arg);
  }

  if (flags.has('--session')) {
    const id = flags.get('--session');
    if (command !== 'review' || positional.length || flags.size !== 1 ||
        !resumeSessionId || id !== resumeSessionId) {
      throw new Error('A Crit session selector may only resume this review');
    }
    return { args: [...args], mode: 'resume', expectedId: id, planSlug: null };
  }

  const focusFlags = ['--pr', '--mr', '--range'].filter(flag => flags.has(flag));
  if (command === 'plan') {
    if (positional.length !== 1 || focusFlags.length || flags.has('--base-branch')) {
      throw new Error('Invalid Crit plan launch arguments');
    }
    const explicit = flags.get('--name');
    const planSlug = explicit ? slugify(explicit) : derivedPlanSlug(path.resolve(cwd, positional[0]));
    if (!planSlug) throw new Error('Could not determine a Crit plan slug');
    const normalized = ['plan', '--name', planSlug];
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--name') { i++; continue; }
      if (args[i].startsWith('--name=')) continue;
      normalized.push(args[i]);
    }
    const expectedId = planKey(planSlug);
    if (resumeSessionId && resumeSessionId !== expectedId) throw new Error('The plan does not match this review session');
    return { args: normalized, mode: 'plan', expectedId, planSlug };
  }
  if (flags.has('--name')) throw new Error('Unsupported Crit launch arguments');
  if (resumeSessionId) throw new Error('A resumed review requires its exact Crit session selector');

  if (command === 'live' || command === 'preview') {
    if (positional.length !== 1 || focusFlags.length || flags.has('--base-branch')) {
      throw new Error('Invalid Crit launch arguments');
    }
    if (command === 'preview') {
      const target = path.resolve(cwd, positional[0]);
      return { args: [...args], mode: command, target, expectedId: previewKey(cwd, target), planSlug: null };
    }
    let url;
    try { url = new URL(positional[0]); } catch { throw new Error('Invalid Crit live origin'); }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
      throw new Error('Invalid Crit live origin');
    }
    url.search = ''; url.hash = '';
    const target = url.toString().replace(/\/$/, '');
    return { args: [...args], mode: command, target, expectedId: liveKey(cwd, target), planSlug: null };
  }
  if (focusFlags.length > 1 || (focusFlags.length && positional.length)) {
    throw new Error('Invalid Crit review scope');
  }
  if (focusFlags.length) {
    const mode = focusFlags[0].slice(2);
    const target = flags.get(focusFlags[0]);
    // Crit resolves GitHub PR numbers directly; MR project metadata and
    // symbolic ranges require the forge or VCS and cannot be inferred here.
    const range = mode === 'range' && target.match(/^([0-9a-f]{40}|[0-9a-f]{64})\.\.([0-9a-f]{40}|[0-9a-f]{64})$/);
    const expectedId = mode === 'pr' ? prKey(cwd, target)
      : range ? sessionKey(cwd, '', [`range:${range[1]}..${range[2]}`]) : null;
    return { args: [...args], mode, target, expectedId, planSlug: null };
  }
  if (positional.length) {
    return {
      args: [...args], mode: 'files', files: positional,
      expectedId: sessionKey(cwd, '', positional), planSlug: null,
    };
  }
  // Crit chooses the branch through its configured VCS, which is deliberately
  // not read here. Its registry entry supplies the branch after launch.
  return { args: [...args], mode: 'git', expectedId: null, planSlug: null };
}

function readEntry(id) {
  let entry;
  try { entry = JSON.parse(fs.readFileSync(path.join(sessionsDir, `${id}.json`), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('A Crit session registry entry could not be read safely');
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
      !Number.isSafeInteger(entry.pid) || entry.pid <= 1 ||
      !Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535 ||
      typeof entry.cwd !== 'string' || !path.isAbsolute(entry.cwd) || entry.cwd.includes('\0') ||
      typeof entry.branch !== 'string' ||
      typeof entry.review_path !== 'string' || !path.isAbsolute(entry.review_path) || entry.review_path.includes('\0') ||
      typeof entry.started_at !== 'string' || !Number.isFinite(Date.parse(entry.started_at)) ||
      (entry.args != null && (!Array.isArray(entry.args) || entry.args.some(arg => typeof arg !== 'string' || arg.includes('\0')))) ||
      (entry.host != null && typeof entry.host !== 'string') ||
      (entry.public_url != null && typeof entry.public_url !== 'string')) {
    throw new Error('A Crit session registry entry has an ambiguous identity');
  }
  return entry;
}
function generation(entry) { return `${entry.pid}\0${entry.started_at}`; }

export function readCritSession(id) {
  if (!sessionIdPattern.test(id)) throw new Error('Invalid Crit session identity');
  return readEntry(id);
}

export function critProcessIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  const result = spawnSync('ps', ['-ww', '-p', String(pid), '-o', 'lstart=', '-o', 'command='], {
    encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' },
  });
  if (result.status !== 0 || !result.stdout) return null;
  const match = result.stdout.trim().match(/^(\S+\s+\S+\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+([\s\S]+)$/);
  if (!match) return null;
  return { started: match[1].replace(/\s+/g, ' '), command: match[2] };
}

export function matchesCritProcess(entry, identity, expectedStart = null) {
  if (!identity || !/^(?:\S*\/)?crit\s+_serve(?:\s|$)/.test(identity.command)) return false;
  const processTime = Date.parse(identity.started);
  const sessionTime = Date.parse(entry.started_at);
  return Number.isFinite(processTime) && Number.isFinite(sessionTime) && processTime <= sessionTime &&
    (!expectedStart || identity.started === expectedStart.replace(/\s+/g, ' '));
}

function entryScope(id, entry) {
  const args = entry.args || [];
  const cwd = path.normalize(entry.cwd);
  const review = path.normalize(entry.review_path);
  const planDir = path.dirname(review);
  const slug = path.basename(planDir);
  if (path.basename(review) === '.crit' && path.dirname(planDir) === plansDir && planKey(slug) === id) {
    return { mode: 'plan', target: slug };
  }
  if (args.length === 2 && args[0] === 'live' && liveKey(cwd, args[1]) === id) {
    return { mode: 'live', target: args[1] };
  }
  if (args.length === 2 && args[0] === 'preview' && previewKey(cwd, args[1]) === id) {
    return { mode: 'preview', target: args[1] };
  }
  if (sessionKey(cwd, entry.branch, args) === id) {
    return args.length ? { mode: 'files', files: args } : { mode: 'git' };
  }
  // Focus flags and --session overrides are not stored in registry args.
  return { mode: 'unknown' };
}
function sameFiles(cwd, left, right) {
  const normalize = files => files.map(file => path.resolve(cwd, file)).sort();
  const a = normalize(left), b = normalize(right);
  return a.length === b.length && a.every((value, i) => value === b[i]);
}
function conflicts(scope, cwd, id, entry) {
  if (scope.mode === 'resume') return id === scope.expectedId;
  if (id === scope.expectedId) return true;
  const found = entryScope(id, entry);
  if (scope.mode === 'plan') return found.mode === 'plan' && found.target === scope.planSlug;
  if (path.normalize(entry.cwd) !== cwd) return false;
  if (found.mode === 'unknown') return true;
  if (scope.mode !== found.mode) return false;
  if (scope.mode === 'files') return sameFiles(cwd, scope.files, found.files);
  if (scope.mode === 'live' || scope.mode === 'preview') return scope.target === found.target;
  // Without reading Crit's configuration or running its VCS, another Git
  // branch cannot be distinguished safely from the current one here.
  return scope.mode === 'git';
}
function matchesLaunch(scope, cwd, id, entry) {
  if (path.normalize(entry.cwd) !== cwd) return false;
  if (scope.expectedId && id !== scope.expectedId) return false;
  if (scope.mode === 'resume') return true;
  const found = entryScope(id, entry);
  if (scope.mode === 'plan') return found.mode === 'plan' && found.target === scope.planSlug;
  if (scope.mode === 'files') return found.mode === 'files' && sameFiles(cwd, scope.files, found.files);
  if (scope.mode === 'live' || scope.mode === 'preview') return found.mode === scope.mode && found.target === scope.target;
  if (scope.mode === 'git') return found.mode === 'git';
  return found.mode === 'unknown';
}
function resultFor(id, entry, planSlug) {
  if (entry.public_url) {
    let url;
    try { url = new URL(entry.public_url); } catch { throw new Error('Crit advertised an unsafe review URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
      throw new Error('Crit advertised an unsafe review URL');
    }
  }
  return {
    sessionId: id, pid: entry.pid, port: entry.port, host: entry.host || '',
    public_url: entry.public_url || '', review_path: entry.review_path, started_at: entry.started_at, planSlug,
  };
}
function processExists(pid, cache) {
  if (cache.has(pid)) return cache.get(pid);
  let alive = true;
  try { process.kill(pid, 0); } // Signal 0 checks existence without sending a signal.
  catch (error) { if (error.code === 'ESRCH') alive = false; }
  cache.set(pid, alive);
  return alive;
}

// Arm before spawning. parentPid is supplied by the caller because Node has no
// portable API for another process's parent; this helper never spawns a process.
export async function prepareCritLaunch({ args, cwd, resumeSessionId = null, resumeGeneration = null, parentPid, confirmStoryOnExit = false }) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || cwd.includes('\0') ||
      (resumeSessionId != null && !sessionIdPattern.test(resumeSessionId)) || typeof parentPid !== 'function') {
    throw new Error('Invalid Crit launch observer options');
  }
  if (resumeGeneration != null && (!resumeSessionId || typeof resumeGeneration !== 'object' ||
      !Number.isSafeInteger(resumeGeneration.pid) || resumeGeneration.pid <= 1 ||
      typeof resumeGeneration.started_at !== 'string' || !resumeGeneration.started_at)) {
    throw new Error('Invalid owned Crit session generation');
  }
  try { cwd = fs.realpathSync(cwd); }
  catch { throw new Error('Could not resolve the Crit working directory'); }
  const scope = parseArgs(args, cwd, resumeSessionId);

  // If the registry is absent, watch its nearest existing ancestor recursively.
  // Crit, not this observer, is responsible for creating its own directories.
  let root = sessionsDir;
  for (;;) {
    try {
      if (!fs.statSync(root).isDirectory()) throw new Error();
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Could not watch the Crit session registry');
      const parent = path.dirname(root);
      if (parent === root) throw new Error('Could not watch the Crit session registry');
      root = parent;
    }
  }

  let watcher, child, resolveObservation, rejectObservation, fatalError;
  let closed = false, observing = false, processing = false;
  const pending = new Set();
  const baseline = new Map();
  let resumedEntry = null, censusStartedAt;

  function finish(error, value) {
    if (closed) return;
    closed = true;
    watcher?.close();
    if (child) {
      child.removeListener('exit', onExit);
      child.removeListener('error', onChildError);
    }
    if (error) {
      fatalError = error;
      if (rejectObservation) rejectObservation(error);
    } else if (resolveObservation) resolveObservation(value);
  }
  function onExit() {
    // A Story command can exit immediately after starting its daemon. Let an
    // already-triggered registry event finish its parent lookup before closing.
    if (processing) watcher?.close();
    else finish(new Error('Crit exited before its review session could be identified'));
  }
  function onChildError() { finish(new Error('Could not start the Crit review process')); }

  async function drain() {
    if (!observing || processing || closed) return;
    processing = true;
    try {
      while (pending.size && !closed) {
        const id = pending.values().next().value;
        pending.delete(id);
        const entry = readEntry(id);
        if (!entry || baseline.get(id) === generation(entry)) continue;
        if (!matchesLaunch(scope, cwd, id, entry)) {
          if (id === scope.expectedId) throw new Error('A different Crit session appeared for this review');
          continue;
        }
        let parent;
        try { parent = await parentPid(entry.pid); }
        catch {
          if (confirmStoryOnExit) continue;
          throw new Error('Could not prove ownership of the Crit daemon');
        }
        if (closed) return;
        if (parent !== child.pid) {
          if (confirmStoryOnExit) continue;
          throw new Error('Could not establish ownership of the Crit daemon');
        }
        // The callback can yield while another process replaces the entry.
        // Re-read only this event's file, never scan or poll the registry.
        const current = readEntry(id);
        if (!current || generation(current) !== generation(entry) || !matchesLaunch(scope, cwd, id, current)) {
          throw new Error('The Crit session changed before ownership could be verified');
        }
        finish(null, resultFor(id, current, scope.planSlug));
      }
    } catch (error) { finish(error); }
    finally {
      processing = false;
      if (!closed && child && (child.exitCode != null || child.signalCode != null)) {
        finish(new Error('Crit exited before its review session could be identified'));
      }
    }
  }

  try {
    watcher = fs.watch(root, { recursive: root !== sessionsDir }, (_event, filename) => {
      if (closed) return;
      if (!filename) { finish(new Error('The Crit registry watcher did not identify a changed file')); return; }
      const changed = path.resolve(root, filename.toString());
      if (path.dirname(changed) === sessionsDir) {
        const match = path.basename(changed).match(sessionFile);
        if (match) pending.add(match[1]);
      } else if (changed === sessionsDir && scope.expectedId) {
        // A known key can be inspected directly if the directory was just made.
        pending.add(scope.expectedId);
      }
      void drain();
    });
    watcher.on('error', () => finish(new Error('The Crit session registry watcher failed')));

    // Exactly one registry census, after the watcher is armed.
    censusStartedAt = Date.now();
    let names;
    try { names = fs.readdirSync(sessionsDir); }
    catch (error) { if (error.code === 'ENOENT') names = []; else throw error; }
    const alive = new Map();
    for (const name of names) {
      const match = name.match(sessionFile);
      if (!match) continue;
      const id = match[1];
      const entry = readEntry(id);
      if (!entry) continue;
      baseline.set(id, generation(entry));
      if (!conflicts(scope, cwd, id, entry) || !processExists(entry.pid, alive)) continue;
      if (resumeSessionId === id && matchesLaunch(scope, cwd, id, entry)) {
        if (!resumeGeneration || entry.pid !== resumeGeneration.pid || entry.started_at !== resumeGeneration.started_at) {
          throw new Error('The existing Crit session is not the recorded owned daemon');
        }
        resumedEntry = entry;
      } else {
        throw new Error('An existing or ambiguous Crit session already covers this review scope');
      }
    }
  } catch (error) {
    watcher?.close();
    throw error;
  }

  return {
    args: scope.args,
    planSlug: scope.planSlug,
    observe(processChild) {
      if (observing) return Promise.reject(new Error('This Crit launch is already being observed'));
      observing = true;
      return new Promise((resolve, reject) => {
        resolveObservation = resolve; rejectObservation = reject;
        if (closed) { reject(fatalError || new Error('The Crit launch observer is closed')); return; }
        if (!processChild || !Number.isSafeInteger(processChild.pid) || processChild.pid <= 1 ||
            typeof processChild.once !== 'function' || typeof processChild.removeListener !== 'function') {
          finish(new Error('The spawned Crit process could not be identified')); return;
        }
        child = processChild;
        child.once('exit', onExit);
        child.once('error', onChildError);
        if (child.exitCode != null || child.signalCode != null) { onExit(); return; }
        if (resumedEntry) {
          try {
            const current = readEntry(resumeSessionId);
            if (!current || generation(current) !== generation(resumedEntry) ||
                !matchesLaunch(scope, cwd, resumeSessionId, current)) {
              throw new Error('The owned Crit session changed before it could be resumed');
            }
            finish(null, resultFor(resumeSessionId, current, scope.planSlug));
          } catch (error) { finish(error); }
          return;
        }
        void drain();
      });
    },
    confirmStoryExit(stderr) {
      if (!confirmStoryOnExit || !child || child.exitCode !== 0 || typeof stderr !== 'string') {
        throw new Error('Crit Story did not report a newly started daemon');
      }
      // Crit 0.23.2 prints this even in quiet mode, after StartDaemon has
      // written the registry. A short-lived Story process can exit before
      // macOS delivers the corresponding filesystem event.
      const starts = [...stderr.matchAll(/^Started crit daemon at [^\r\n]+ \(session ([0-9a-f]{12}), PID ([1-9]\d*)\)\r?$/gm)];
      if (starts.length !== 1) throw new Error('Crit Story did not report a newly started daemon');
      const [, id, rawPid] = starts[0];
      const pid = Number(rawPid);
      const entry = readEntry(id);
      if (!entry || entry.pid !== pid || baseline.get(id) === generation(entry) ||
          Date.parse(entry.started_at) < censusStartedAt || !matchesLaunch(scope, cwd, id, entry) ||
          !processExists(pid, new Map())) {
        throw new Error('The Crit Story daemon does not match the newly started review');
      }
      return resultFor(id, entry, scope.planSlug);
    },
    close() { finish(new Error('The Crit launch observer was closed')); },
  };
}
