import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { withHelperFixture } from './support/helper-fixture.mjs';

const registryDir = () => path.join(process.env.FIXTURE_HOME, '.crit', 'sessions');
const registryPath = id => path.join(registryDir(), `${id}.json`);

function entry(overrides = {}) {
  return {
    pid: process.pid,
    port: 4321,
    cwd: '/',
    branch: 'main',
    review_path: '/reviews/.crit',
    started_at: '2024-01-02T12:00:01.000Z',
    args: [],
    host: '127.0.0.1',
    ...overrides,
  };
}

function writeEntry(id, value) {
  const temporary = path.join(registryDir(), `.${id}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify(value));
  fs.renameSync(temporary, registryPath(id));
}

function removeEntry(id) {
  fs.rmSync(registryPath(id), { force: true });
}

function launchOptions(args, overrides = {}) {
  return { args, cwd: '/', parentPid: async () => process.pid, ...overrides };
}

async function usingObserver(api, options, callback) {
  const observer = await api.prepareCritLaunch(options);
  try {
    return await callback(observer);
  } finally {
    observer.close();
  }
}

function fakeChild() {
  const child = new EventEmitter();
  child.pid = process.pid;
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

function expectedResult(id, startedAt, publicUrl = '') {
  return {
    sessionId: id,
    pid: process.pid,
    port: 4321,
    host: '127.0.0.1',
    public_url: publicUrl,
    review_path: '/reviews/.crit',
    started_at: startedAt,
    planSlug: null,
  };
}

async function registryValidation({ readCritSession, prepareCritLaunch }) {
  const id = '0123456789ab';
  assert.equal(readCritSession(id), null);
  for (const invalid of ['', '../0123456789ab', '0123456789a', '0123456789abc', '0123456789AB']) {
    assert.throws(() => readCritSession(invalid), /Invalid Crit session identity/);
  }

  const valid = entry();
  writeEntry(id, valid);
  assert.deepEqual(readCritSession(id), valid);

  for (const invalid of [
    null,
    [],
    {},
    { ...valid, pid: 1 },
    { ...valid, pid: 1.5 },
    { ...valid, port: 0 },
    { ...valid, port: 65536 },
    { ...valid, cwd: 'relative' },
    { ...valid, cwd: '/bad\0cwd' },
    { ...valid, branch: null },
    { ...valid, review_path: 'relative' },
    { ...valid, review_path: '/bad\0review' },
    { ...valid, started_at: 'not a date' },
    { ...valid, args: 'a.js' },
    { ...valid, args: ['bad\0file'] },
    { ...valid, host: 7 },
    { ...valid, public_url: 7 },
  ]) {
    writeEntry(id, invalid);
    assert.throws(() => readCritSession(id), /ambiguous identity/);
  }

  fs.writeFileSync(registryPath(id), '{invalid json');
  assert.throws(() => readCritSession(id), /could not be read safely/);
  await assert.rejects(prepareCritLaunch(launchOptions(['review', 'a.js'])), /could not be read safely/);
  removeEntry(id);
  fs.writeFileSync(path.join(registryDir(), 'not-a-session.json'), '{invalid json');
  await usingObserver({ prepareCritLaunch }, launchOptions(['review', 'a.js']), () => {});
}

async function processIdentity({ critProcessIdentity, matchesCritProcess }) {
  process.env.FIXTURE_PROCESS_PID = String(process.pid);
  process.env.PS_FAIL = '0';
  process.env.PS_OUTPUT = 'Tue Jan  2 12:00:00 2024   /opt/bin/crit _serve --port 4321';
  const identity = critProcessIdentity(process.pid);
  assert.deepEqual(identity, {
    started: 'Tue Jan 2 12:00:00 2024',
    command: '/opt/bin/crit _serve --port 4321',
  });
  const session = entry();
  assert.equal(matchesCritProcess(session, identity), true);
  assert.equal(matchesCritProcess(session, identity, 'Tue Jan  2 12:00:00 2024'), true);
  assert.equal(matchesCritProcess(session, identity, 'Tue Jan 2 11:59:59 2024'), false);
  assert.equal(matchesCritProcess(session, { ...identity, started: 'Tue Jan 2 12:00:02 2024' }), false);
  assert.equal(matchesCritProcess(session, { ...identity, started: 'invalid' }), false);
  assert.equal(matchesCritProcess({ ...session, started_at: 'invalid' }, identity), false);
  assert.equal(matchesCritProcess(session, null), false);
  for (const command of ['crit review', 'notcrit _serve', '/opt/bin/crit _serve-more', 'node /opt/bin/crit _serve']) {
    assert.equal(matchesCritProcess(session, { ...identity, command }), false);
  }
  assert.equal(matchesCritProcess(session, { ...identity, command: 'crit _serve' }), true);

  for (const pid of [0, 1, -1, 1.5, NaN, Infinity, '2']) assert.equal(critProcessIdentity(pid), null);
  for (const output of ['', 'not ps output', 'Tue Jan  2 12:00:00 2024']) {
    process.env.PS_OUTPUT = output;
    assert.equal(critProcessIdentity(process.pid), null);
  }
  process.env.PS_FAIL = '1';
  assert.equal(critProcessIdentity(process.pid), null);
}

async function argumentsAndRestrictions(api) {
  const { prepareCritLaunch } = api;
  const id = '0123456789ab';
  const badOptions = [
    [{ cwd: 'relative' }, /Invalid Crit launch observer options/],
    [{ cwd: '/bad\0cwd' }, /Invalid Crit launch observer options/],
    [{ cwd: path.join(process.env.FIXTURE_WORKSPACE, 'missing-directory') }, /Could not resolve/],
    [{ parentPid: null }, /Invalid Crit launch observer options/],
    [{ resumeSessionId: 'bad' }, /Invalid Crit launch observer options/],
    [{ resumeGeneration: { pid: process.pid, started_at: '2024-01-02' } }, /Invalid owned Crit session generation/],
    [{ resumeSessionId: id, resumeGeneration: { pid: 1, started_at: '2024-01-02' } }, /Invalid owned Crit session generation/],
    [{ resumeSessionId: id, resumeGeneration: { pid: process.pid, started_at: '' } }, /Invalid owned Crit session generation/],
  ];
  for (const [overrides, error] of badOptions) {
    await assert.rejects(prepareCritLaunch(launchOptions(['review'], overrides)), error);
  }

  const invalidArguments = [
    [null, /Invalid Crit launch arguments/],
    [['review', 1], /Invalid Crit launch arguments/],
    [['review', 'bad\0arg'], /Invalid Crit launch arguments/],
    [['review', '--unknown'], /Unsupported Crit launch arguments/],
    [['review', '--pr', '1', '--pr', '2'], /Unsupported Crit launch arguments/],
    [['review', '--base-branch='], /Invalid Crit launch arguments/],
    [['review', '--pr', '1', '--range', 'a..b'], /Invalid Crit review scope/],
    [['review', '--pr', '1', 'file.js'], /Invalid Crit review scope/],
    [['plan'], /Invalid Crit plan launch arguments/],
    [['plan', 'a.md', 'b.md'], /Invalid Crit plan launch arguments/],
    [['plan', '--pr', '1', 'a.md'], /Invalid Crit plan launch arguments/],
    [['plan', '--base-branch', 'main', 'a.md'], /Invalid Crit plan launch arguments/],
    [['plan', '--name', '---', 'a.md'], /Could not determine a Crit plan slug/],
    [['plan', path.join(process.env.FIXTURE_WORKSPACE, 'missing-plan.md')], /Could not read the plan input/],
    [['review', '--name', 'name'], /Unsupported Crit launch arguments/],
    [['live'], /Invalid Crit launch arguments/],
    [['preview', 'a', 'b'], /Invalid Crit launch arguments/],
    [['live', '--range', 'a..b', 'https://example.com'], /Invalid Crit launch arguments/],
    [['live', 'file:///tmp/page'], /Invalid Crit live origin/],
    [['live', 'https://user:password@example.com'], /Invalid Crit live origin/],
    [['live', 'not a URL'], /Invalid Crit live origin/],
  ];
  for (const [args, error] of invalidArguments) {
    await assert.rejects(prepareCritLaunch(launchOptions(args)), error, JSON.stringify(args));
  }

  for (const [args, overrides, error] of [
    [['review', '--session', id], {}, /may only resume this review/],
    [['review', '--session', id], { resumeSessionId: '111111111111' }, /may only resume this review/],
    [['review', '--session', id, 'a.js'], { resumeSessionId: id }, /may only resume this review/],
    [['review', '--session', id, '--base-branch', 'main'], { resumeSessionId: id }, /may only resume this review/],
    [['plan', '--session', id, 'a.md'], { resumeSessionId: id }, /may only resume this review/],
    [['review'], { resumeSessionId: id }, /requires its exact Crit session selector/],
    [['plan', '--name', 'Team ROADMAP!', 'a.md'], { resumeSessionId: id }, /plan does not match/],
  ]) {
    await assert.rejects(prepareCritLaunch(launchOptions(args, overrides)), error);
  }

  for (const [args, overrides] of [
    [['review', '--quiet', '--base-branch', 'main'], {}],
    [['review', '--', '-file.js'], {}],
    [['review', '--session', id], { resumeSessionId: id }],
    [['plan', '--name', 'Team ROADMAP!', 'a.md'], { resumeSessionId: 'ee19040d1558' }],
  ]) {
    await usingObserver(api, launchOptions(args, overrides), observer => {
      if (args[0] !== 'plan') assert.deepEqual(observer.args, args);
    });
  }
}

async function planSlugs(api) {
  await usingObserver(api, launchOptions(['plan', '--name=Team   ROADMAP!', 'absent.md', '--quiet']), observer => {
    assert.equal(observer.planSlug, 'team-roadmap');
    assert.deepEqual(observer.args, ['plan', '--name', 'team-roadmap', 'absent.md', '--quiet']);
  });

  const NativeDate = globalThis.Date;
  globalThis.Date = class extends NativeDate {
    constructor(...args) {
      super(...(args.length ? args : ['2024-03-05T12:34:56.000Z']));
    }
  };
  try {
    const file = path.join(process.env.FIXTURE_WORKSPACE, 'plan.md');
    fs.writeFileSync(file, '# !!!\n# İDEA & Scope\n');
    await usingObserver(api, launchOptions(['plan', file]), observer => {
      assert.equal(observer.planSlug, 'idea-scope-2024-03-05');
      assert.deepEqual(observer.args, ['plan', '--name', 'idea-scope-2024-03-05', file]);
    });
    fs.writeFileSync(file, `${Array(30).fill('body').join('\n')}\n# Too late\n`);
    await usingObserver(api, launchOptions(['plan', file]), observer => {
      assert.equal(observer.planSlug, 'plan-2024-03-05-123456');
    });
  } finally {
    globalThis.Date = NativeDate;
  }
}

async function versionedIdentityVectors(api) {
  // Crit v0.23.2 vectors for cwd '/'; the literal keys were calculated separately
  // with OpenSSL, not by calling or reimplementing the helper in this test.
  const vectors = [
    ['6b54b1efb779', ['review', 'b.js', 'a.js']],
    ['3213bee96618', ['review', '\u{10000}', '\uE000']],
    ['33278c59d79d', ['review', '--pr=+000123']],
    ['21681fd01ec4', ['review', '--pr', 'https://WWW.GITHUB.COM/team/repo/pull/00123?x=1#part']],
    ['c5d03e866d33', ['review', '--pr', 'https://git.example/team/repo/pull/123']],
    ['bbc1a80d10d4', ['review', '--range', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa..bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']],
    ['ee19040d1558', ['plan', '--name', 'Team ROADMAP!', 'absent.md']],
    ['ae3db51ea288', ['live', 'https://EXAMPLE.COM/path?x=1#part']],
    ['165d3d9a2fb1', ['preview', 'my-report.md']],
  ];
  for (const [id, args] of vectors) {
    // A different cwd cannot conflict by scope; rejection proves the literal key matched.
    writeEntry(id, entry({ cwd: process.env.FIXTURE_WORKSPACE }));
    try {
      await assert.rejects(api.prepareCritLaunch(launchOptions(args)), /existing or ambiguous Crit session/, id);
    } finally {
      removeEntry(id);
    }
  }
}

async function registryScopes(api) {
  const knownScopes = [
    ['5562de887b55', entry(), ['review', 'a.js']],
    ['7c63c1802e2a', entry({ args: ['a.js'] }), ['review', 'b.js']],
    ['ae3db51ea288', entry({ args: ['live', 'https://example.com/path'] }), ['preview', 'my-report.md']],
    ['165d3d9a2fb1', entry({ args: ['preview', '/my-report.md'] }), ['live', 'https://example.com/path']],
    ['ee19040d1558', entry({ review_path: path.join(process.env.FIXTURE_HOME, '.crit', 'plans', 'team-roadmap', '.crit') }), ['review', 'a.js']],
  ];
  for (const [id, value, args] of knownScopes) {
    writeEntry(id, value);
    try {
      await usingObserver(api, launchOptions(args), () => {});
    } finally {
      removeEntry(id);
    }
  }

  // Different spellings of the same file still conflict, even with different keys.
  writeEntry('5c76199ccef8', entry({ args: ['./a.js'] }));
  try {
    await assert.rejects(api.prepareCritLaunch(launchOptions(['review', 'a.js'])), /existing or ambiguous Crit session/);
  } finally {
    removeEntry('5c76199ccef8');
  }

  const unknownId = '0123456789ab';
  writeEntry(unknownId, entry());
  try {
    await assert.rejects(api.prepareCritLaunch(launchOptions(['review', 'a.js'])), /existing or ambiguous Crit session/);
    await assert.rejects(api.prepareCritLaunch(launchOptions(['review', '--mr', '123'])), /existing or ambiguous Crit session/);
    await usingObserver(api, launchOptions(['plan', '--name', 'Other Plan', 'absent.md']), () => {});
  } finally {
    removeEntry(unknownId);
  }
  writeEntry(unknownId, entry({ cwd: process.env.FIXTURE_WORKSPACE }));
  try {
    await usingObserver(api, launchOptions(['review', 'a.js']), () => {});
  } finally {
    removeEntry(unknownId);
  }
}

async function resumeAndGeneration(api) {
  const id = '0123456789ab';
  const value = entry({ public_url: 'https://example.test/review' });
  const args = ['review', '--session', id];
  const generation = { pid: process.pid, started_at: value.started_at };
  writeEntry(id, value);

  await assert.rejects(api.prepareCritLaunch(launchOptions(args, { resumeSessionId: id })), /not the recorded owned daemon/);
  // This fabricated number is compared as metadata only; it is never probed or signalled.
  await assert.rejects(api.prepareCritLaunch(launchOptions(args, {
    resumeSessionId: id, resumeGeneration: { ...generation, pid: process.pid + 1_000_000_000 },
  })), /not the recorded owned daemon/);
  await assert.rejects(api.prepareCritLaunch(launchOptions(args, {
    resumeSessionId: id, resumeGeneration: { ...generation, started_at: '2024-01-02T12:00:00.000Z' },
  })), /not the recorded owned daemon/);

  await usingObserver(api, launchOptions(args, { resumeSessionId: id, resumeGeneration: generation }), async observer => {
    assert.deepEqual(await observer.observe(fakeChild()), expectedResult(id, '2024-01-02T12:00:01.000Z', 'https://example.test/review'));
  });
  await usingObserver(api, launchOptions(args, { resumeSessionId: id, resumeGeneration: generation }), async observer => {
    writeEntry(id, { ...value, started_at: '2024-01-02T12:00:02.000Z' });
    await assert.rejects(observer.observe(fakeChild()), /owned Crit session changed before it could be resumed/);
  });
}

async function reviewUrls(api) {
  const id = '0123456789ab';
  const args = ['review', '--session', id];
  for (const url of ['not a URL', 'javascript:alert(1)', 'https://user:password@example.test/review', 'https://example.test/review?token=x', 'https://example.test/review#part']) {
    const value = entry({ public_url: url });
    writeEntry(id, value);
    await usingObserver(api, launchOptions(args, {
      resumeSessionId: id, resumeGeneration: { pid: process.pid, started_at: value.started_at },
    }), async observer => {
      await assert.rejects(observer.observe(fakeChild()), /unsafe review URL/);
    });
  }
}

async function observerOwnership(api) {
  const id = '6b54b1efb779';
  const args = ['review', 'b.js', 'a.js'];
  const value = entry({ args: ['a.js', 'b.js'] });
  await usingObserver(api, launchOptions(args, {
    parentPid: async pid => {
      assert.equal(pid, process.pid);
      return process.pid;
    },
  }), async observer => {
    const result = observer.observe(fakeChild());
    writeEntry(id, value);
    assert.deepEqual(await result, expectedResult(id, '2024-01-02T12:00:01.000Z'));
  });
  removeEntry(id);

  for (const [overrides, appeared, error] of [
    [{ parentPid: async () => null }, value, /Could not establish ownership/],
    [{ parentPid: async () => { throw new Error('unavailable'); } }, value, /Could not prove ownership/],
    [{}, { ...value, cwd: process.env.FIXTURE_WORKSPACE }, /different Crit session appeared/],
    [{}, { ...value, args: ['other.js'] }, /different Crit session appeared/],
    [{ parentPid: async pid => {
      assert.equal(pid, process.pid);
      writeEntry(id, { ...value, started_at: '2024-01-02T12:00:02.000Z' });
      return process.pid;
    } }, value, /session changed before ownership could be verified/],
  ]) {
    try {
      await usingObserver(api, launchOptions(args, overrides), async observer => {
        const result = observer.observe(fakeChild());
        writeEntry(id, appeared);
        await assert.rejects(result, error);
      });
    } finally {
      removeEntry(id);
    }
  }
}

async function observerLifecycle(api) {
  await usingObserver(api, launchOptions(['review', 'a.js']), async observer => {
    await assert.rejects(observer.observe(null), /spawned Crit process could not be identified/);
  });
  await usingObserver(api, launchOptions(['review', 'a.js']), async observer => {
    const child = fakeChild();
    const first = observer.observe(child);
    await assert.rejects(observer.observe(child), /already being observed/);
    observer.close();
    await assert.rejects(first, /observer was closed/);
  });
  await usingObserver(api, launchOptions(['review', 'a.js']), async observer => {
    const child = fakeChild();
    const result = observer.observe(child);
    child.emit('error', new Error('synthetic failure'));
    await assert.rejects(result, /Could not start the Crit review process/);
  });
  await usingObserver(api, launchOptions(['review', 'a.js']), async observer => {
    const child = fakeChild();
    const result = observer.observe(child);
    child.exitCode = 1;
    child.emit('exit', 1);
    await assert.rejects(result, /exited before its review session could be identified/);
  });
  await usingObserver(api, launchOptions(['review', 'a.js']), async observer => {
    observer.close();
    await assert.rejects(observer.observe(fakeChild()), /observer was closed/);
  });
}

async function storyExit(api) {
  const id = '6b54b1efb779';
  const args = ['review', 'b.js', 'a.js'];
  const value = entry({ args: ['a.js', 'b.js'], started_at: new Date(Date.now() + 60_000).toISOString() });
  await usingObserver(api, launchOptions(args, { confirmStoryOnExit: true }), async observer => {
    const child = fakeChild();
    const result = observer.observe(child);
    writeEntry(id, value);
    child.exitCode = 0;
    child.emit('exit', 0);
    await assert.rejects(result, /exited before its review session could be identified/);

    const report = `Started crit daemon at http://localhost:4321 (session ${id}, PID ${process.pid})`;
    assert.deepEqual(observer.confirmStoryExit(report), expectedResult(id, value.started_at));
    assert.throws(() => observer.confirmStoryExit(`${report}\n${report}`), /did not report a newly started daemon/);
    assert.throws(() => observer.confirmStoryExit('no daemon'), /did not report a newly started daemon/);
    assert.throws(() => observer.confirmStoryExit(`Started crit daemon at http://localhost (session ${id}, PID ${process.pid + 1_000_000_000})`), /does not match the newly started review/);
    writeEntry(id, { ...value, started_at: '2020-01-01T00:00:00.000Z' });
    assert.throws(() => observer.confirmStoryExit(report), /does not match the newly started review/);
  });
}

const scenarios = {
  registryValidation,
  processIdentity,
  argumentsAndRestrictions,
  planSlugs,
  versionedIdentityVectors,
  registryScopes,
  resumeAndGeneration,
  reviewUrls,
  observerOwnership,
  observerLifecycle,
  storyExit,
};

if (process.argv[2] === '--fixture') {
  const scenario = scenarios[process.argv[3]];
  if (!scenario) throw new Error(`Unknown lifecycle scenario: ${process.argv[3]}`);
  const api = await import('../lifecycle.mjs');
  // These cases use POSIX paths, an existing directory, and nonrecursive fs.watch.
  // They do not cover recursive watches, real Crit daemons, or remote filesystems.
  fs.mkdirSync(registryDir(), { recursive: true });
  await scenario(api);
} else {
  for (const [name, scenario] of [
    ['validates Crit registry entries and ignores unrelated filenames', 'registryValidation'],
    ['checks process identity and start time with a controlled ps', 'processIdentity'],
    ['enforces launch, scope, plan and resume argument restrictions', 'argumentsAndRestrictions'],
    ['normalizes explicit and derived Crit plan slugs', 'planSlugs'],
    ['recognizes Crit v0.23.2 literal session identity vectors', 'versionedIdentityVectors'],
    ['distinguishes known scopes and rejects ambiguous registries', 'registryScopes'],
    ['resumes only the recorded live process generation', 'resumeAndGeneration'],
    ['rejects unsafe review URLs returned by the registry', 'reviewUrls'],
    ['requires ownership and an unchanged generation for observed launches', 'observerOwnership'],
    ['closes observers and reports child lifecycle failures', 'observerLifecycle'],
    ['confirms only a matching freshly reported Story daemon', 'storyExit'],
  ]) {
    test(name, { skip: process.platform === 'win32' ? 'requires POSIX paths and /bin/sh' : false }, async () => {
      await withHelperFixture(async fixture => {
        if (scenario === 'processIdentity') {
          await fixture.addCommand('ps', `#!/bin/sh
[ "$3" = "$FIXTURE_PROCESS_PID" ] || exit 91
[ "$PS_FAIL" = "1" ] && exit 1
printf '%s\\n' "$PS_OUTPUT"
`);
        }
        await fixture.run(import.meta.url, scenario, { env: { TZ: 'UTC' }, timeout: 10_000 });
      });
    });
  }
}
