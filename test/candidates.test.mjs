import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { withHelperFixture } from './support/helper-fixture.mjs';

const execFileAsync = promisify(execFile);

async function putFile(base, name) {
  const file = path.join(base, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, 'fixture\n');
}

function assertFiles(result, values, warning) {
  assert.deepEqual(result.options.map(option => option.value).sort(), values);
  assert.equal(result.warning, warning);
}

async function findGit() {
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const executable = path.join(directory, 'git');
    try {
      if (!(await fs.stat(executable)).isFile()) continue;
      await fs.access(executable, constants.X_OK);
      return executable;
    } catch {
      // Look only in explicit PATH directories for a usable Git executable.
    }
  }
  return null;
}

function forgeCommand(tool) {
  const pullRequests = [
    {
      number: 7,
      title: 'Fix\nlogin password=hunter2 at https://alice:secret@forge.example/review?token=abc#part',
      headRefName: 'feature/ghp_abcdefghijklmnop',
      url: 'https://alice:secret@forge.example/ignored?token=abc',
    },
    { number: 7, title: 'duplicate' },
    { number: 0, title: 'zero' },
    { number: -1, title: 'negative' },
    { number: 1.5, title: 'fraction' },
    { number: '2', title: 'string' },
    { number: 9007199254740992, title: 'unsafe integer' },
    null,
    { number: 3, title: '', headRefName: '' },
    { number: 12, title: 'T'.repeat(260), headRefName: 'x'.repeat(260) },
  ];
  const mergeRequests = [
    {
      iid: 23,
      number: 999,
      title: 'Deploy\tglpat-abcdefghijklmnop at https://bob:pass@git.example/group/repo?private=1#fragment',
      source_branch: 'release/api_key=topsecret',
    },
    { iid: 23, title: 'duplicate' },
    { iid: 0, title: 'zero' },
    { iid: '5', title: 'string' },
    { iid: 4, title: '', source_branch: null },
  ];
  return `#!${process.execPath}
const tool = ${JSON.stringify(tool)};
const args = process.argv.slice(2);
const mode = process.env.FIXTURE_FORGE_CASE;
const help = tool === 'glab' && args.includes('--help');
const valid = tool === 'gh'
  ? args[0] === 'pr' && args[1] === 'list' && args.includes('--json')
  : args[0] === 'mr' && args[1] === 'list' && (help || args[args.indexOf('--output') + 1] === 'json');
if (!valid) {
  process.exitCode = 2;
} else if (help) {
  if (mode === 'help-failure') {
    process.stderr.write('password=forge-secret\\n');
    process.exitCode = 1;
  } else if (mode === 'help-unsupported') {
    process.stdout.write('--output text\\n');
  } else {
    process.stdout.write('--output string   Output format: json\\n--per-page int\\n');
  }
} else if (mode === 'list-error') {
  process.stderr.write('password=forge-secret\\n');
  process.exitCode = 1;
} else if (mode === 'bad-json') {
  process.stdout.write('{broken');
} else if (mode === 'not-array') {
  process.stdout.write('{"items":[]}');
} else if (mode === 'many') {
  process.stdout.write(JSON.stringify(Array.from({ length: 205 }, (_, index) => ({
    number: index + 1, iid: index + 1, title: 'Request ' + (index + 1),
  }))));
} else {
  process.stdout.write(JSON.stringify(tool === 'gh' ? ${JSON.stringify(pullRequests)} : ${JSON.stringify(mergeRequests)}));
}
`;
}

async function runScenario(name, candidates) {
  const root = process.env.FIXTURE_ROOT;
  const workspace = process.env.FIXTURE_WORKSPACE;
  const request = mode => ({ mode, cwd: workspace });

  if (name === 'requests') {
    const invalidMode = { options: [], warning: 'Select a valid review mode.' };
    for (const input of [undefined, null, false, 'files', [], {}, { mode: 'unknown' }, { mode: 'GIT' }]) {
      assert.deepEqual(await candidates(input), invalidMode);
    }
    const invalidCwd = { options: [], warning: 'Choose an absolute local working directory.' };
    for (const cwd of [undefined, null, '', '.', 'relative/path', 42]) {
      assert.deepEqual(await candidates({ mode: 'live', cwd }), invalidCwd);
    }
    await putFile(workspace, 'ordinary-file.txt');
    const inaccessible = { options: [], warning: 'The local working directory does not exist or cannot be read.' };
    assert.deepEqual(await candidates({ mode: 'files', cwd: path.join(workspace, 'missing') }), inaccessible);
    assert.deepEqual(await candidates({ mode: 'live', cwd: path.join(workspace, 'ordinary-file.txt') }), inaccessible);
    assert.deepEqual(await candidates(request('live')), { options: [] });
    return;
  }

  if (name === 'live') {
    const records = [
      { mode: 'live', target: 'https://alpha.example.test/path?old=1#old', updatedAt: '2025-01-01T00:00:00Z' },
      { mode: 'live', target: 'https://alpha.example.test/path?token=private#section', updatedAt: '2025-01-04T00:00:00Z' },
      { mode: 'live', target: 'http://localhost:3210/preview?password=private', createdAt: '2025-01-03T00:00:00Z' },
      { mode: 'live', target: 'https://beta.example.test', updatedAt: '2025-01-02T00:00:00Z' },
      { mode: 'live', target: 'https://user:password@credentials.example/test', updatedAt: '2025-03-01T00:00:00Z' },
      { mode: 'live', target: 'https://user@credentials.example/test', updatedAt: '2025-03-01T00:00:00Z' },
      { mode: 'live', target: 'ftp://files.example/test', updatedAt: '2025-03-01T00:00:00Z' },
      { mode: 'live', target: 'file:///tmp/example', updatedAt: '2025-03-01T00:00:00Z' },
      { mode: 'live', target: 'javascript:alert(1)', updatedAt: '2025-03-01T00:00:00Z' },
      { mode: 'live', target: 'not a URL', updatedAt: '2025-03-01T00:00:00Z' },
      { mode: 'live', target: 'https://example.test/password=secret', updatedAt: '2025-03-01T00:00:00Z' },
      { mode: 'live', source: 'external', target: 'https://external.example/', updatedAt: '2025-03-01T00:00:00Z' },
      { mode: 'live', id: 'external-17', target: 'https://external-id.example/', updatedAt: '2025-03-01T00:00:00Z' },
      { mode: 'pr', target: 'https://other-mode.example/', updatedAt: '2025-03-01T00:00:00Z' },
      null,
      {},
    ];
    const expected = { options: [
      { value: 'https://alpha.example.test/path', label: 'https://alpha.example.test/path', detail: 'Recently used' },
      { value: 'http://localhost:3210/preview', label: 'http://localhost:3210/preview', detail: 'Recently used' },
      { value: 'https://beta.example.test/', label: 'https://beta.example.test/', detail: 'Recently used' },
    ] };
    assert.deepEqual(await candidates(request('live'), { records }), expected);
    assert.deepEqual(await candidates(request('live'), records), expected);
    assert.deepEqual(await candidates(request('live'), { records: 'invalid' }), { options: [] });
    return;
  }

  if (name === 'missing-tools') {
    const gitMissing = { options: [], warning: 'Git is not installed. Enter a ref manually.' };
    assert.deepEqual(await candidates(request('git')), gitMissing);
    assert.deepEqual(await candidates(request('range')), gitMissing);
    assert.deepEqual(await candidates(request('pr')), {
      options: [], warning: 'GitHub CLI (gh) is not installed. Install and authenticate it to review pull requests.',
    });
    assert.deepEqual(await candidates(request('mr')), {
      options: [], warning: 'GitLab CLI (glab) is not installed. Install and authenticate it to review merge requests.',
    });
    return;
  }

  if (name === 'local-files') {
    for (const file of [
      'main.js', 'docs/PLAN.MD', 'docs/note.markdown', 'docs/notes.txt', 'docs/home.HTML', 'docs/page.htm',
      '.env', '.hidden/private.md', '.ssh/id_rsa', 'node_modules/pkg.js', 'credentials.json', 'private.pem',
    ]) await putFile(workspace, file);
    await putFile(root, 'outside/leak.md');
    await fs.symlink(path.join(root, 'outside'), path.join(workspace, 'outside-link'), 'dir');
    await fs.symlink(path.join(workspace, 'main.js'), path.join(workspace, 'linked.js'));
    const warning = 'Git is not installed; showing nonhidden local files.';
    assertFiles(await candidates(request('files')), [
      'docs/PLAN.MD', 'docs/home.HTML', 'docs/note.markdown', 'docs/notes.txt', 'docs/page.htm', 'main.js',
    ], warning);
    assertFiles(await candidates(request('plan')), ['docs/PLAN.MD', 'docs/note.markdown'], warning);
    assertFiles(await candidates(request('preview')), ['docs/home.HTML', 'docs/page.htm'], warning);
    return;
  }

  if (name === 'controlled-files') {
    for (const file of [
      'good.js', 'nested/report.MD', 'nested/page.HTML', 'safe/public.txt', '.git/config', '.env',
      'nested/.env.production', 'node_modules/pkg.js', 'credentials.json', 'private.key',
      'password=abc.txt', 'nested/bad\nname.txt', '.ssh/private.txt',
    ]) await putFile(workspace, file);
    await putFile(root, 'outside/outside.txt');
    await fs.symlink(path.join(workspace, 'safe'), path.join(workspace, 'alias-dir'), 'dir');
    await fs.symlink(path.join(root, 'outside'), path.join(workspace, 'escape-dir'), 'dir');
    await fs.symlink(path.join(workspace, '.ssh'), path.join(workspace, 'secret-dir'), 'dir');
    await fs.symlink(path.join(workspace, 'good.js'), path.join(workspace, 'alias-leaf.js'));
    assertFiles(await candidates(request('files')), [
      'alias-dir/public.txt', 'good.js', 'nested/page.HTML', 'nested/report.MD',
    ]);
    assertFiles(await candidates(request('plan')), ['nested/report.MD']);
    assertFiles(await candidates(request('preview')), ['nested/page.HTML']);
    return;
  }

  if (name === 'controlled-refs') {
    const firstGit = [
      { value: 'main', label: 'main' },
      { value: 'feature/login', label: 'feature/login' },
      { value: 'HEAD', label: 'HEAD' },
      { value: 'feature/001', label: 'feature/001' },
    ];
    const firstRange = [firstGit[2], firstGit[0], firstGit[1], firstGit[3]];
    for (const [mode, first] of [['git', firstGit], ['range', firstRange]]) {
      const result = await candidates(request(mode));
      assert.equal(result.options.length, 200);
      assert.deepEqual(result.options.slice(0, 4), first);
      assert.deepEqual(result.options[199], { value: 'feature/197', label: 'feature/197' });
      assert.equal(result.warning, 'Showing the first 200 refs; enter another ref manually.');
      assert.ok(result.options.every(option => !option.value.includes('token=') && !option.value.includes('\u0001')));
    }
    process.env.FIXTURE_GIT_CASE = 'failure';
    for (const mode of ['git', 'range']) {
      assert.deepEqual(await candidates(request(mode)), {
        options: [], warning: 'Could not list Git branches. Enter a ref manually.',
      });
    }
    for (const mode of ['files', 'plan', 'preview']) {
      assert.deepEqual(await candidates(request(mode)), {
        options: [], warning: 'Could not list Git files. Enter a path manually.',
      });
    }
    return;
  }

  if (name === 'real-git') {
    process.env.GIT_CEILING_DIRECTORIES = root;
    const git = async (...args) => {
      await execFileAsync('git', args, { cwd: workspace, env: process.env, timeout: 5000 });
    };
    await putFile(workspace, 'local.txt');
    assertFiles(await candidates(request('files')), ['local.txt']);
    for (const mode of ['git', 'range']) {
      assert.deepEqual(await candidates(request(mode)), {
        options: [], warning: 'Could not list Git branches. Enter a ref manually.',
      });
    }

    const template = path.join(root, 'empty-template');
    await fs.mkdir(template);
    await git('init', '-q', `--template=${template}`);
    await git('symbolic-ref', 'HEAD', 'refs/heads/main');
    for (const file of [
      'tracked.js', 'docs/plan.md', 'docs/untracked.MARKDOWN', 'page.HTM', 'untracked.txt',
      'ignored.log', 'build/generated.js', '.env', 'credentials.json',
    ]) await putFile(workspace, file);
    await fs.writeFile(path.join(workspace, '.gitignore'), 'ignored.log\nbuild/\n');
    await fs.symlink(path.join(workspace, 'tracked.js'), path.join(workspace, 'linked.js'));
    await git('add', '--', '.gitignore', '.env', 'tracked.js', 'docs/plan.md');
    await git('-c', 'user.name=Fixture User', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'initial');
    await git('branch', 'feature/review');
    await git('update-ref', 'refs/remotes/origin/integration', 'HEAD');

    assertFiles(await candidates(request('files')), [
      '.gitignore', 'docs/plan.md', 'docs/untracked.MARKDOWN', 'local.txt', 'page.HTM', 'tracked.js', 'untracked.txt',
    ]);
    assertFiles(await candidates(request('plan')), ['docs/plan.md', 'docs/untracked.MARKDOWN']);
    assertFiles(await candidates(request('preview')), ['page.HTM']);
    const branches = await candidates(request('git'));
    assertFiles(branches, ['feature/review', 'main', 'origin/integration']);
    const range = await candidates(request('range'));
    assert.equal(range.options[0].value, 'HEAD');
    assertFiles(range, ['HEAD', 'feature/review', 'main', 'origin/integration']);
    return;
  }

  if (name === 'forge') {
    process.env.FIXTURE_FORGE_CASE = 'valid';
    assert.deepEqual(await candidates(request('pr')), { options: [
      { value: '7', label: '#7 Fix login password=[redacted] at https://forge.example/review', detail: 'feature/[redacted]' },
      { value: '3', label: '#3' },
      { value: '12', label: `#12 ${'T'.repeat(240)}`, detail: 'x'.repeat(240) },
    ] });
    assert.deepEqual(await candidates(request('mr')), { options: [
      { value: '23', label: '!23 Deploy [redacted] at https://git.example/group/repo', detail: 'release/api_key=[redacted]' },
      { value: '4', label: '!4' },
    ] });

    for (const failure of ['list-error', 'bad-json', 'not-array']) {
      process.env.FIXTURE_FORGE_CASE = failure;
      assert.deepEqual(await candidates(request('pr')), {
        options: [], warning: 'Could not load pull requests. Check the CLI authentication and repository.',
      });
      assert.deepEqual(await candidates(request('mr')), {
        options: [], warning: 'Could not load merge requests. Check the CLI authentication and repository.',
      });
    }
    process.env.FIXTURE_FORGE_CASE = 'help-failure';
    assert.deepEqual(await candidates(request('mr')), {
      options: [], warning: 'Could not load merge requests. Check the CLI authentication and repository.',
    });
    process.env.FIXTURE_FORGE_CASE = 'help-unsupported';
    assert.deepEqual(await candidates(request('mr')), {
      options: [], warning: 'This glab version does not advertise JSON output. Enter a merge request number or URL manually.',
    });
    process.env.FIXTURE_FORGE_CASE = 'many';
    for (const [mode, prefix] of [['pr', '#'], ['mr', '!']]) {
      const result = await candidates(request(mode));
      assert.equal(result.options.length, 200);
      assert.deepEqual(result.options[0], { value: '1', label: `${prefix}1 Request 1` });
      assert.deepEqual(result.options[199], { value: '200', label: `${prefix}200 Request 200` });
    }
    return;
  }

  throw new Error(`unknown candidate scenario: ${name}`);
}

if (process.argv[2] === '--fixture') {
  const { candidates } = await import('../candidates.mjs');
  await runScenario(process.argv[3], candidates);
} else {
  test('rejects invalid candidate requests and working directories', async () => {
    await withHelperFixture(fixture => fixture.run(import.meta.url, 'requests'));
  });

  test('returns safe recent live URLs in recency order without duplicates', async () => {
    await withHelperFixture(fixture => fixture.run(import.meta.url, 'live'));
  });

  test('reports missing Git and forge commands without falling through', async () => {
    await withHelperFixture(fixture => fixture.run(import.meta.url, 'missing-tools'));
  });

  test('discovers nonhidden local files and filters plan and preview extensions without Git', async () => {
    await withHelperFixture(fixture => fixture.run(import.meta.url, 'local-files'));
  });

  test('rejects unsafe Git paths and symlink escapes while retaining contained files', async () => {
    await withHelperFixture(async fixture => {
      const entries = [
        'good.js', 'good.js', 'nested/report.MD', 'nested/page.HTML', 'alias-dir/public.txt',
        'escape-dir/outside.txt', 'secret-dir/private.txt', 'alias-leaf.js', '../outside/outside.txt',
        path.join(fixture.root, 'outside', 'outside.txt'), 'nested/../good.js', 'nested//report.MD',
        '.git/config', '.env', 'nested/.env.production', 'node_modules/pkg.js', 'credentials.json',
        'private.key', 'password=abc.txt', 'nested/bad\nname.txt', 'missing.js',
      ];
      await fixture.addCommand('git', `#!${process.execPath}\nif (process.argv[2] !== 'ls-files') process.exit(2);\nprocess.stdout.write(${JSON.stringify(entries.join('\0') + '\0')});\n`);
      await fixture.run(import.meta.url, 'controlled-files');
    });
  });

  test('deduplicates and bounds refs and reports Git command failures safely', async () => {
    await withHelperFixture(async fixture => {
      const refs = [
        'main', 'main', 'feature/login', 'token=secret', 'feature/\u0001bad', 'HEAD',
        ...Array.from({ length: 201 }, (_, index) => `feature/${String(index + 1).padStart(3, '0')}`),
      ];
      await fixture.addCommand('git', `#!${process.execPath}
if (process.env.FIXTURE_GIT_CASE === 'failure' || process.argv[2] !== 'for-each-ref') {
  process.stderr.write('password=do-not-disclose\\n');
  process.exitCode = 1;
} else {
  process.stdout.write(${JSON.stringify(refs.join('\n') + '\n')});
}
`);
      await fixture.run(import.meta.url, 'controlled-refs');
    });
  });

  test('uses isolated Git branches, ranges and ignore rules and handles non-repositories', async t => {
    const git = await findGit();
    if (!git) {
      t.skip('Git executable is unavailable');
      return;
    }
    await withHelperFixture(async fixture => {
      await fixture.linkCommand('git', git);
      await fixture.run(import.meta.url, 'real-git', { timeout: 30000 });
    });
  });

  test('handles forge errors, JSON results, limits and sanitized labels', async () => {
    await withHelperFixture(async fixture => {
      await fixture.addCommand('gh', forgeCommand('gh'));
      await fixture.addCommand('glab', forgeCommand('glab'));
      await fixture.run(import.meta.url, 'forge', { timeout: 30000 });
    });
  });
}
