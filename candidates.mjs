import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';

const MODES = new Set(['git', 'files', 'plan', 'live', 'preview', 'pr', 'mr', 'range']);
const LIMIT = 200;
const MAX_OUTPUT = 4 * 1024 * 1024;
const MAX_ENTRIES = 20000;
const MAX_DIRECTORIES = 500;
const secretValue = /\b(?:gh[opsu]_[a-z0-9]{10,}|github_pat_[a-z0-9_]{10,}|glpat-[a-z0-9_-]{10,}|sk-[a-z0-9_-]{12,}|AKIA[0-9A-Z]{16})\b|\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|passwd|secret|token)\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/i;

function cleanText(value) {
  return String(value || '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/https?:\/\/[^\s<>"']+/gi, text => {
      try {
        const url = new URL(text);
        url.username = ''; url.password = ''; url.search = ''; url.hash = '';
        return url.toString();
      } catch { return '[URL]'; }
    })
    .replace(/\b(?:gh[opsu]_[a-z0-9]{10,}|github_pat_[a-z0-9_]{10,}|glpat-[a-z0-9_-]{10,}|sk-[a-z0-9_-]{12,}|AKIA[0-9A-Z]{16})\b/gi, '[redacted]')
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|passwd|secret|token)\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi, '$1=[redacted]')
    .trim().slice(0, 240);
}

function safePath(value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value) || secretValue.test(value)) return false;
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /^(?:node_modules|\.git|\.ssh|\.aws|\.gnupg|\.docker|\.kube|\.azure)$/i.test(part))) return false;
  const name = parts[parts.length - 1];
  return !/^(?:\.env(?:\..*)?|\.netrc|\.npmrc|\.pypirc|\.dockercfg|\.git-credentials|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|credentials(?:\.(?:json|yaml|yml|ini))?)$/i.test(name)
    && !/\.(?:pem|key|p12|pfx|jks|keystore)$/i.test(name);
}

function matchesMode(mode, file) {
  if (mode === 'plan') return /\.(?:md|markdown)$/i.test(file);
  if (mode === 'preview') return /\.(?:html|htm)$/i.test(file);
  return true;
}

function run(executable, args, cwd, maxOutput = MAX_OUTPUT) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(executable, args, {
        cwd,
        env: { ...process.env, CI: 'true', GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 15000,
        killSignal: 'SIGKILL',
      });
    } catch (error) {
      resolve({ code: null, error: error.code, stdout: '', stderr: '', truncated: false });
      return;
    }
    const output = [], errors = [];
    let size = 0, errorSize = 0, truncated = false, failure;
    child.stdout.on('data', chunk => {
      if (truncated) return;
      const remaining = maxOutput - size;
      if (chunk.length > remaining) {
        if (remaining > 0) output.push(chunk.subarray(0, remaining));
        truncated = true;
        child.kill('SIGKILL');
      } else {
        output.push(chunk);
        size += chunk.length;
      }
    });
    child.stderr.on('data', chunk => {
      if (errorSize >= 8192) return;
      const part = chunk.subarray(0, 8192 - errorSize);
      errors.push(part);
      errorSize += part.length;
    });
    child.once('error', error => { failure = error.code; });
    child.once('close', code => resolve({
      code, error: failure, truncated,
      stdout: Buffer.concat(output).toString('utf8'),
      stderr: Buffer.concat(errors).toString('utf8'),
    }));
  });
}

async function refs(mode, cwd) {
  const result = await run('git', ['for-each-ref', `--count=${LIMIT + 50}`, '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'], cwd);
  if (result.code !== 0 || result.truncated) {
    return { options: [], warning: result.error === 'ENOENT' ? 'Git is not installed. Enter a ref manually.' : 'Could not list Git branches. Enter a ref manually.' };
  }
  const values = mode === 'range' ? ['HEAD'] : [];
  const seen = new Set(values);
  for (const ref of result.stdout.split('\n')) {
    if (!ref || /[\x00-\x1f\x7f]/.test(ref) || secretValue.test(ref) || seen.has(ref)) continue;
    seen.add(ref);
    values.push(ref);
  }
  const options = values.slice(0, LIMIT).map(value => ({ value, label: value }));
  return values.length > LIMIT ? { options, warning: 'Showing the first 200 refs; enter another ref manually.' } : { options };
}

async function localFiles(mode, cwd) {
  const options = [], directories = [''];
  let visited = 0, entries = 0, inaccessible = false;
  while (directories.length && options.length <= LIMIT && visited < MAX_DIRECTORIES && entries < MAX_ENTRIES) {
    const relative = directories.pop();
    visited++;
    try {
      const dir = await fs.opendir(path.join(cwd, relative));
      for await (const entry of dir) {
        entries++;
        if (entries > MAX_ENTRIES) break;
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const file = path.join(relative, entry.name);
        if (!safePath(file)) continue;
        if (entry.isDirectory()) directories.push(file);
        else if (entry.isFile() && matchesMode(mode, file)) {
          options.push({ value: file, label: file });
          if (options.length > LIMIT) break;
        }
      }
    } catch { inaccessible = true; }
  }
  const warning = inaccessible ? 'Some folders could not be read; enter a path manually.' : undefined;
  return warning ? { options: options.slice(0, LIMIT), warning } : { options: options.slice(0, LIMIT) };
}

async function files(mode, cwd) {
  const result = await run('git', ['ls-files', '-co', '--exclude-standard', '-z'], cwd);
  if (result.error === 'ENOENT') {
    const fallback = await localFiles(mode, cwd);
    return { ...fallback, warning: `Git is not installed; showing nonhidden local files.${fallback.warning ? ` ${fallback.warning}` : ''}` };
  }
  if (result.code !== 0 && !result.truncated) {
    if (/not a git repository/i.test(result.stderr)) return localFiles(mode, cwd);
    return { options: [], warning: 'Could not list Git files. Enter a path manually.' };
  }
  const entries = result.stdout.split('\0');
  if (result.truncated) entries.pop();
  const options = [], seen = new Set();
  let inaccessible = false, scanned = 0;
  for (const file of entries) {
    if (++scanned > MAX_ENTRIES) break;
    if (!safePath(file) || !matchesMode(mode, file) || seen.has(file)) continue;
    seen.add(file);
    try {
      const candidate = path.join(cwd, file);
      const stat = await fs.lstat(candidate);
      if (!stat.isFile()) continue;
      const relative = path.relative(cwd, await fs.realpath(candidate));
      if (!safePath(relative)) continue;
    } catch (error) {
      if (error.code !== 'ENOENT') inaccessible = true;
      continue;
    }
    options.push({ value: file, label: file });
    if (options.length > LIMIT) break;
  }
  const warning = inaccessible ? 'Some files could not be inspected; enter a path manually.' : undefined;
  return warning ? { options: options.slice(0, LIMIT), warning } : { options: options.slice(0, LIMIT) };
}

async function changes(mode, cwd) {
  const isPR = mode === 'pr';
  const executable = isPR ? 'gh' : 'glab';
  const kind = isPR ? 'pull request' : 'merge request';
  const missing = `${isPR ? 'GitHub CLI (gh)' : 'GitLab CLI (glab)'} is not installed. Install and authenticate it to review ${kind}s.`;
  const failed = `Could not load ${kind}s. Check the CLI authentication and repository.`;
  let args;
  if (isPR) {
    args = ['pr', 'list', '--state', 'open', '--limit', String(LIMIT), '--json', 'number,title,headRefName,url'];
  } else {
    const help = await run('glab', ['mr', 'list', '--help'], cwd, 256 * 1024);
    if (help.error === 'ENOENT') return { options: [], warning: missing };
    if (help.code !== 0 || help.truncated) return { options: [], warning: failed };
    const text = `${help.stdout}\n${help.stderr}`;
    if (!/--output[^\r\n]*\bjson\b/i.test(text)) {
      return { options: [], warning: 'This glab version does not advertise JSON output. Enter a merge request number or URL manually.' };
    }
    args = ['mr', 'list', '--output', 'json'];
    if (/--per-page\b/.test(text)) args.push('--per-page', '100');
  }
  const result = await run(executable, args, cwd);
  if (result.error === 'ENOENT') return { options: [], warning: missing };
  if (result.code !== 0 || result.truncated) return { options: [], warning: failed };
  let items;
  try { items = JSON.parse(result.stdout); } catch { return { options: [], warning: failed }; }
  if (!Array.isArray(items)) return { options: [], warning: failed };
  const options = [], seen = new Set();
  for (const item of items) {
    const number = isPR ? item?.number : item?.iid;
    if (!Number.isSafeInteger(number) || number <= 0 || seen.has(number)) continue;
    seen.add(number);
    const title = cleanText(item.title);
    const detail = cleanText(isPR ? item.headRefName : item.source_branch);
    const value = String(number);
    const label = `${isPR ? '#' : '!'}${value}${title ? ` ${title}` : ''}`;
    options.push(detail ? { value, label, detail } : { value, label });
    if (options.length === LIMIT) break;
  }
  return { options };
}

export async function candidates(request) {
  if (!request || typeof request !== 'object' || !MODES.has(request.mode)) return { options: [], warning: 'Select a valid review mode.' };
  if (typeof request.cwd !== 'string' || !path.isAbsolute(request.cwd)) return { options: [], warning: 'Choose an absolute local working directory.' };
  let cwd;
  try {
    cwd = await fs.realpath(request.cwd);
    if (!(await fs.stat(cwd)).isDirectory()) throw new Error();
  } catch { return { options: [], warning: 'The local working directory does not exist or cannot be read.' }; }
  if (request.mode === 'live') return { options: [] };
  if (request.mode === 'git' || request.mode === 'range') return refs(request.mode, cwd);
  if (['files', 'plan', 'preview'].includes(request.mode)) return files(request.mode, cwd);
  return changes(request.mode, cwd);
}
