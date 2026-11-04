import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUTPUT_LIMIT = 1024 * 1024;

// Every scenario gets its own process so HOME-dependent module state is fresh.
export async function withHelperFixture(callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'herdr-crit-test-'));
  const home = path.join(root, 'home');
  const appHome = path.join(root, 'app');
  const bin = path.join(root, 'bin');
  const workspace = path.join(root, 'workspace');
  const tmp = path.join(root, 'tmp');
  const active = new Set();
  const env = {
    HOME: home,
    HERDR_APP_HOME: appHome,
    PATH: bin,
    TMPDIR: tmp,
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    FIXTURE_ROOT: root,
    FIXTURE_HOME: home,
    FIXTURE_APP_HOME: appHome,
    FIXTURE_BIN: bin,
    FIXTURE_WORKSPACE: workspace,
  };

  function stop(child) {
    if (!child.pid) return;
    try {
      // A separate process group lets a timeout stop only this fixture's children.
      if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }

  function commandPath(name) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error(`invalid fixture command: ${name}`);
    return path.join(bin, name);
  }

  const fixture = {
    root, home, appHome, bin, workspace, env,
    async addCommand(name, source) {
      await fs.writeFile(commandPath(name), source, { mode: 0o755 });
    },
    async linkCommand(name, target) {
      if (!path.isAbsolute(target)) throw new Error('fixture command target must be absolute');
      await fs.symlink(target, commandPath(name));
    },
    async run(moduleURL, scenario, options = {}) {
      const { args = [], env: extraEnv = {}, timeout = 10000 } = options;
      for (const key of ['HOME', 'HERDR_APP_HOME', 'PATH', 'TMPDIR', 'FIXTURE_ROOT', 'FIXTURE_HOME', 'FIXTURE_APP_HOME', 'FIXTURE_BIN', 'FIXTURE_WORKSPACE']) {
        if (Object.hasOwn(extraEnv, key)) throw new Error(`cannot override fixture ${key}`);
      }
      const file = moduleURL instanceof URL || String(moduleURL).startsWith('file:')
        ? fileURLToPath(moduleURL)
        : moduleURL;
      const child = spawn(process.execPath, [file, '--fixture', scenario, ...args], {
        cwd: workspace,
        env: { ...env, ...extraEnv },
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const record = { child, done: null };
      active.add(record);
      record.done = new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        let size = 0;
        let failure = null;
        const timer = setTimeout(() => {
          failure = `timed out after ${timeout}ms`;
          stop(child);
        }, timeout);
        const capture = (stream, append) => {
          stream.setEncoding('utf8');
          stream.on('data', text => {
            size += Buffer.byteLength(text);
            if (size > OUTPUT_LIMIT) {
              if (!failure) failure = 'exceeded fixture output limit';
              stop(child);
            } else append(text);
          });
        };
        capture(child.stdout, text => { stdout += text; });
        capture(child.stderr, text => { stderr += text; });
        child.on('error', error => { failure = error.message; });
        child.on('close', (code, signal) => {
          clearTimeout(timer);
          active.delete(record);
          if (failure || code !== 0) {
            reject(new Error(`fixture ${scenario} ${failure || `exited ${code === null ? `with ${signal}` : code}`}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
          } else resolve({ stdout, stderr });
        });
      });
      return record.done;
    },
  };

  try {
    await Promise.all([home, appHome, bin, workspace, tmp].map(dir => fs.mkdir(dir, { recursive: true })));
    return await callback(fixture);
  } finally {
    for (const record of active) stop(record.child);
    await Promise.allSettled([...active].map(record => record.done));
    await fs.rm(root, { recursive: true, force: true });
  }
}
