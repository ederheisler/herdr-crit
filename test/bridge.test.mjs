import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { eventually, withBridgeFixture } from './support/bridge-fixture.mjs';

const bridgeTest = (name, callback) => test(name, {
  skip: process.platform === 'win32' ? 'requires POSIX process and path semantics' : false,
  timeout: 45000,
}, () => withBridgeFixture(callback));

async function ok(fixture, ...args) {
  const result = await fixture.run(...args);
  assert.equal(result.code, 0, `${args[0]}: ${JSON.stringify(result.value)} ${result.stderr}`);
  assert.equal(result.signal, null);
  assert.equal(result.value.error, undefined);
  return result.value;
}

async function rejected(fixture, args, reason) {
  const result = await fixture.run(...args);
  assert.equal(result.code, 1, `${args[0]}: ${JSON.stringify(result.value)} ${result.stderr}`);
  assert.equal(result.signal, null);
  assert.match(result.value.error, reason);
  return result.value;
}

const request = (fixture, overrides = {}) => ({
  mode: 'files', story: false, target: 'file.js', cwd: fixture.workspace,
  agentAddress: 'terminal-1', ...overrides,
});
const start = (fixture, input) => ok(fixture, 'start', JSON.stringify(input));
const startRejected = (fixture, input, reason) => rejected(fixture, ['start', JSON.stringify(input)], reason);
const close = (fixture, id) => ok(fixture, 'close', id, '--confirmed', '--keep-browser');
const closeRejected = (fixture, id, reason) => rejected(fixture, ['close', id, '--confirmed', '--keep-browser'], reason);

async function finishSend(fixture, mode) {
  const event = await fixture.waitEvent(item => item.tool === 'hc' && item.kind === 'send-finish' && item.mode === mode);
  await eventually('handoff worker to exit', () => !fixture.isOwnedProcess(event.ppid));
  return event;
}

async function handoffFrom(event) {
  const pointer = event.args.at(-1);
  const match = /^Read the private Crit handoff at '([^']+)' in full/.exec(pointer);
  assert.ok(match, `not a private handoff pointer: ${pointer}`);
  const file = match[1];
  const stat = await fs.stat(file);
  assert.equal(stat.mode & 0o777, 0o600);
  return { pointer, message: await fs.readFile(file, 'utf8') };
}

bridgeTest('context and repository candidates report ready, non-repository and unavailable folders', async fixture => {
  const link = path.join(fixture.root, 'workspace-link');
  await fs.symlink(fixture.workspace, link);
  const ready = await ok(fixture, 'context', JSON.stringify({ cwd: link }));
  assert.equal(ready.cwd, fixture.workspace);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.message, null);

  await fixture.configure({ git: 'not_repository' });
  assert.equal((await ok(fixture, 'context', JSON.stringify({ cwd: fixture.workspace }))).status, 'not_repository');
  const notRepository = await ok(fixture, 'candidates', JSON.stringify({ mode: 'git', cwd: fixture.workspace }));
  assert.deepEqual(notRepository.options, []);
  assert.equal(notRepository.status, 'not_repository');
  assert.equal(notRepository.unavailable, true);
  assert.ok(notRepository.warning);
  await startRejected(fixture, request(fixture, { mode: 'git', target: '' }), /not in a Git working tree/i);

  await fixture.configure({ git: 'broken' });
  assert.equal((await ok(fixture, 'context', JSON.stringify({ cwd: fixture.workspace }))).status, 'unavailable');
  const unavailable = await ok(fixture, 'candidates', JSON.stringify({ mode: 'range', cwd: fixture.workspace }));
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.unavailable, true);
  assert.deepEqual(unavailable.options, []);
  await rejected(fixture, ['context', '{'], /JSON request/i);
  await rejected(fixture, ['context', JSON.stringify({ cwd: 'relative' })], /absolute working directory/i);
  await rejected(fixture, ['context', JSON.stringify({ cwd: path.join(fixture.workspace, 'missing') })], /does not exist/i);
});

bridgeTest('start rejects invalid and unsupported requests before launching a review', async fixture => {
  await rejected(fixture, ['start', '{'], /JSON request/i);
  for (const [changes, reason] of [
    [{ mode: 'unknown' }, /valid review mode/i],
    [{ story: 'true' }, /Story/i],
    [{ story: true }, /Story/i],
    [{ target: ' \n\t\r\n' }, /at least one file/i],
    [{ target: 'bad\0file' }, /working directory and target/i],
    [{ cwd: 'relative' }, /working directory and target/i],
    [{ cwd: path.join(fixture.workspace, 'missing') }, /does not exist/i],
    [{ machine: 'another-host' }, /remote spaces/i],
    [{ agentAddress: 'agent/name' }, /local agent/i],
    [{ agentAddress: '-option' }, /local agent/i],
    [{ mode: 'git', target: 'main\nother' }, /single line/i],
    [{ mode: 'live', target: 'https://example.com/' }, /do not supply a target/i],
    [{ mode: 'live', story: true, target: '' }, /Story/i],
    [{ mode: 'pr', target: 'https://user:password@example.com/pull/1' }, /credentials/i],
  ]) {
    await startRejected(fixture, request(fixture, changes), reason);
  }
  await fixture.configure({ address: 'different-terminal' });
  await startRejected(fixture, request(fixture), /stable local terminal address/i);
  await fixture.configure({ lookupFailure: true });
  await startRejected(fixture, request(fixture), /terminal is not available/i);

  // Invalid invocations are rejected by dispatch; no native browser or permission API runs.
  await rejected(fixture, ['chrome-access', '--unsupported'], /usage/i);
  await rejected(fixture, ['automation-settings', 'unexpected'], /usage/i);
  await rejected(fixture, ['open', 'not-an-id'], /invalid review ID/i);
  assert.equal((await fixture.events()).some(event => event.tool === 'crit'), false);
});

bridgeTest('Crit startup failure exposes actionable stderr', async fixture => {
  await fixture.configure({ critStartupFailure: true });
  const started = await start(fixture, request(fixture));
  const failed = await fixture.review(started.id, review => review.phase === 'error');
  assert.match(failed.error, /GitHub authentication required: run gh auth login/);
});

bridgeTest('Crit startup failure reports a missing executable', async fixture => {
  await fs.unlink(path.join(fixture.bin, 'crit'));
  const started = await start(fixture, request(fixture));
  const failed = await fixture.review(started.id, review => review.phase === 'error');
  assert.match(failed.error, /spawn crit ENOENT/i);
});

bridgeTest('whitespace-only Files lines are omitted without trimming genuine names and duplicate scopes are blocked', async fixture => {
  const names = ['  leading and trailing.js  ', 'src/second file.js'];
  const first = await start(fixture, request(fixture, { target: `${names[0]}\n \t \r\n${names[1]}\r\n` }));
  assert.match(first.id, /^[0-9a-f-]{36}$/);
  assert.equal(first.review.phase, 'starting');
  assert.equal(first.review.round, 1);
  await fixture.waitEvent(event => event.tool === 'crit' && event.kind === 'start');
  await startRejected(fixture, request(fixture, { target: `${names[0]}\n${names[1]}` }), /scope is already active/i);
  const different = await start(fixture, request(fixture, { target: `leading and trailing.js\n${names[1]}` }));
  const reviews = (await ok(fixture, 'list')).reviews;
  assert.equal(reviews.filter(review => review.id === first.id).length, 1);
  assert.ok(reviews.some(review => review.id === different.id));
});

bridgeTest('Application preparation is private, retryable, URL-free and exclusive until resolved', async fixture => {
  await fixture.startForeground();
  await fixture.configure({ status: 'working' });
  const first = await start(fixture, request(fixture, { mode: 'live', target: undefined }));
  assert.equal(first.review.target, '');
  assert.equal(first.review.phase, 'preparing_live');
  await fixture.review(first.id, review => review.phase === 'feedback_pending');
  assert.equal((await fixture.events()).some(event => event.tool === 'crit'), false);
  await startRejected(fixture, request(fixture, { mode: 'live', target: '' }), /scope is already active/i);
  await rejected(fixture, ['live-ready', first.id, 'http://localhost:4322'], /not waiting for Application preparation/i);
  await fixture.configure({ status: 'idle' });
  await ok(fixture, 'deliver', first.id);
  const sent = await finishSend(fixture, 'success');
  await handoffFrom(sent);
  await fixture.review(first.id, review => review.phase === 'preparing_live');
  for (const url of ['file:///tmp/app', 'https://user:password@example.com/', 'http://localhost:4322/\n', 'not-a-url']) {
    await rejected(fixture, ['live-ready', first.id, url], /HTTP or HTTPS/i);
  }
  assert.equal((await fixture.events()).some(event => event.tool === 'crit'), false);
  assert.equal((await close(fixture, first.id)).closed, true);
  await rejected(fixture, ['live-ready', first.id, 'http://localhost:4322'], /closed/i);
  const second = await start(fixture, request(fixture, { mode: 'live', target: '' }));
  assert.notEqual(second.id, first.id);
});

bridgeTest('Application callback preserves the actual target, transitions scopes and deduplicates the resolved scope', async fixture => {
  await fixture.startForeground();
  const first = await start(fixture, request(fixture, { mode: 'live', target: '' }));
  await finishSend(fixture, 'success');
  const target = 'http://127.0.0.1:4322/actual/app';
  const launched = await ok(fixture, 'live-ready', first.id, `${target}?secret=private#section`);
  assert.equal(launched.review.target, target);
  assert.match(launched.notice, /unverified/i);
  const launch = await fixture.waitEvent(event => event.tool === 'crit' && event.kind === 'start');
  assert.deepEqual(launch.args, ['live', '--no-open', target]);
  await ok(fixture, 'live-ready', first.id, target);
  assert.equal((await fixture.events()).filter(event => event.tool === 'crit').length, 1);
  await rejected(fixture, ['live-ready', first.id, 'http://localhost:4323/other'], /worker.*active|not waiting/i);
  const second = await start(fixture, request(fixture, { mode: 'live', target: '' }));
  await fixture.review(second.id, review => review.phase === 'preparing_live');
  await eventually('second Application prep delivery to settle', async () => {
    const record = JSON.parse(await fs.readFile(path.join(fixture.records, `${second.id}.json`), 'utf8'));
    return !record._worker && !record._delivery && record._waitingFor === 'live_prep';
  });
  await rejected(fixture, ['live-ready', second.id, 'http://127.0.0.1:4322/actual/app/?other=private'], /scope is already active/i);
  assert.equal((await fixture.events()).filter(event => event.tool === 'crit').length, 1);
  assert.equal((await ok(fixture, 'list')).reviews.find(review => review.id === second.id).target, '');
});

for (const [host, publicURL, expected] of [
  ['127.0.0.1', undefined, 'http://localhost:4321/live'],
  ['::1', undefined, 'http://localhost:4321/live'],
  ['127.0.0.1', 'https://crit.example.com/review', 'https://crit.example.com/review/live'],
]) {
  bridgeTest(`Application launch publishes a private continuation with Crit URL ${expected}`, async fixture => {
    const daemon = await fixture.startForeground();
    await fs.writeFile(path.join(fixture.root, 'crit-daemon-pid'), `${daemon.pid}\n`);
    // Model the daemon's parent relation to the fixture Crit launcher.
    const ps = path.join(fixture.bin, 'ps');
    const original = await fs.readFile(ps, 'utf8');
    await fs.writeFile(ps, original.replace('#!/bin/sh\n', `#!/bin/sh\nif [ "$1" = "-p" ] && [ "$4" = "ppid=" ]; then /bin/cat "$FIXTURE_ROOT/launch-parent"; exit; fi\n`));
    const started = await start(fixture, request(fixture, { mode: 'live', target: '' }));
    await finishSend(fixture, 'success');
    const target = 'http://127.0.0.1:4322/app';
    const callback = ok(fixture, 'live-ready', started.id, target);
    const launch = await fixture.waitEvent(event => event.tool === 'crit' && event.kind === 'start');
    await fs.writeFile(path.join(fixture.root, 'launch-parent'), String(launch.pid));
    const sessionId = createHash('sha256').update(`${fixture.workspace}\0live\0${target}`).digest('hex').slice(0, 12);
    await fs.writeFile(path.join(fixture.home, '.crit', 'sessions', `${sessionId}.json`), JSON.stringify({
      pid: daemon.pid, port: 4321, host, public_url: publicURL, cwd: fixture.workspace, branch: 'main',
      review_path: path.join(fixture.home, '.crit', 'reviews', sessionId),
      started_at: '2024-01-02T12:00:01.000Z', args: ['live', target],
    }));
    const result = await callback;
    assert.equal(result.review.url, expected);
    assert.equal(result.review.target, target);
    assert.equal(result.review.phase, 'reviewing');
    assert.ok(result.handoff);
    const file = /^Read the private Crit handoff at '([^']+)' in full/.exec(result.handoff)?.[1];
    assert.ok(file);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    const again = await ok(fixture, 'live-ready', started.id, target);
    assert.equal(again.handoff, result.handoff);
    assert.equal((await fixture.events()).filter(event => event.tool === 'crit').length, 1);
    const record = JSON.parse(await fs.readFile(path.join(fixture.records, `${started.id}.json`), 'utf8'));
    assert.ok(record._worker);
    assert.ok(record._waiter);
    assert.equal(record._delivery, undefined);
    assert.equal((await ok(fixture, 'list')).reviews.find(review => review.id === started.id)._liveVerificationFile, undefined);
  });
}

bridgeTest('list hides private fields and closed or malformed records, newest first', async fixture => {
  const older = await fixture.seedRecord({
    createdAt: '2024-01-01T00:00:00.000Z', phase: 'reviewing', _private: 'do-not-leak',
    comments: [{ body: 'A visible comment', path: 'src/file.js', line: 4 }],
  });
  const newer = await fixture.seedRecord({ createdAt: '2024-02-01T00:00:00.000Z', phase: 'agent_working' });
  const closed = await fixture.seedRecord({ createdAt: '2024-03-01T00:00:00.000Z', phase: 'closed' });
  await fs.writeFile(path.join(fixture.records, `${randomUUID()}.json`), '{bad json');
  await fs.writeFile(path.join(fixture.records, 'unrelated.json'), '{bad json');
  const result = await ok(fixture, 'list');
  assert.deepEqual(result.reviews.map(review => review.id), [newer, older]);
  assert.equal(result.reviews.some(review => review.id === closed), false);
  assert.deepEqual(result.reviews[1].comments, [{ body: 'A visible comment', path: 'src/file.js', line: 4 }]);
  assert.equal(JSON.stringify(result).includes('do-not-leak'), false);
  assert.equal(Object.keys(result.reviews[1]).some(key => key.startsWith('_')), false);
});

bridgeTest('list merges cached external sessions without duplicating managed or closed generations', async fixture => {
  const foreground = await fixture.startForeground();
  const generation = {
    pid: foreground.pid, started_at: '2024-01-02T12:00:01.000Z', process_started: 'Tue Jan 2 12:00:00 2024',
  };
  const suffix = createHash('sha256').update(`${generation.pid}\0${generation.started_at}`).digest('hex').slice(0, 12);
  const external = (sessionId, createdAt, url = 'http://127.0.0.1:4321/') => ({
    id: `external-${sessionId}-${suffix}`, source: 'external', mode: 'git', phase: 'external',
    sessionId, url, createdAt, _sessionGeneration: generation,
  });
  const managed = await fixture.seedRecord({
    sessionId: 'aaaaaaaaaaaa', createdAt: '2024-02-01T00:00:00.000Z',
  });
  await fixture.seedRecord({
    phase: 'closed', sessionId: 'bbbbbbbbbbbb', _sessionGeneration: generation,
  });
  const visible = external('cccccccccccc', '2024-04-01T00:00:00.000Z');
  const explicitlyClosed = external('dddddddddddd', '2024-05-01T00:00:00.000Z');
  await fs.writeFile(path.join(fixture.data, 'external.json'), JSON.stringify({
    reviews: [
      external('aaaaaaaaaaaa', '2024-03-01T00:00:00.000Z'),
      external('bbbbbbbbbbbb', '2024-06-01T00:00:00.000Z'),
      visible, explicitlyClosed,
      external('eeeeeeeeeeee', '2024-07-01T00:00:00.000Z', 'https://example.com/?secret=1'),
    ],
    closed: [explicitlyClosed.id],
  }));
  const result = await ok(fixture, 'list');
  assert.deepEqual(result.reviews.map(review => review.id), [visible.id, managed]);
  assert.equal(result.reviews[0].source, 'external');
  assert.equal(result.reviews[0]._sessionGeneration, undefined);
});

bridgeTest('close requires confirmation and leaves a replaced generation and its files untouched', async fixture => {
  const foreground = await fixture.startForeground();
  const source = path.join(fixture.workspace, 'source.js');
  const handoff = path.join(fixture.work, 'preserve.txt');
  await fs.writeFile(source, 'original source');
  await fs.writeFile(handoff, 'original handoff');
  const id = await fixture.seedRecord({
    sessionId: '0123456789ab', _sessionGeneration: { pid: foreground.pid, started_at: '2024-01-02T12:00:01.000Z' },
  });
  await rejected(fixture, ['close', id], /usage/i);
  await closeRejected(fixture, 'invalid', /invalid review ID/i);
  await closeRejected(fixture, randomUUID(), /not found/i);
  assert.ok((await ok(fixture, 'list')).reviews.some(review => review.id === id));
  const result = await close(fixture, id);
  assert.equal(result.closed, true);
  assert.match(result.notice, /missing or replaced/i);
  assert.equal((await ok(fixture, 'list')).reviews.some(review => review.id === id), false);
  assert.equal(fixture.isOwnedProcess(foreground.pid), true);
  assert.equal(await fs.readFile(source, 'utf8'), 'original source');
  assert.equal(await fs.readFile(handoff, 'utf8'), 'original handoff');
});

bridgeTest('confirmed close signals only the verified fixture generation', async fixture => {
  const daemon = await fixture.startForeground();
  const bystander = await fixture.startForeground();
  const stopped = new Promise(resolve => daemon.once('exit', (code, signal) => resolve({ code, signal })));
  const sessionId = '0123456789ab';
  const startedAt = '2024-01-02T12:00:01.000Z';
  await fs.writeFile(path.join(fixture.root, 'crit-daemon-pid'), `${daemon.pid}\n`);
  await fs.writeFile(path.join(fixture.home, '.crit', 'sessions', `${sessionId}.json`), JSON.stringify({
    pid: daemon.pid, port: 4321, cwd: fixture.workspace, branch: 'main',
    review_path: path.join(fixture.home, '.crit', 'reviews', sessionId),
    started_at: startedAt, args: [], host: '127.0.0.1',
  }));
  const id = await fixture.seedRecord({
    sessionId, _sessionGeneration: {
      pid: daemon.pid, started_at: startedAt, process_started: 'Tue Jan 2 12:00:00 2024',
    },
  });
  await rejected(fixture, ['close', id], /usage/i);
  assert.equal(fixture.isOwnedProcess(daemon.pid), true);
  assert.deepEqual(await close(fixture, id), { closed: true });
  await eventually('verified fixture daemon to stop', () => daemon.signalCode !== null);
  assert.deepEqual(await stopped, { code: null, signal: 'SIGTERM' });
  assert.equal(fixture.isOwnedProcess(bystander.pid), true);
  assert.equal((await ok(fixture, 'list')).reviews.some(review => review.id === id), false);
});

bridgeTest('close and reconnect reject unidentified generations and lost waiters safely', async fixture => {
  const foreground = await fixture.startForeground();
  const unidentified = await fixture.seedRecord({ sessionId: '111111111111' });
  await closeRejected(fixture, unidentified, /generation cannot be identified/i);
  const starting = await fixture.seedRecord({ phase: 'starting', _waiter: { goSent: true } });
  await closeRejected(fixture, starting, /daemon is not identified/i);

  const id = randomUUID();
  const scope = createHash('sha256')
    .update(`${fixture.workspace}\0files:${JSON.stringify([path.resolve(fixture.workspace, 'file.js')])}`)
    .digest('hex');
  const locks = path.join(fixture.data, 'locks');
  await fs.mkdir(locks, { recursive: true });
  await fs.writeFile(path.join(locks, `scope-${scope}`), id);
  const waiter = await fixture.seedWaiter(id, null, {
    pid: foreground.pid, started: 'Tue Jan 2 12:00:00 2024', goSent: true, generationCaptured: true,
  });
  await fixture.seedRecord({
    id, sessionId: '222222222222', _sessionGeneration: { pid: foreground.pid, started_at: '2024-01-02T12:00:01.000Z' },
    _scope: scope, _worker: randomUUID(), _workerPid: foreground.pid, _workerStarted: 'different generation', _waiter: waiter,
  });
  const lost = (await ok(fixture, 'list')).reviews.find(review => review.id === id);
  assert.equal(lost.phase, 'error');
  assert.match(lost.error, /waiter exited unexpectedly/i);
  assert.equal(lost.reconnectable, undefined);
  await rejected(fixture, ['reconnect', id], /cannot be safely reconnected/i);
  await startRejected(fixture, request(fixture), /scope is already active/i);
  assert.equal((await close(fixture, id)).closed, true);
  const replacement = await start(fixture, request(fixture));
  assert.equal(replacement.review.phase, 'starting');
  assert.equal(fixture.isOwnedProcess(foreground.pid), true);
});

bridgeTest('interrupted send blocks close through a failed retry and a confirmed retry clears it', async fixture => {
  const foreground = await fixture.startForeground();
  await fixture.configure({ status: 'working' });
  const id = randomUUID();
  const sessionId = 'abcdef123456';
  const waiter = await fixture.seedWaiter(id, {
    code: 0, signal: null, stdout: 'Distinct feedback: fix the boundary.', stderr: 'approved: false\n',
  }, { pid: foreground.pid, started: 'Tue Jan 2 12:00:00 2024', goSent: true, generationCaptured: true });
  await fixture.seedRecord({
    id, sessionId, _sessionGeneration: { pid: foreground.pid, started_at: '2024-01-02T12:00:01.000Z' },
    _worker: randomUUID(), _workerPid: foreground.pid, _workerStarted: 'different generation', _waiter: waiter,
  });
  const recovered = (await ok(fixture, 'list')).reviews.find(review => review.id === id);
  assert.equal(recovered.phase, 'error');
  assert.equal(recovered.reconnectable, true);
  assert.match(recovered.error, /reconnect/i);
  assert.equal((await ok(fixture, 'reconnect', id)).review.phase, 'starting');
  const busy = await fixture.review(id, review => review.phase === 'feedback_pending' && /not ready/i.test(review.error || ''));
  assert.equal(busy.round, 1);
  assert.equal((await fixture.events()).some(event => event.tool === 'crit'), false);

  await fixture.configure({ status: 'idle', send: 'hold' });
  await ok(fixture, 'deliver', id);
  const held = await fixture.waitEvent(event => event.tool === 'hc' && event.kind === 'send-start' && event.mode === 'hold');
  await closeRejected(fixture, id, /handoff.*in progress|outcome is unknown/i);
  fixture.interruptWorker(held.ppid);
  await eventually('interrupted worker to exit', () => !fixture.isOwnedProcess(held.ppid));
  const interrupted = await fixture.review(id, review => review.phase === 'feedback_pending' && /exited while delivering/i.test(review.error || ''));
  assert.equal(interrupted.round, 1);
  await closeRejected(fixture, id, /handoff.*in progress|outcome is unknown/i);

  await fixture.configure({ send: 'fail' });
  await ok(fixture, 'deliver', id);
  const failed = await fixture.review(id, review => review.phase === 'feedback_pending' && /transport failed/i.test(review.error || ''));
  assert.equal(failed.round, 1);
  await closeRejected(fixture, id, /handoff.*in progress|outcome is unknown/i);

  await fixture.configure({ send: 'success' });
  await ok(fixture, 'deliver', id);
  const sent = await finishSend(fixture, 'success');
  const handoff = await handoffFrom(sent);
  assert.ok(handoff.message.includes('Distinct feedback: fix the boundary.'));
  assert.ok(handoff.message.includes(sessionId));
  assert.equal(handoff.pointer.includes('Distinct feedback'), false);
  const delivered = (await ok(fixture, 'list')).reviews.find(review => review.id === id);
  assert.equal(delivered.phase, 'agent_working');
  assert.equal(delivered.round, 1);
  assert.equal((await close(fixture, id)).closed, true);
  assert.equal((await ok(fixture, 'list')).reviews.some(review => review.id === id), false);
  assert.equal((await fixture.events()).some(event => event.tool === 'crit'), false);
  assert.equal(fixture.isOwnedProcess(foreground.pid), true);
});

bridgeTest('a terminal becoming busy after lookup keeps the handoff pending until it is idle', async fixture => {
  await fixture.startForeground();
  // The lookup sees idle, but hc's atomic send-time check sees working.
  await fixture.configure({ status: 'idle', statusAtSend: 'working', send: 'success' });
  const id = await fixture.seedRecord({ phase: 'feedback_pending' });
  await fixture.seedPending(id, { kind: 'finish', approved: false, message: 'Private review feedback.' });
  await ok(fixture, 'deliver', id);
  const pending = await fixture.review(id, review =>
    review.phase === 'feedback_pending' && /no longer idle/i.test(review.error || ''));
  assert.equal(pending.round, 1);

  await fixture.configure({ statusAtSend: 'idle' });
  await ok(fixture, 'deliver', id);
  await finishSend(fixture, 'success');
  assert.equal((await ok(fixture, 'list')).reviews.find(review => review.id === id).phase, 'agent_working');
  assert.equal((await close(fixture, id)).closed, true);
});

bridgeTest('a done terminal receives an approved handoff without an idle-only condition', async fixture => {
  await fixture.startForeground();
  await fixture.configure({ status: 'done', send: 'success' });
  const id = await fixture.seedRecord({ phase: 'feedback_pending' });
  await fixture.seedPending(id, { kind: 'finish', approved: true, message: 'Private approval details.' });
  await ok(fixture, 'deliver', id);
  const sent = await finishSend(fixture, 'success');
  assert.equal((await handoffFrom(sent)).message, 'Private approval details.');
  assert.equal((await ok(fixture, 'list')).reviews.find(review => review.id === id).phase, 'approved');
  assert.equal((await close(fixture, id)).closed, true);
});

bridgeTest('resume requires the matching session or plan selector and starts the next round', async fixture => {
  const foreground = await fixture.startForeground();
  const sessionId = '123456789abc';
  const seedRegistry = (session, reviewPath) => fs.writeFile(
    path.join(fixture.home, '.crit', 'sessions', `${session}.json`),
    JSON.stringify({
      pid: foreground.pid, port: 4321, cwd: fixture.workspace, branch: 'main',
      review_path: reviewPath, started_at: '2024-01-02T12:00:01.000Z', args: [], host: '127.0.0.1',
    }),
  );
  await seedRegistry(sessionId, path.join(fixture.home, '.crit', 'reviews', sessionId));
  const id = await fixture.seedRecord({
    phase: 'agent_working', _waitingFor: 'finish', sessionId,
    _sessionGeneration: { pid: foreground.pid, started_at: '2024-01-02T12:00:01.000Z' },
  });
  await fixture.seedPending(id, { id: randomUUID(), kind: 'finish', approved: false });
  await rejected(fixture, ['resume', id, '--', 'crit', '--session', '111111111111'], /session does not match/i);
  await rejected(fixture, ['resume', id, '--', 'crit', '--session', sessionId, '--other'], /emitted crit --session/i);
  assert.equal((await ok(fixture, 'list')).reviews.find(review => review.id === id).round, 1);
  const resumed = await ok(fixture, 'resume', id, '--', 'crit', '--session', sessionId);
  assert.equal(resumed.review.phase, 'starting');
  assert.equal(resumed.review.round, 2);
  const reviewing = await fixture.review(id, review => review.phase === 'reviewing');
  assert.equal(reviewing.round, 2);
  assert.equal(reviewing.sessionId, sessionId);

  const plan = path.join(fixture.workspace, 'plan.md');
  await fs.writeFile(plan, '# Fixture plan\n');
  // Known Crit 0.23.2 plan identity for this slug, also covered by lifecycle tests.
  const slug = 'team-roadmap';
  const planSession = 'ee19040d1558';
  await seedRegistry(planSession, path.join(fixture.home, '.crit', 'plans', slug, '.crit'));
  const planId = await fixture.seedRecord({
    mode: 'plan', target: 'plan.md', phase: 'agent_working', _waitingFor: 'finish',
    _planSlug: slug, sessionId: planSession,
    _sessionGeneration: { pid: foreground.pid, started_at: '2024-01-02T12:00:01.000Z' },
  });
  await fixture.seedPending(planId, { id: randomUUID(), kind: 'finish', approved: false });
  await rejected(fixture, ['resume', planId, '--', 'crit', 'plan', '--name', 'other'], /slug does not match/i);
  const resumedPlan = await ok(fixture, 'resume', planId, '--', 'crit', 'plan', '--name', slug);
  assert.equal(resumedPlan.review.round, 2);
  const reviewingPlan = await fixture.review(planId, review => review.phase === 'reviewing');
  assert.equal(reviewingPlan.round, 2);
  assert.equal(reviewingPlan.sessionId, planSession);
});

bridgeTest('continuation commands reject wrong phases and malformed Story files', async fixture => {
  const id = await fixture.seedRecord({ mode: 'git', story: true, phase: 'reviewing' });
  const assigned = path.join(fixture.work, id, 'story.json');
  await fs.mkdir(path.dirname(assigned), { recursive: true });
  await rejected(fixture, ['git-ready', id], /not waiting for Git preparation/i);
  await rejected(fixture, ['story-ready', id, path.join(fixture.workspace, 'story.json')], /assigned to this review/i);
  await fs.writeFile(assigned, JSON.stringify({ prologue: {}, chapters: [], support: [], extra: true }));
  await rejected(fixture, ['story-ready', id, assigned], /only prologue, chapters, and support/i);
  await fs.writeFile(assigned, JSON.stringify({ prologue: {}, chapters: [], support: [] }));
  await rejected(fixture, ['story-ready', id, assigned], /not waiting for a Story/i);
  await rejected(fixture, ['deliver', id], /no handoff is waiting/i);
  assert.equal((await ok(fixture, 'list')).reviews.find(review => review.id === id).phase, 'reviewing');
  assert.equal((await fixture.events()).some(event => event.tool === 'crit'), false);
});
