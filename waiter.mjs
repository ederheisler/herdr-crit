import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

function notify(message) {
  if (!process.connected || typeof process.send !== 'function') return;
  try {
    process.send(message, () => {});
  } catch {
    // The parent may disconnect between the check and the send.
  }
}

function diagnostic(action, error) {
  return `${action}: ${error instanceof Error ? error.message : String(error)}`;
}

function failedResult(message) {
  return { code: 1, signal: null, stdout: '', stderr: `crit waiter: ${message}\n` };
}

function waitForGo() {
  let waiting = true;
  let settle;
  const promise = new Promise((resolve) => { settle = resolve; });
  const cleanup = () => {
    if (!waiting) return;
    waiting = false;
    process.off('message', onMessage);
    process.off('disconnect', onDisconnect);
    process.channel?.unref();
  };
  const finish = (go) => {
    if (!waiting) return;
    cleanup();
    settle(go);
  };
  const onMessage = (message) => {
    if (message?.type === 'go') finish(true);
  };
  const onDisconnect = () => finish(false);

  process.on('message', onMessage);
  process.on('disconnect', onDisconnect);
  process.channel?.ref();
  if (!process.connected) finish(false);
  return { promise, cancel: cleanup };
}

function runCrit(cwd, args) {
  return new Promise((resolve) => {
    const stdout = [];
    const stderr = [];
    const errors = [];
    let child;
    try {
      child = spawn('crit', args, {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve(failedResult(diagnostic('could not spawn Crit', error)));
      return;
    }

    let spawned = false;
    let live = false;
    const onMessage = (message) => {
      if (message?.type !== 'abort' || !live) return;
      try {
        child.kill('SIGKILL');
      } catch (error) {
        errors.push(diagnostic('could not abort Crit', error));
      }
    };
    process.on('message', onMessage);
    process.channel?.unref();

    for (const [name, stream, chunks] of [
      ['stdout', child.stdout, stdout],
      ['stderr', child.stderr, stderr],
    ]) {
      if (!stream) {
        errors.push(`Crit ${name} pipe unavailable`);
        continue;
      }
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('error', (error) => errors.push(diagnostic(`reading Crit ${name}`, error)));
    }

    child.once('spawn', () => {
      spawned = true;
      live = true;
      notify({ type: 'spawn', pid: child.pid });
    });
    child.once('error', (error) => errors.push(diagnostic('Crit process error', error)));
    child.once('exit', (code, signal) => {
      live = false;
      notify({ type: 'exit', code, signal });
    });
    child.once('close', (code, signal) => {
      live = false;
      process.off('message', onMessage);
      if (!spawned) {
        code = 1;
        signal = null;
        if (errors.length === 0) errors.push('Crit did not spawn');
      } else if (code === null && signal === null) {
        code = 1;
        errors.push('Crit closed without an exit status');
      } else if (errors.length > 0 && code === 0) {
        code = 1;
      }

      let stderrText = Buffer.concat(stderr).toString('utf8');
      if (errors.length > 0) {
        if (stderrText && !stderrText.endsWith('\n')) stderrText += '\n';
        stderrText += `${errors.map((error) => `crit waiter: ${error}`).join('\n')}\n`;
      }
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: stderrText,
      });
    });
  });
}

async function writeResult(resultFile, result) {
  const temporary = path.join(path.dirname(resultFile), `.crit-waiter-${randomUUID()}.tmp`);
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    try {
      await file.chmod(0o600);
      await file.writeFile(JSON.stringify(result), 'utf8');
    } finally {
      await file.close();
    }
    await rename(temporary, resultFile);
  } catch (error) {
    if (file) await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function main() {
  const jobFile = process.argv[2];
  if (process.argv.length !== 3 || !path.isAbsolute(jobFile)) {
    throw new Error('Expected one absolute job-file path');
  }

  const start = waitForGo();
  let job;
  try {
    job = JSON.parse(await readFile(jobFile, 'utf8'));
    if (!job || typeof job !== 'object' || typeof job.resultFile !== 'string' ||
        !path.isAbsolute(job.resultFile) || path.resolve(job.resultFile) === path.resolve(jobFile)) {
      throw new Error('Expected a distinct absolute result-file path');
    }
  } catch (error) {
    start.cancel();
    throw error;
  }

  notify({ type: 'ready' });
  const mayStart = await start.promise;

  let result;
  if (!mayStart) {
    result = {
      code: 1,
      signal: null,
      stdout: '',
      stderr: 'Crit waiter was not started before the bridge disconnected.\n',
    };
  } else if (typeof job.cwd !== 'string' || !path.isAbsolute(job.cwd)) {
    result = failedResult('expected an absolute working-directory path');
  } else if (!Array.isArray(job.args) || !job.args.every((arg) => typeof arg === 'string')) {
    result = failedResult('expected an array of string arguments');
  } else {
    result = await runCrit(job.cwd, job.args);
  }
  await writeResult(job.resultFile, result);
  notify({ type: 'result' });
}

main().catch((error) => {
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)
    ? ` (${error.code})` : '';
  process.stderr.write(`crit waiter: could not load the job or write the result${code}\n`);
  process.exitCode = 1;
});
