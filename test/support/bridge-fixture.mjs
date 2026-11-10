import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const defaultBridge = fileURLToPath(new URL('../../bridge.mjs', import.meta.url));
const bridge = process.env.HERDR_CRIT_BRIDGE || defaultBridge;
if (!path.isAbsolute(bridge)) throw new Error('HERDR_CRIT_BRIDGE must be an absolute path');

const double = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const tool = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const root = process.env.FIXTURE_ROOT;
function event(kind, extra = {}) {
  fs.appendFileSync(path.join(root, 'events.jsonl'), JSON.stringify({ tool, kind, args, pid: process.pid, ppid: process.ppid, ...extra }) + '\\n');
}
function state() { return JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8')); }
function waitForStop(file) {
  const interval = setInterval(() => {
    if (fs.existsSync(path.join(root, file))) { clearInterval(interval); process.exit(1); }
  }, 25);
  setTimeout(() => process.exit(1), 20000);
}
if (tool === 'foreground') {
  setTimeout(() => process.exit(0), 20000);
} else if (tool === 'git') {
  event('call');
  if (args.join(' ') === 'rev-parse --is-inside-work-tree') {
    if (state().git === 'ready') process.stdout.write('true\\n');
    else if (state().git === 'not_repository') {
      process.stderr.write('fatal: not a git repository (or any of the parent directories): .git\\n');
      process.exitCode = 128;
    } else { process.stderr.write('git unavailable\\n'); process.exitCode = 2; }
  } else if (args.join(' ') === 'status --porcelain=v1 -z --untracked-files=all') {
    process.stdout.write(state().untracked ? '?? new-file.js\\0' : '');
  } else { process.stderr.write('unexpected fixture git call\\n'); process.exitCode = 97; }
} else if (tool === 'hc') {
  if (args[0] === 'get' && args[1] === '--json' && args.length === 3) {
    event('get');
    const s = state();
    if (s.lookupFailure) { process.stderr.write('fixture terminal unavailable\\n'); process.exitCode = 1; }
    else process.stdout.write(JSON.stringify({ address: s.address || args[2], state: s.terminalState || 'live', foreground: { pid: s.foregroundPid }, status: { state: s.status } }));
  } else if (args[0] === 'send' && args.length === 3) {
    const s = state();
    const mode = s.send;
    event('send-start', { mode });
    // Default hc send refuses blocked input, including a lookup-to-send race.
    if ((s.statusAtSend ?? s.status) === 'blocked') {
      event('send-rejected', { mode });
      process.stderr.write('fixture terminal is blocked\\n');
      process.exitCode = 10;
    } else if (mode === 'hold') waitForStop('stop-hold');
    else {
      event('send-finish', { mode });
      if (mode !== 'success') { process.stderr.write('fixture transport failed\\n'); process.exitCode = 1; }
    }
  } else { event('unexpected'); process.stderr.write('unexpected fixture hc call\\n'); process.exitCode = 97; }
} else if (tool === 'crit') {
  event('start');
  if (state().critStartupFailure) {
    process.stderr.write('GitHub authentication required: run gh auth login\\n');
    process.exitCode = 1;
  } else waitForStop('stop');
} else { process.stderr.write('unexpected fixture executable\\n'); process.exitCode = 97; }
`;

// Only the forms the bridge uses are implemented; every other command fails closed.
const psDouble = `#!/bin/sh
case "$1" in
  -p)
    printf '%s\\n' "$2" >> "$FIXTURE_ROOT/ps-targets"
    if [ "$4" = 'ppid=' ]; then printf '0\\n'; else printf 'Tue Jan  2 12:00:00 2024\\n'; fi
    ;;
  -ww)
    printf '%s\\n' "$3" >> "$FIXTURE_ROOT/ps-targets"
    daemon=''
    if [ -f "$FIXTURE_ROOT/crit-daemon-pid" ]; then read -r daemon < "$FIXTURE_ROOT/crit-daemon-pid"; fi
    command=$(/bin/ps -ww -p "$3" -o command=)
    case "$command" in
      *"$FIXTURE_ROOT"/app/data/crit/work/*/waiter-*.request.json*)
        printf 'Tue Jan  2 12:00:00 2024 %s\\n' "$command" ;;
      *"$FIXTURE_ROOT"/bin/foreground*)
        if [ "$daemon" = "$3" ]; then
          printf 'Tue Jan  2 12:00:00 2024 /fixture/bin/crit _serve --port 4321\\n'
        else
          printf 'Tue Jan  2 12:00:00 2024 fixture-unrelated-process\\n'
        fi ;;
      *) printf 'Tue Jan  2 12:00:00 2024 fixture-unrelated-process\\n' ;;
    esac
    ;;
  *) exit 97 ;;
esac
`;

export async function eventually(label, callback, timeout = 10000) {
  const deadline = Date.now() + timeout;
  do {
    const result = await callback();
    if (result) return result;
    await delay(40);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}`);
}

export async function withBridgeFixture(callback) {
  const temp = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temp, 'herdr-crit-bridge-'));
  const home = path.join(root, 'home');
  const appHome = path.join(root, 'app');
  const bin = path.join(root, 'bin');
  const workspace = path.join(root, 'workspace');
  const tmp = path.join(root, 'tmp');
  const data = path.join(appHome, 'data', 'crit');
  const records = path.join(data, 'records');
  const pending = path.join(data, 'pending');
  const work = path.join(data, 'work');
  const active = new Set();
  const ids = new Set();
  const env = {
    HOME: home, HERDR_APP_HOME: appHome, PATH: bin, TMPDIR: tmp,
    FIXTURE_ROOT: root, LANG: 'C', LC_ALL: 'C', TZ: 'UTC',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
  };
  const stateFile = path.join(root, 'state.json');
  let state = { git: 'ready', status: 'idle', send: 'success' };

  async function writeJSON(file, value) {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await fs.rename(temporary, file);
  }
  function track(child) {
    active.add(child);
    child.once('close', () => active.delete(child));
    return child;
  }
  function commandFor(pid) {
    const result = spawnSync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8', env });
    return result.status === 0 ? result.stdout.trim() : '';
  }
  function owned(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 1) return false;
    const command = commandFor(pid);
    return command.includes(`${bin}/`) ||
      (command.includes(path.join(path.dirname(bridge), 'waiter.mjs')) && command.includes(root)) ||
      (command.includes(bridge) && command.includes('__worker') && [...ids].some(id => command.includes(id)));
  }
  async function observedPids() {
    const result = new Set();
    try {
      for (const value of (await fs.readFile(path.join(root, 'ps-targets'), 'utf8')).trim().split(/\s+/)) {
        if (/^\d+$/.test(value)) result.add(Number(value));
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const event of await fixture.events()) result.add(event.pid);
    let names;
    try { names = await fs.readdir(records); }
    catch (error) { if (error.code !== 'ENOENT') throw error; names = []; }
    for (const name of names) {
      if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
      ids.add(name.slice(0, -5));
      try {
        const record = JSON.parse(await fs.readFile(path.join(records, name), 'utf8'));
        for (const pid of [record._workerPid, record._delivery?.pid, record._waiter?.pid, record._waiter?.childPid]) {
          if (Number.isSafeInteger(pid)) result.add(pid);
        }
      } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    }
    return [...result].filter(owned);
  }
  async function cleanup() {
    // Unblock only our own doubles, then allow the detached waiter and worker to exit.
    await Promise.all(['stop', 'stop-hold'].map(file => fs.writeFile(path.join(root, file), 'stop')));
    for (const child of active) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await Promise.allSettled([...active].map(child => new Promise(resolve => child.once('close', resolve))));
    let remaining = [];
    for (let i = 0; i < 40; i++) {
      remaining = await observedPids();
      if (remaining.length === 0) {
        await delay(50);
        remaining = await observedPids();
        if (remaining.length === 0) break;
      }
      await delay(50);
    }
    // The process command must still name this fixture before any signal is sent.
    for (const pid of remaining) if (owned(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    if (remaining.length) await eventually('fixture processes to exit', async () => (await observedPids()).length === 0, 3000);
    await fs.rm(root, { recursive: true, force: true });
  }

  const fixture = {
    root, home, appHome, bin, workspace, data, records, pending, work,
    async configure(changes) {
      state = { ...state, ...changes };
      await writeJSON(stateFile, state);
    },
    async startForeground() {
      const child = track(spawn(process.execPath, [path.join(bin, 'foreground')], { cwd: workspace, env, stdio: 'ignore' }));
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      await fixture.configure({ foregroundPid: child.pid });
      return child;
    },
    async seedRecord(overrides = {}) {
      const id = overrides.id || randomUUID();
      ids.add(id);
      const record = {
        id, mode: 'files', story: false, target: 'file.js', agentAddress: 'terminal-1',
        cwd: workspace, phase: 'reviewing', round: 1,
        createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z',
        ...overrides,
      };
      await writeJSON(path.join(records, `${id}.json`), record);
      return id;
    },
    async seedPending(id, value) { await writeJSON(path.join(pending, `${id}.json`), value); },
    async seedWaiter(id, result, overrides = {}) {
      const directory = path.join(work, id);
      const token = randomUUID();
      const requestFile = path.join(directory, `waiter-${token}.request.json`);
      const resultFile = path.join(directory, `waiter-${token}.result.json`);
      await writeJSON(requestFile, { cwd: workspace, args: ['review', 'file.js'], resultFile });
      if (result) await writeJSON(resultFile, result);
      return { requestFile, resultFile, round: 1, kind: 'review', ...overrides };
    },
    async events() {
      try {
        return (await fs.readFile(path.join(root, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
      } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    },
    async waitEvent(predicate) {
      return eventually('fixture command', async () => (await fixture.events()).find(predicate));
    },
    isOwnedProcess: owned,
    interruptWorker(pid) {
      assert.ok(owned(pid), 'only an identified fixture worker may be interrupted');
      assert.match(commandFor(pid), /__worker\s/);
      process.kill(pid, 'SIGKILL');
    },
    async run(...args) {
      const child = track(spawn(process.execPath, [bridge, ...args], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] }));
      let stdout = '', stderr = '', failure = '';
      const timer = setTimeout(() => { failure = 'timed out'; child.kill('SIGKILL'); }, 10000);
      for (const [stream, append] of [[child.stdout, text => { stdout += text; }], [child.stderr, text => { stderr += text; }]]) {
        stream.setEncoding('utf8');
        stream.on('data', text => {
          append(text);
          if (stdout.length + stderr.length > 1024 * 1024 && !failure) { failure = 'exceeded output limit'; child.kill('SIGKILL'); }
        });
      }
      const { code, signal } = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
      }).finally(() => clearTimeout(timer));
      if (failure) throw new Error(`bridge ${args[0]} ${failure}`);
      let value;
      try { value = JSON.parse(stdout); } catch { throw new Error(`bridge ${args[0]} returned non-JSON output: ${stdout}\n${stderr}`); }
      if (value.id) ids.add(value.id);
      if (value.review?.id) ids.add(value.review.id);
      return { code, signal, value, stderr };
    },
    async review(id, predicate) {
      return eventually(`review ${id}`, async () => {
        const result = await fixture.run('list');
        assert.equal(result.code, 0, result.stderr);
        const review = result.value.reviews.find(item => item.id === id);
        return review && predicate(review) ? review : null;
      });
    },
  };

  try {
    await Promise.all([home, appHome, bin, workspace, tmp, records, pending, work, path.join(home, '.crit', 'sessions')].map(dir => fs.mkdir(dir, { recursive: true, mode: 0o700 })));
    await Promise.all(['hc', 'git', 'crit', 'foreground'].map(name => fs.writeFile(path.join(bin, name), double, { mode: 0o700 })));
    await fs.writeFile(path.join(bin, 'ps'), psDouble, { mode: 0o700 });
    await writeJSON(stateFile, state);
    return await callback(fixture);
  } finally {
    await cleanup();
  }
}
