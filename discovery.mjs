import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import * as fs from 'node:fs';
import * as net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { critProcessIdentity, matchesCritProcess, readCritSession } from './lifecycle.mjs';

const sessionPattern = /^[0-9a-f]{12}$/;

export function externalId(sessionId, generation) {
  const suffix = createHash('sha256').update(`${generation.pid}\0${generation.started_at}`).digest('hex').slice(0, 12);
  return `external-${sessionId}-${suffix}`;
}

function cleanURL(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return '';
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    return url.toString();
  } catch { return ''; }
}

function cleanText(value) {
  return String(value || '').replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/https?:\/\/[^\s<>"']+/gi, text => cleanURL(text) || '[URL]')
    .replace(/\b(token|secret|password|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim().slice(0, 2000);
}

function date(value, fallback) {
  if (typeof value !== 'string' || !value) return fallback;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : fallback;
}

function matchesReviewPath(reviewPath, sessionId) {
  if (typeof reviewPath !== 'string' || !path.isAbsolute(reviewPath) || reviewPath.includes('\0')) return false;
  const identity = path.normalize(reviewPath);
  if (path.basename(identity) === sessionId && path.basename(path.dirname(identity)) === 'reviews') return true;
  const plans = path.join(os.homedir(), '.crit', 'plans');
  return path.basename(identity) === '.crit' && path.dirname(path.dirname(identity)) === plans;
}

function reviewMetadata(entry, sessionId) {
  if (!matchesReviewPath(entry.review_path, sessionId)) return null;
  try {
    // Only retain metadata from this one read, never comments, tokens, or review text.
    const json = JSON.parse(fs.readFileSync(path.join(entry.review_path, 'review.json'), 'utf8'));
    return {
      args: Array.isArray(json.cli_args) ? json.cli_args.filter(arg => typeof arg === 'string') : [],
      type: typeof json.review_type === 'string' ? json.review_type : '',
      origin: typeof json.origin === 'string' ? json.origin : '',
      story: Boolean(json.story && typeof json.story === 'object' && !Array.isArray(json.story)),
      updatedAt: json.updated_at,
    };
  } catch { return null; }
}

function scopeFromArgs(args) {
  if (args.length === 1) {
    const match = args[0].match(/^(pr|mr|range):(.+)$/s);
    if (match) return { mode: match[1], target: cleanText(match[2]) };
    const flag = args[0].match(/^--(pr|mr|range)=(.+)$/s);
    if (flag) return { mode: flag[1], target: cleanText(flag[2]) };
  }
  if (args.length === 2 && /^--(pr|mr|range)$/.test(args[0])) {
    return { mode: args[0].slice(2), target: cleanText(args[1]) };
  }
  return null;
}

function reviewScope(entry, sessionId, metadata) {
  const args = Array.isArray(entry.args) ? entry.args.filter(arg => typeof arg === 'string') : [];
  if (args.length >= 2 && args[0] === 'live') return { mode: 'live', target: cleanURL(args[1]) };
  if (args.length >= 2 && args[0] === 'preview') return { mode: 'preview', target: cleanText(args[1]) };
  if (metadata && ['live', 'preview'].includes(metadata.type)) {
    return { mode: metadata.type, target: metadata.type === 'live' ? cleanURL(metadata.origin) : cleanText(metadata.origin) };
  }
  const identity = typeof entry.review_path === 'string' ? path.normalize(entry.review_path) : '';
  const plans = path.join(os.homedir(), '.crit', 'plans');
  if (path.basename(identity) === '.crit' && path.dirname(path.dirname(identity)) === plans) {
    return { mode: 'plan', target: cleanText(path.basename(path.dirname(identity))) };
  }
  if (args.length) return { mode: 'files', target: args.map(cleanText).filter(Boolean).join('\n') };
  const scope = metadata && scopeFromArgs(metadata.args);
  if (scope) return scope;
  // With no file args, Git's registry key hashes cwd and current branch. Crit
  // does not store PR/MR/range focus flags in its 0.23.2 registry entries.
  const branch = typeof entry.branch === 'string' ? entry.branch : '';
  const gitKey = createHash('sha256').update(`${entry.cwd}\0${branch}`).digest('hex').slice(0, 12);
  return gitKey === sessionId ? { mode: 'git', target: '' } : { mode: 'review', target: '' };
}

async function localHost(host) {
  const name = typeof host === 'string' ? host.replace(/^\[|\]$/g, '') : '';
  if (!name || name === '127.0.0.1' || name === '0.0.0.0') return '127.0.0.1';
  if (name === '::' || name === '::1') return '::1';
  const addresses = new Set(Object.values(os.networkInterfaces()).flat().filter(Boolean).map(item => item.address));
  if (net.isIP(name)) return addresses.has(name) ? name : null;
  try {
    const matches = await lookup(name, { all: true });
    return matches.find(item => addresses.has(item.address))?.address || null;
  } catch { return null; }
}

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

function portIsOpen(host, port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port });
    let finished = false;
    const finish = result => {
      if (finished) return;
      finished = true;
      socket.destroy();
      resolve(result);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(1000, () => finish(false));
  });
}

function reviewURL(entry, host, mode, story) {
  let url;
  try {
    url = new URL(entry.public_url);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) url = null;
  } catch { url = null; }
  if (!url) url = new URL(`http://${net.isIP(host) === 6 ? `[${host}]` : host}:${entry.port}`);
  const suffix = mode === 'live' ? '/live' : mode === 'preview' ? '/preview' : '';
  if (suffix && !url.pathname.endsWith(suffix)) url.pathname = url.pathname.replace(/\/$/, '') + suffix;
  if (story) url.hash = 'story';
  return url.toString();
}

async function readSession(directory, name) {
  const sessionId = name.slice(0, -5);
  if (!sessionPattern.test(sessionId)) return null;
  const file = path.join(directory, name);
  try {
    const entry = readCritSession(sessionId);
    if (!entry || !processExists(entry.pid)) return null;
    const host = await localHost(entry.host);
    if (!host || !await portIsOpen(host, entry.port)) return null;
    const identity = critProcessIdentity(entry.pid);
    const current = readCritSession(sessionId);
    if (!matchesCritProcess(entry, identity) || !current || current.pid !== entry.pid ||
        current.started_at !== entry.started_at || current.port !== entry.port ||
        current.host !== entry.host || current.public_url !== entry.public_url) return null;
    const generation = { pid: entry.pid, started_at: entry.started_at, process_started: identity.started };
    const metadata = reviewMetadata(entry, sessionId);
    const { mode, target } = reviewScope(entry, sessionId, metadata);
    const createdAt = date(entry.started_at, fs.statSync(file).mtime.toISOString());
    const updatedAt = date(metadata?.updatedAt, createdAt);
    const story = metadata?.story || false;
    return {
      id: externalId(sessionId, generation), source: 'external', mode, story, target, cwd: cleanText(entry.cwd),
      machine: null, phase: 'external', url: reviewURL(entry, host, mode, story), sessionId,
      agentAddress: null, createdAt, updatedAt,
      _sessionGeneration: generation,
    };
  } catch { return null; }
}

export async function discover() {
  const directory = path.join(os.homedir(), '.crit', 'sessions');
  let names;
  try { names = fs.readdirSync(directory); }
  catch (error) { if (error.code === 'ENOENT') return { reviews: [] }; throw error; }
  const reviews = (await Promise.all(names.filter(name => /^[0-9a-f]{12}\.json$/.test(name))
    .map(name => readSession(directory, name)))).filter(Boolean);
  reviews.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { reviews };
}
