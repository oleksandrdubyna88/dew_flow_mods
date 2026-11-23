// Y1-Y4: the structure of EVERY workflow file, parsed (the `yaml` devDependency), with no typed list of files: a new
// workflow is judged by the same rules the day it is added. The release gate's refusals are in promote-release.test.mjs;
// what only the structure can promise is here: who can write, where the deploy key is, which text reaches a shell.
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
    assert.equal(push.if, "github.ref == 'refs/heads/main'");
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
