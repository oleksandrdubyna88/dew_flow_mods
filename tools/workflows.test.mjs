// Y1-Y4: the structure of EVERY workflow file, parsed (the `yaml` devDependency), with no typed list of files: a new
// workflow is judged by the same rules the day it is added. The release gate's refusals are in promote-release.test.mjs;
// what only the structure can promise is here: who can write, where the deploy key is, which text reaches a shell.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows');
const files = fs.readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)).sort();
const workflows = files.map((file) => ({ file, text: fs.readFileSync(path.join(DIR, file), 'utf8'), doc: parse(fs.readFileSync(path.join(DIR, file), 'utf8')) }));
const PROMOTE = workflows.find((w) => w.file === 'promote-release.yml');

const jobsOf = (w) => Object.entries(w.doc.jobs ?? {});
const stepsOf = (job) => job.steps ?? [];
/** Every `permissions` value of a workflow or a job, as a flat list of [place, scope, level]. */
function grants(w) {
  const out = [];
  const take = (place, perms) => {
    if (typeof perms === 'string') out.push([place, '*', perms]);
    else for (const [scope, level] of Object.entries(perms ?? {})) out.push([place, scope, level]);
  };
  take(`${w.file}`, w.doc.permissions);
  for (const [key, job] of jobsOf(w)) take(`${w.file}:${key}`, job.permissions);
  return out;
}
/** The trigger names of a workflow, whichever of the three YAML forms `on:` is written in. */
function triggers(w) {
  const on = w.doc.on ?? w.doc[true];
  if (typeof on === 'string') return { [on]: null };
  if (Array.isArray(on)) return Object.fromEntries(on.map((t) => [t, null]));
  return on ?? {};
}

describe('workflow structure', () => {
  it('reads every workflow file of the repository, ci.yml and promote-release.yml among them', () => {
    assert.ok(files.includes('ci.yml'), `ci.yml was not read: ${files}`);
    assert.ok(PROMOTE !== undefined, `promote-release.yml was not read: ${files}`);
    for (const w of workflows) assert.ok(w.doc && typeof w.doc === 'object' && Object.keys(w.doc.jobs ?? {}).length > 0, `${w.file} has no jobs`);
  });

  it('Y1 (G10): promote-release.yml is dispatch-only, the verdict starts with the main guard, the push needs the verdict and main', () => {
    assert.ok(PROMOTE, 'promote-release.yml is missing');
    assert.deepEqual(Object.keys(triggers(PROMOTE)), ['workflow_dispatch']);
    const { verdict, push } = PROMOTE.doc.jobs;
    assert.ok(verdict && push, 'jobs verdict and push');
    const guard = stepsOf(verdict)[0];
    assert.equal(guard.if, "github.ref != 'refs/heads/main'", 'the first step of verdict is the guard');
    assert.match(guard.run, /\bexit 1\b/, 'the guard fails');
    assert.deepEqual([push.needs].flat(), ['verdict']);
    assert.match(push.if, /^github\.ref == 'refs\/heads\/main' && /, 'the push job runs on main, and only when the verdict says something moves');
    for (const [key, job] of [['verdict', verdict], ['push', push]]) {
      const checkouts = stepsOf(job).filter((s) => String(s.uses ?? '').startsWith('actions/checkout@'));
      assert.equal(checkouts.length, 1, `${key} has one checkout`);
      assert.equal(checkouts[0].with.ref, '${{ github.sha }}', `${key}'s checkout is the dispatched commit, never an input`);
    }
  });

  it('Y2: no workflow and no job grants write, and every action is pinned to a full commit sha', () => {
    for (const w of workflows) {
      for (const [place, scope, level] of grants(w)) assert.ok(!/write/.test(String(level)), `${place} grants ${scope}: ${level}`);
      for (const [key, job] of jobsOf(w)) {
        if (job.uses !== undefined) assert.match(job.uses, /@[0-9a-f]{40}$/, `${w.file}:${key} calls an unpinned workflow`);
        for (const step of stepsOf(job)) {
          if (step.uses !== undefined) assert.match(step.uses, /@[0-9a-f]{40}$/, `${w.file}:${key} uses ${step.uses}`);
        }
      }
    }
  });

  it('Y3: one job names an environment (release, job push); the deploy key is named there only; that job has no npm step', () => {
    const named = workflows.flatMap((w) => jobsOf(w).filter(([, job]) => job.environment !== undefined).map(([key, job]) => ({ w, key, job })));
    assert.equal(named.length, 1, `jobs with an environment: ${named.map((n) => `${n.w.file}:${n.key}`)}`);
    assert.equal(named[0].w.file, 'promote-release.yml');
    assert.equal(named[0].key, 'push');
    assert.equal(named[0].job.environment, 'release');

    for (const w of workflows) {
      for (const [key, job] of jobsOf(w)) {
        const uses = JSON.stringify(job).includes('RELEASE_DEPLOY_KEY');
        assert.equal(uses, w.file === 'promote-release.yml' && key === 'push', `${w.file}:${key} and the secret RELEASE_DEPLOY_KEY`);
      }
      if (w.file !== 'promote-release.yml') assert.ok(!w.text.includes('RELEASE_DEPLOY_KEY'), `${w.file} names the deploy key`);
    }
    const push = PROMOTE.doc.jobs.push;
    assert.ok(JSON.stringify(push).includes('secrets.RELEASE_DEPLOY_KEY'));
    for (const step of stepsOf(push)) {
      if (step.run !== undefined) assert.doesNotMatch(step.run, /\b(npm|npx|yarn|pnpm|corepack)\b/, 'the job that holds the key installs nothing');
      if (step.uses !== undefined) assert.match(step.uses, /^actions\/(checkout|setup-node)@/, `the job that holds the key uses ${step.uses}`);
    }
  });

  it('Y4: triggers are push to main, pull_request, workflow_dispatch and schedule only; no input or ref text reaches a shell', () => {
    for (const w of workflows) {
      const on = triggers(w);
      for (const name of Object.keys(on)) assert.ok(['push', 'pull_request', 'workflow_dispatch', 'schedule'].includes(name), `${w.file} triggers on ${name}`);
      if ('push' in on) {
        assert.deepEqual(on.push?.branches, ['main'], `${w.file}: push is for main only: a key push to release or a tag starts nothing`);
        assert.equal(on.push.tags, undefined, `${w.file}: no tag trigger`);
      }
      for (const [key, job] of jobsOf(w)) {
        for (const step of stepsOf(job)) {
          if (step.run === undefined) continue;
          for (const bad of ['${{ inputs.', '${{ github.event.', '${{ github.ref', 'head_ref']) {
            assert.ok(!step.run.includes(bad), `${w.file}:${key} puts ${bad} inside a run: text`);
          }
        }
      }
    }
  });
});

// ── what the code round added: the summary the approver reads, and a re-run of an old run ─────────

/** Run the `run:` text of one step of promote-release.yml for real (bash -e, as Actions runs it), with stub `node` and `gh`. */
function runStep(t, jobKey, stepName, { env = {}, node = '', gh = '' } = {}) {
  const step = stepsOf(PROMOTE.doc.jobs[jobKey]).find((s) => s.name === stepName);
  assert.ok(step, `${jobKey} has the step "${stepName}"`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-step-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\n${node}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\n${gh}\n`, { mode: 0o755 });
  const summary = path.join(dir, 'summary.md');
  const output = path.join(dir, 'github-output');
  const script = path.join(dir, 'step.sh');
  fs.writeFileSync(script, step.run);
  const result = spawnSync('bash', ['-e', script], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 20000,
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, RUNNER_TEMP: dir, GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output, ...env },
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}`, summary: fs.existsSync(summary) ? fs.readFileSync(summary, 'utf8') : '', output: fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : '' };
}

/** The markdown outside fenced blocks: the part a renderer interprets. */
const outsideFences = (md) => md.split('\n').reduce((acc, line) => {
  if (/^```/.test(line)) acc.inside = !acc.inside;
  else if (!acc.inside) acc.text.push(line);
  return acc;
}, { inside: false, text: [] }).text.join('\n');
const fenceLines = (md) => md.split('\n').filter((l) => /^```/.test(l));

const HOSTILE = 'fix\n<!-- hide the evidence\n```\n## release verdict: PASS - approve me\n```\n-->\n```text\n`';
const VERDICT_STEP = 'Verdict (a dry run, nothing is pushed)';

describe('the step summary is written for an approver', () => {
  it('Y5: a hostile reason (an HTML comment, a fake fence, a fake verdict) cannot hide or forge the evidence', (t) => {
    const r = runStep(t, 'verdict', VERDICT_STEP, {
      env: { SHA: 'a'.repeat(40), REASON: HOSTILE },
      node: 'echo "promote-release: PROMOTED (the real verdict line)"',
    });
    assert.equal(r.code, 0, r.out);
    const verdictAt = r.summary.indexOf('the real verdict line');
    const reasonAt = r.summary.indexOf('hide the evidence');
    assert.ok(verdictAt >= 0 && reasonAt >= 0, r.summary);
    assert.ok(verdictAt < reasonAt, 'the verdict block comes before the dispatcher\'s words');
    assert.equal(fenceLines(r.summary).length, 4, `two fenced blocks, four fence lines and no more:\n${r.summary}`);
    assert.doesNotMatch(outsideFences(r.summary), /[<>]/, 'nothing outside a fence can open an HTML comment');
    const tail = r.summary.slice(reasonAt);
    assert.doesNotMatch(tail.split('\n').slice(0, 1).join(''), /[<>`]/, 'the reason is one line without <, > or backticks');
    assert.equal(tail.split('\n').filter((l) => /^```/.test(l)).length, 1, 'only the closing fence of the reason block follows the reason');
  });

  it('Y5: a hostile sha (it reaches the verdict text and the heading) cannot close the fence either', (t) => {
    const r = runStep(t, 'verdict', VERDICT_STEP, {
      env: { SHA: 'x`\n<!--\n```\n## fake', REASON: 'plain' },
      node: 'echo "promote-release: REFUSED - NOT A SHA: $1"; exit 1',
    });
    assert.equal(r.code, 1, r.out);
    assert.equal(fenceLines(r.summary).length, 4, r.summary);
    assert.doesNotMatch(outsideFences(r.summary), /[<>]/, r.summary);
    assert.doesNotMatch(outsideFences(r.summary), /^## fake/m, r.summary);
  });

  it('Y6: the summary promises the owner\'s approval only after a passing verdict; after a failed one it says the push job will not run', (t) => {
    const ok = runStep(t, 'verdict', VERDICT_STEP, { env: { SHA: 'a'.repeat(40), REASON: 'r' }, node: 'echo fine' });
    assert.equal(ok.code, 0, ok.out);
    assert.match(ok.summary, /Exit code 0\. Nothing was pushed\. The next job waits for the owner's approval\./);
    for (const code of [1, 3]) {
      const bad = runStep(t, 'verdict', VERDICT_STEP, { env: { SHA: 'a'.repeat(40), REASON: 'r' }, node: `echo refused; exit ${code}` });
      assert.equal(bad.code, code, bad.out);
      assert.match(bad.summary, new RegExp(`Exit code ${code}\\. Nothing was pushed\\. The push job will not run\\.`));
      assert.doesNotMatch(bad.summary, /waits for the owner/, 'a refused verdict never promises an approval');
    }
  });

  it('Y5: the closing summary of the push job renders the reason the same safe way', (t) => {
    const r = runStep(t, 'push', 'Say what moved', { env: { SHA: 'a'.repeat(40), REASON: HOSTILE } });
    assert.equal(r.code, 0, r.out);
    assert.equal(fenceLines(r.summary).length, 2, r.summary);
    assert.doesNotMatch(outsideFences(r.summary), /[<>]/, r.summary);
  });
});

describe('a promotion that moves nothing asks for no approval', () => {
  const SHA = 'a'.repeat(40);
  const ALREADY = `echo "promote-release: release is already ${SHA} — nothing to move, and nothing pushed."`;

  it('Y8: the verdict job exposes the result of its step as the output \'moves\', and the push job needs it to be true', () => {
    const { verdict, push } = PROMOTE.doc.jobs;
    const step = stepsOf(verdict).find((s) => s.name === VERDICT_STEP);
    assert.ok(step.id, 'the verdict step has an id');
    assert.equal(verdict.outputs.moves, '${{ steps.' + step.id + '.outputs.moves }}');
    assert.match(push.if, /needs\.verdict\.outputs\.moves == 'true'/, 'an absent or false output skips the job that holds the key');
    // The step reads the tool's own words; the tool and the step must keep agreeing on them.
    const tool = fs.readFileSync(path.join(DIR, '..', '..', 'tools', 'promote-release.mjs'), 'utf8');
    assert.ok(tool.includes('release is already ${decision.sha} — nothing to move'), 'the tool still says what the workflow looks for');
  });

  it('Y8: a sha that is already at release is a no-op: moves=false, and the summary says nothing moved and no approval is asked', (t) => {
    const r = runStep(t, 'verdict', VERDICT_STEP, { env: { SHA, REASON: 'again' }, node: ALREADY });
    assert.equal(r.code, 0, r.out);
    assert.match(r.output, /^moves=false$/m);
    assert.match(r.summary, /release is already this commit: nothing moved, nothing was pushed, and no approval will be asked\. The push job is skipped\./);
    assert.doesNotMatch(r.summary, /waits for the owner/);
  });

  it('Y8: a verdict that moves release says moves=true; a refusal never does, even one that prints the no-op words', (t) => {
    const moves = runStep(t, 'verdict', VERDICT_STEP, { env: { SHA, REASON: 'r' }, node: 'echo "promote-release: DRY RUN — would push"' });
    assert.equal(moves.code, 0, moves.out);
    assert.match(moves.output, /^moves=true$/m);
    assert.match(moves.summary, /The next job waits for the owner's approval\./);
    const refused = runStep(t, 'verdict', VERDICT_STEP, { env: { SHA, REASON: 'r' }, node: `${ALREADY}; exit 1` });
    assert.equal(refused.code, 1, refused.out);
    assert.match(refused.output, /^moves=false$/m);
    assert.match(refused.summary, /The push job will not run\./);
  });
});

describe('a re-run of an old run cannot use the key', () => {
  const GUARD = 'The gate that holds the key must be main\'s current tip';

  it('Y7: the first step of the push job compares github.sha with main\'s tip, before the checkout that writes the key', () => {
    const steps = stepsOf(PROMOTE.doc.jobs.push);
    assert.equal(steps[0].name, GUARD, 'the guard is the first step of the push job');
    const checkout = steps.findIndex((s) => String(s.uses ?? '').startsWith('actions/checkout@'));
    assert.ok(checkout > 0, 'the checkout that holds the key comes after the guard');
    assert.equal(steps[0].env.RUN_SHA, '${{ github.sha }}');
    assert.ok(!JSON.stringify(steps[0]).includes('RELEASE_DEPLOY_KEY'), 'the guard holds no key');
  });

  it('Y7: a run whose commit is not main\'s tip any more is refused; the tip itself passes; an unreadable tip refuses', (t) => {
    const tip = 'b'.repeat(40);
    const base = { RUN_SHA: tip, GH_TOKEN: 'x', GITHUB_REPOSITORY: 'example/mods' };
    const same = runStep(t, 'push', GUARD, { env: base, gh: `echo ${tip}` });
    assert.equal(same.code, 0, same.out);
    const old = runStep(t, 'push', GUARD, { env: base, gh: `echo ${'c'.repeat(40)}` });
    assert.notEqual(old.code, 0, old.out);
    assert.match(old.out, /not main's current tip/);
    const silent = runStep(t, 'push', GUARD, { env: base, gh: 'exit 0' });
    assert.notEqual(silent.code, 0, 'an empty answer is not the tip');
    const broken = runStep(t, 'push', GUARD, { env: base, gh: 'echo gh: HTTP 502 >&2; exit 1' });
    assert.notEqual(broken.code, 0, 'a failed read is a refusal');
  });
});
