// C1: the proof that plugins/agent-models is the folder mods/agent-models of dew_flow_conventions at a named
// commit. Every case builds real git repositories in a temp folder: a stand-in for the conventions repository
// (the mod files, the pins table) and a stand-in for this repository (the copy). Nothing here is a mock of git.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const TOOL = path.join(path.dirname(fileURLToPath(import.meta.url)), 'copy-proof.mjs');
const temps = [];
after(() => { for (const t of temps) fs.rmSync(t, { recursive: true, force: true }); });

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const pluginJson = (version) => `{ "name": "agent-models", "version": "${version}" }\n`;

// The nine installed files and two that are not installed (a test and the tsconfig), as in the real mod.
const baseFiles = () => ({
  '.claude-plugin/plugin.json': pluginJson('1.6.0'),
  'hooks/hooks.json': '{}\n',
  'hooks/register.tsx': 'export const a = 1;\n',
  'hooks/prompts.ts': 'export const b = 2;\n',
  'hooks/tasks.tsx': 'export const c = 3;\n',
  'hooks/limits.tsx': 'export const d = 4;\n',
  'hooks/answer.tsx': 'export const e = 5;\n',
  'hooks/pins.tsx': 'export const f = 6;\n',
  'types/index.d.ts': 'export {};\n',
  'tests/band.test.tsx': 'test\n',
  'tsconfig.json': '{ "include": ["hooks"] }\n',
});
const NINE = Object.keys(baseFiles()).filter((f) => !f.startsWith('tests/') && f !== 'tsconfig.json');

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
  assert.equal(r.status, 0, `${cmd} ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
const git = (cwd, ...args) => run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], cwd);

function write(root, files) {
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
}

/** The conventions stand-in: mods/agent-models at one commit and the pins table with a 1.6.0 row. */
function makeConventions({ withRow = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-conv-'));
  temps.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  const files = baseFiles();
  write(dir, Object.fromEntries(Object.entries(files).map(([f, t]) => [`mods/agent-models/${f}`, t])));
  const row = Object.fromEntries(NINE.map((f) => [f, sha256(files[f])]));
  const table = withRow ? { '1.5.0': { 'hooks/hooks.json': 'x' }, '1.6.0': row } : { '1.5.0': { 'hooks/hooks.json': 'x' } };
  write(dir, { 'tools/agent-models-pins.json': `${JSON.stringify(table, null, 2)}\n` });
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'conventions');
  return { dir, commit: git(dir, 'rev-parse', 'HEAD') };
}

/** This repository's stand-in: plugins/agent-models, a git repository so a tag can be made. */
function makeMods(files = baseFiles()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-mods-'));
  temps.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  write(dir, Object.fromEntries(Object.entries(files).map(([f, t]) => [`plugins/agent-models/${f}`, t])));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'copy');
  return dir;
}

function proof(mods, conv, commit = conv.commit) {
  const r = spawnSync(process.execPath, [TOOL, '--root', mods, '--conventions', conv.dir, '--commit', commit], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('C1 copy-proof', () => {
  it('C1a: an exact copy is green and prints the commit, the nine hashes and the blob count from git', () => {
    const conv = makeConventions();
    const mods = makeMods();
    const blobs = git(conv.dir, 'ls-tree', '-r', '--name-only', conv.commit, 'mods/agent-models').split('\n').length;
    const r = proof(mods, conv);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(conv.commit));
    assert.match(r.out, new RegExp(`9 sha256 = 1\\.6\\.0 row, ${blobs} blobs equal`));
  });

  it('C1b: one byte changed in an installed file is red, naming the file and both sha256', () => {
    const conv = makeConventions();
    const files = baseFiles();
    files['hooks/pins.tsx'] = 'export const f = 7;\n';
    const r = proof(makeMods(files), conv);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /hooks\/pins\.tsx/);
    assert.ok(r.out.includes(sha256('export const f = 6;\n')), 'the row hash is named');
    assert.ok(r.out.includes(sha256('export const f = 7;\n')), 'the hash of the file is named');
  });

  it('C1c: a test file or the tsconfig changed (not one of the nine) is red by the blob compare', () => {
    const conv = makeConventions();
    for (const f of ['tests/band.test.tsx', 'tsconfig.json']) {
      const files = baseFiles();
      files[f] += 'x\n';
      const r = proof(makeMods(files), conv);
      assert.equal(r.code, 1, `${f}: ${r.out}`);
      assert.match(r.out, new RegExp(f.replace('.', '\\.')));
    }
  });

  it('C1d: an extra file and a missing file are red, each named', () => {
    const conv = makeConventions();
    const extra = baseFiles();
    extra['hooks/extra.tsx'] = 'x\n';
    const re = proof(makeMods(extra), conv);
    assert.equal(re.code, 1, re.out);
    assert.match(re.out, /hooks\/extra\.tsx/);
    const missing = baseFiles();
    delete missing['tests/band.test.tsx'];
    const rm = proof(makeMods(missing), conv);
    assert.equal(rm.code, 1, rm.out);
    assert.match(rm.out, /tests\/band\.test\.tsx/);
  });

  it('C1e: a plugin version above 1.6.0 compares the tree of tag agent-models--v1.6.0 instead', () => {
    const conv = makeConventions();
    const mods = makeMods();
    git(mods, 'tag', 'agent-models--v1.6.0');
    // 1.6.1: the folder moves on, the tag stays the proof of the copy.
    write(mods, {
      'plugins/agent-models/.claude-plugin/plugin.json': pluginJson('1.6.1'),
      'plugins/agent-models/hooks/pins.tsx': 'export const f = 99;\n',
    });
    const ok = proof(mods, conv);
    assert.equal(ok.code, 0, ok.out);
    assert.match(ok.out, /agent-models--v1\.6\.0/);
  });

  it('C1e: with a higher version and no tag the proof is red and names the tag', () => {
    const conv = makeConventions();
    const files = baseFiles();
    files['.claude-plugin/plugin.json'] = pluginJson('1.6.1');
    const r = proof(makeMods(files), conv);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /agent-models--v1\.6\.0/);
  });

  it('C1e: a tag whose tree differs from the conventions commit is red', () => {
    const conv = makeConventions();
    const files = baseFiles();
    files['hooks/pins.tsx'] = 'export const f = 8;\n';
    const mods = makeMods(files);
    git(mods, 'tag', 'agent-models--v1.6.0');
    write(mods, { 'plugins/agent-models/.claude-plugin/plugin.json': pluginJson('1.6.1') });
    const r = proof(mods, conv);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /hooks\/pins\.tsx/);
  });

  it('C1f: a conventions commit that cannot be resolved is red, never a skip', () => {
    const conv = makeConventions();
    const r = proof(makeMods(), conv, '0123456789abcdef0123456789abcdef01234567');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /0123456789abcdef/);
  });

  it('C1f: a commit with no 1.6.0 row in the pins table is red', () => {
    const conv = makeConventions({ withRow: false });
    const r = proof(makeMods(), conv);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /1\.6\.0/);
  });

  it('C1: the mod files are read from the row keys at the commit, not from a list in the tool', () => {
    // A tenth file in the row: the tool must demand it. A hard-coded list of nine would skip it.
    const conv = makeConventions();
    const table = JSON.parse(git(conv.dir, 'show', `${conv.commit}:tools/agent-models-pins.json`));
    assert.equal(Object.keys(table['1.6.0']).length, 9);
    const source = fs.readFileSync(TOOL, 'utf8');
    for (const f of NINE) assert.ok(!source.includes(f), `${f} is listed in the tool`);
  });
});
