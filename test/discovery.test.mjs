import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { withHelperFixture } from './support/helper-fixture.mjs';

const startedAt = '2025-01-02T03:04:05.000Z';
const processStart = 'Wed Jan  1 00:00:00 2020';
const normalizedProcessStart = 'Wed Jan 1 00:00:00 2020';

const psCommand = `#!/bin/sh
if [ "$3" != "$DISCOVERY_PROCESS_PID" ]; then exit 1; fi
exec "$DISCOVERY_NODE" "$DISCOVERY_TEST_FILE" --fixture ps
`;

function sessionsDir() {
  return path.join(process.env.FIXTURE_HOME, '.crit', 'sessions');
}

function sessionFile(id) {
  return path.join(sessionsDir(), `${id}.json`);
}

function session(id, port, overrides = {}) {
  return {
    pid: process.pid,
    port,
    host: '127.0.0.1',
    cwd: process.env.FIXTURE_WORKSPACE,
    branch: 'main',
    review_path: path.join(process.env.FIXTURE_HOME, '.crit', 'reviews', id),
    started_at: startedAt,
    args: [],
    ...overrides,
  };
}

async function writeSession(id, entry) {
  await fs.mkdir(sessionsDir(), { recursive: true });
  await fs.writeFile(sessionFile(id), JSON.stringify(entry));
}

async function writeMetadata(directory, metadata) {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'review.json'), JSON.stringify(metadata));
}

async function withListener(callback) {
  const server = net.createServer(socket => socket.destroy());
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    return await callback(address.port);
  } finally {
    if (server.listening) {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }
}

async function runPsDouble() {
  if (process.env.DISCOVERY_REPLACEMENT_PATH) {
    const destination = process.env.DISCOVERY_REPLACEMENT_PATH;
    const temporary = `${destination}.replacement`;
    await fs.writeFile(temporary, process.env.DISCOVERY_REPLACEMENT_DATA);
    await fs.rename(temporary, destination);
  }
  if (process.env.DISCOVERY_PS_FAIL === '1') {
    process.exitCode = 1;
    return;
  }
  const started = process.env.DISCOVERY_PS_STARTED ?? processStart;
  const command = process.env.DISCOVERY_PS_COMMAND ?? '/fixture/bin/crit _serve';
  process.stdout.write(`${started} ${command}\n`);
}

async function runScenario(name) {
  assert.equal(process.env.HOME, process.env.FIXTURE_HOME);
  assert.equal(process.env.HERDR_APP_HOME, process.env.FIXTURE_APP_HOME);
  process.env.DISCOVERY_PROCESS_PID = String(process.pid);
  process.env.DISCOVERY_NODE = process.execPath;
  process.env.DISCOVERY_TEST_FILE = fileURLToPath(import.meta.url);
  const { discover, externalId } = await import('../discovery.mjs');

  switch (name) {
    case 'identities': {
      // SHA-256 vectors independently obtained with shasum over PID, NUL, and timestamp.
      const generation = { pid: 12345, started_at: startedAt, process_started: 'first process start' };
      assert.equal(externalId('abcdef123456', generation), 'external-abcdef123456-1df90f53f048');
      assert.equal(externalId('abcdef123456', { ...generation, process_started: 'another process start' }),
        'external-abcdef123456-1df90f53f048');
      assert.equal(externalId('fedcba654321', generation), 'external-fedcba654321-1df90f53f048');
      assert.equal(externalId('abcdef123456', { ...generation, pid: 54321 }),
        'external-abcdef123456-334f02394f9d');
      assert.equal(externalId('abcdef123456', { ...generation, started_at: '2025-01-02T03:04:06.000Z' }),
        'external-abcdef123456-0594558f5a1d');
      break;
    }

    case 'empty': {
      assert.deepEqual(await discover(), { reviews: [] });
      await fs.mkdir(sessionsDir(), { recursive: true });
      assert.deepEqual(await discover(), { reviews: [] });
      break;
    }

    case 'invalid': {
      await withListener(async port => {
        const valid = session('111111111111', port);
        await fs.mkdir(sessionsDir(), { recursive: true });
        await fs.writeFile(path.join(sessionsDir(), 'ABCDEFABCDEF.json'), JSON.stringify(valid));
        await fs.writeFile(path.join(sessionsDir(), 'abcdefabcdef.json.backup'), JSON.stringify(valid));
        await fs.writeFile(sessionFile('000000000001'), '{not json');
        await fs.mkdir(sessionFile('000000000002'));
        const invalid = [
          null,
          [],
          { ...valid, pid: 1 },
          { ...valid, port: 0 },
          { ...valid, port: 65536 },
          { ...valid, cwd: 'relative/path' },
          { ...valid, branch: 1 },
          { ...valid, review_path: 'relative/review' },
          { ...valid, started_at: 'not a date' },
          { ...valid, args: ['file', 1] },
          { ...valid, args: ['file\0name'] },
          { ...valid, host: 5 },
          { ...valid, public_url: 5 },
          { ...valid, pid: 2147483647 },
        ];
        for (let i = 0; i < invalid.length; i++) {
          await writeSession((i + 3).toString(16).padStart(12, '0'), invalid[i]);
        }
        const localAddresses = new Set(Object.values(os.networkInterfaces()).flat().filter(Boolean).map(item => item.address));
        const remoteHost = Array.from({ length: 254 }, (_, index) => `192.0.2.${index + 1}`)
          .find(address => !localAddresses.has(address));
        assert.ok(remoteHost, 'a TEST-NET address must not be assigned to a local interface');
        const remoteId = 'abcdef123456';
        await writeSession(remoteId, session(remoteId, port, { host: remoteHost, args: ['file.js'] }));

        const connect = net.createConnection;
        let externalAttempts = 0;
        net.createConnection = (...args) => {
          if (args[0]?.host !== '127.0.0.1' || args[0]?.port !== port) {
            externalAttempts++;
            throw new Error('Connection outside the fixture is forbidden');
          }
          return connect(...args);
        };
        syncBuiltinESMExports();
        try {
          assert.deepEqual(await discover(), { reviews: [] });
          assert.equal(externalAttempts, 0);
        } finally {
          net.createConnection = connect;
          syncBuiltinESMExports();
        }
      });
      break;
    }

    case 'process-identity': {
      await withListener(async port => {
        const id = 'abcdef123456';
        await writeSession(id, session(id, port, { args: ['file.js'] }));
        for (const command of ['node worker.js', 'crit _server', 'notcrit _serve']) {
          process.env.DISCOVERY_PS_COMMAND = command;
          assert.deepEqual(await discover(), { reviews: [] }, command);
        }
        delete process.env.DISCOVERY_PS_COMMAND;
        process.env.DISCOVERY_PS_STARTED = 'not a process start';
        assert.deepEqual(await discover(), { reviews: [] });
        process.env.DISCOVERY_PS_STARTED = 'Wed Jan  1 00:00:00 2031';
        assert.deepEqual(await discover(), { reviews: [] });
        delete process.env.DISCOVERY_PS_STARTED;
        process.env.DISCOVERY_PS_FAIL = '1';
        assert.deepEqual(await discover(), { reviews: [] });
        delete process.env.DISCOVERY_PS_FAIL;
        const { reviews } = await discover();
        assert.equal(reviews.length, 1);
        assert.deepEqual(reviews[0]._sessionGeneration, {
          pid: process.pid, started_at: startedAt, process_started: normalizedProcessStart,
        });
      });
      break;
    }

    case 'selection': {
      await withListener(async port => {
        const entries = [
          ['111111111111', '2025-01-02T03:04:05.000Z', 'old.js'],
          ['222222222222', '2025-03-02T03:04:05.000Z', 'new.js'],
          ['333333333333', '2025-02-02T03:04:05.000Z', 'middle.js'],
        ];
        for (const [id, time, file] of entries) {
          await writeSession(id, session(id, port, { started_at: time, args: [file] }));
        }
        const first = (await discover()).reviews;
        assert.deepEqual(first.map(({ sessionId, mode, target, createdAt }) => ({ sessionId, mode, target, createdAt })), [
          { sessionId: '222222222222', mode: 'files', target: 'new.js', createdAt: '2025-03-02T03:04:05.000Z' },
          { sessionId: '333333333333', mode: 'files', target: 'middle.js', createdAt: '2025-02-02T03:04:05.000Z' },
          { sessionId: '111111111111', mode: 'files', target: 'old.js', createdAt: '2025-01-02T03:04:05.000Z' },
        ]);
        const again = (await discover()).reviews;
        assert.deepEqual(again.map(review => review.id), first.map(review => review.id));
        for (const review of first) {
          assert.match(review.id, new RegExp(`^external-${review.sessionId}-[0-9a-f]{12}$`));
          assert.deepEqual(review._sessionGeneration, {
            pid: process.pid, started_at: review.createdAt, process_started: normalizedProcessStart,
          });
        }

        const id = '111111111111';
        await writeSession(id, session(id, port, { started_at: '2025-04-02T03:04:05.000Z', args: ['old.js'] }));
        const replaced = (await discover()).reviews;
        assert.deepEqual(replaced.map(review => review.sessionId), ['111111111111', '222222222222', '333333333333']);
        assert.notEqual(replaced[0].id, first.find(review => review.sessionId === id).id);
        assert.deepEqual(replaced[0]._sessionGeneration, {
          pid: process.pid, started_at: '2025-04-02T03:04:05.000Z', process_started: normalizedProcessStart,
        });
        assert.equal(replaced[1].id, first[0].id);
        assert.equal(replaced[2].id, first[1].id);
      });
      break;
    }

    case 'replacement': {
      await withListener(async port => {
        const id = 'abcdef123456';
        const original = session(id, port, { args: ['file.js'], public_url: 'https://reviews.example/original' });
        await writeSession(id, original);
        assert.equal((await discover()).reviews.length, 1);
        const replacements = [
          ['pid', JSON.stringify({ ...original, pid: 2147483647 })],
          ['start time', JSON.stringify({ ...original, started_at: '2025-01-02T03:04:06.000Z' })],
          ['port', JSON.stringify({ ...original, port: port === 65535 ? port - 1 : port + 1 })],
          ['host', JSON.stringify({ ...original, host: '0.0.0.0' })],
          ['public URL', JSON.stringify({ ...original, public_url: 'https://reviews.example/replacement' })],
          ['invalid replacement', '{not json'],
        ];
        for (const [description, data] of replacements) {
          await writeSession(id, original);
          process.env.DISCOVERY_REPLACEMENT_PATH = sessionFile(id);
          process.env.DISCOVERY_REPLACEMENT_DATA = data;
          try {
            assert.deepEqual(await discover(), { reviews: [] }, description);
          } finally {
            delete process.env.DISCOVERY_REPLACEMENT_PATH;
            delete process.env.DISCOVERY_REPLACEMENT_DATA;
          }
        }
      });
      break;
    }

    case 'metadata': {
      await withListener(async port => {
        const id = 'abcdef123456';
        const entry = session(id, port, {
          cwd: path.join(process.env.FIXTURE_WORKSPACE, '\x1b[31mproject\x1b[0m token=cwd-secret'),
          args: ['live', 'https://user:pass@source.example/app?token=target-secret#fragment'],
          public_url: 'https://public:private@reviews.example/path?token=url-secret#top',
        });
        await writeSession(id, entry);
        await writeMetadata(entry.review_path, {
          cli_args: ['--pr=metadata-secret'],
          review_type: 'preview',
          origin: 'origin-secret',
          story: { text: 'story-secret' },
          comments: [{ text: 'comment-secret' }],
          token: 'metadata-token-secret',
          updated_at: '2025-01-03T05:30:00+02:30',
        });
        const result = await discover();
        assert.equal(result.reviews.length, 1);
        const { id: external, _sessionGeneration, ...review } = result.reviews[0];
        assert.match(external, /^external-abcdef123456-[0-9a-f]{12}$/);
        assert.deepEqual(_sessionGeneration, {
          pid: process.pid, started_at: startedAt, process_started: normalizedProcessStart,
        });
        assert.deepEqual(review, {
          source: 'external',
          mode: 'live',
          story: true,
          target: 'https://source.example/app',
          cwd: path.join(process.env.FIXTURE_WORKSPACE, 'project token=[redacted]'),
          machine: null,
          phase: 'external',
          url: `http://127.0.0.1:${port}/live#story`,
          sessionId: id,
          agentAddress: null,
          createdAt: startedAt,
          updatedAt: '2025-01-03T03:00:00.000Z',
        });
        assert.doesNotMatch(JSON.stringify(result), /cwd-secret|target-secret|url-secret|metadata-secret|origin-secret|story-secret|comment-secret|metadata-token-secret/);
      });
      break;
    }

    case 'scopes': {
      await withListener(async port => {
        const planPath = path.join(process.env.FIXTURE_HOME, '.crit', 'plans', 'release-plan', '.crit');
        const untrustedPath = path.join(process.env.FIXTURE_WORKSPACE, 'unrelated');
        // This registry key is an independent shasum vector for /fixture/project, NUL, main.
        const cases = [
          { id: '1a9b3c38d943', expected: ['git', '', false] },
          { id: 'aaaaaaaaaaaa', expected: ['review', '', false] },
          {
            id: 'bbbbbbbbbbbb',
            entry: { args: ['src/a.js', 'token=abc \x1b[31msrc/secret.js\x1b[0m'] },
            metadata: { cli_args: ['--pr=ignored'] },
            expected: ['files', 'src/a.js\ntoken=[redacted] src/secret.js', false],
          },
          { id: 'cccccccccccc', entry: { review_path: planPath }, metadata: { story: [] }, expected: ['plan', 'release-plan', false] },
          { id: 'dddddddddddd', metadata: { cli_args: ['pr:org/repo#14'] }, expected: ['pr', 'org/repo#14', false] },
          { id: 'eeeeeeeeeeee', metadata: { cli_args: ['--mr=42'] }, expected: ['mr', '42', false] },
          { id: 'ffffffffffff', metadata: { cli_args: ['--range', 'main...feature'] }, expected: ['range', 'main...feature', false] },
          {
            id: '111111111111',
            metadata: { review_type: 'preview', origin: 'report password=secret https://name:pw@docs.example/file?token=abc#private', updated_at: 'invalid' },
            entry: { public_url: 'https://reviews.example/base/preview' },
            expected: ['preview', 'report password=[redacted] https://docs.example/file', false],
          },
          {
            id: '222222222222',
            entry: { review_path: untrustedPath },
            metadata: { review_type: 'live', origin: 'https://secret.example/', story: { text: 'private' } },
            expected: ['review', '', false],
          },
          {
            id: '333333333333',
            metadata: { review_type: 'live', origin: 'https://user:pass@origin.example/root?token=meta-secret#fragment' },
            expected: ['live', 'https://origin.example/root', false],
          },
          {
            id: '444444444444',
            entry: { review_path: path.join(process.env.FIXTURE_HOME, '.crit', 'reviews', '555555555555') },
            metadata: { review_type: 'live', origin: 'https://secret.example/', story: { text: 'private' } },
            expected: ['review', '', false],
          },
          { id: '666666666666', rawMetadata: '{not json', expected: ['review', '', false] },
          { id: '777777777777', metadata: { review_type: 'live', origin: 'javascript:alert(1)' }, expected: ['live', '', false] },
        ];
        for (const item of cases) {
          const entry = session(item.id, port, { cwd: '/fixture/project', ...item.entry });
          await writeSession(item.id, entry);
          if (item.metadata) await writeMetadata(entry.review_path, item.metadata);
          if (item.rawMetadata) {
            await fs.mkdir(entry.review_path, { recursive: true });
            await fs.writeFile(path.join(entry.review_path, 'review.json'), item.rawMetadata);
          }
        }
        const { reviews } = await discover();
        assert.equal(reviews.length, cases.length);
        const byId = new Map(reviews.map(review => [review.sessionId, review]));
        for (const item of cases) {
          const review = byId.get(item.id);
          assert.ok(review, item.id);
          assert.deepEqual([review.mode, review.target, review.story], item.expected, item.id);
        }
        const preview = byId.get('111111111111');
        assert.equal(preview.url, 'https://reviews.example/base/preview');
        assert.equal(preview.updatedAt, startedAt);
        assert.doesNotMatch(JSON.stringify(reviews), /token=abc|password=secret|name:pw|meta-secret|secret\.example|"private"/);
      });
      break;
    }

    case 'urls': {
      await withListener(async port => {
        const fallback = `http://127.0.0.1:${port}/live`;
        const cases = [
          ['a00000000001', 'https://user:pass@reviews.example/room', fallback],
          ['a00000000002', 'https://reviews.example/room?token=secret', fallback],
          ['a00000000003', 'https://reviews.example/room#private', fallback],
          ['a00000000004', 'javascript:alert(1)', fallback],
          ['a00000000005', 'https://reviews.example/room/', 'https://reviews.example/room/live'],
          ['a00000000006', 'https://reviews.example/room/live', 'https://reviews.example/room/live'],
        ];
        for (const [id, publicUrl] of cases) {
          await writeSession(id, session(id, port, {
            args: ['live', 'https://origin:password@source.example/path?token=hidden#fragment'],
            public_url: publicUrl,
          }));
        }
        const { reviews } = await discover();
        assert.equal(reviews.length, cases.length);
        const byId = new Map(reviews.map(review => [review.sessionId, review]));
        for (const [id, , expected] of cases) {
          const review = byId.get(id);
          assert.ok(review, id);
          assert.equal(review.url, expected, id);
          assert.equal(review.mode, 'live');
          assert.equal(review.target, 'https://source.example/path');
        }
        assert.doesNotMatch(JSON.stringify(reviews), /user:pass|token=secret|#private|origin:password|token=hidden|#fragment/);
      });
      break;
    }

    default:
      throw new Error(`Unknown discovery scenario: ${name}`);
  }
}

if (process.argv[2] === '--fixture') {
  if (process.argv[3] === 'ps') await runPsDouble();
  else await runScenario(process.argv[3]);
} else {
  const cases = [
    ['external identities use stable, generation-specific vectors', 'identities'],
    ['missing and empty Crit session directories contain no reviews', 'empty'],
    ['invalid, dead, and unrelated registry entries are ignored', 'invalid'],
    ['only a matching live Crit process is discovered', 'process-identity'],
    ['live sessions are ordered and retain generation-specific identities', 'selection'],
    ['a replaced generation or endpoint is not discovered', 'replacement'],
    ['review metadata is safely projected without private contents', 'metadata'],
    ['review scopes derive from trusted session and metadata inputs', 'scopes'],
    ['unsafe public URLs fall back to the owned loopback listener', 'urls'],
  ];
  for (const [description, scenario] of cases) {
    test(description, async () => {
      await withHelperFixture(async fixture => {
        await fixture.addCommand('ps', psCommand);
        await fixture.run(import.meta.url, scenario, { timeout: 15000 });
      });
    });
  }
}
