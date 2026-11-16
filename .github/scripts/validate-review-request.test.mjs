import test from 'node:test';
import assert from 'node:assert/strict';
import { requestIdentity, validatePull } from './validate-review-request.mjs';

const head = 'a'.repeat(40), base = 'b'.repeat(40), repository = 'example-org/theme-repo';
const env = { REVIEW_PR: '7', REVIEW_HEAD: head, REVIEW_BASE: base, REVIEW_RUN_ID: '01234567-89ab-cdef-0123-456789abcdef', WORKFLOW_SHA: base, WORKFLOW_REF: 'refs/heads/staging', WORKFLOW_EVENT: 'workflow_dispatch', GITHUB_REPOSITORY: repository };
const pull = { state: 'open', draft: false, merged: false, base: { sha: base, ref: 'staging', repo: { full_name: repository } }, head: { sha: head, ref: 'feature/hero', repo: { full_name: repository } } };

test('dispatch identity pins the release branch, event and base commit before candidate execution', () => {
  assert.equal(requestIdentity(env).baseBranch, 'staging');
  assert.equal(requestIdentity({ ...env, WORKFLOW_REF: 'refs/heads/main' }).baseBranch, 'main');
  for (const changes of [{ REVIEW_PR: '7; echo injected' }, { REVIEW_HEAD: 'main' }, { REVIEW_RUN_ID: 'bad\nrun-id' }, { WORKFLOW_REF: 'refs/heads/candidate' }, { WORKFLOW_SHA: head }, { WORKFLOW_EVENT: 'pull_request' }, { GITHUB_REPOSITORY: 'bad repo' }, { STAGING_BRANCH: 'main' }]) assert.throws(() => requestIdentity({ ...env, ...changes }));
});

test('PR validation rejects stale commits, forks, drafts and the wrong target', () => {
  validatePull(pull, requestIdentity(env));
  const mutations = [candidate => candidate.state = 'closed', candidate => candidate.draft = true, candidate => candidate.merged = true,
    candidate => candidate.base.ref = 'main', candidate => candidate.head.sha = base, candidate => candidate.base.sha = head,
    candidate => candidate.head.repo.full_name = 'fork/theme-repo', candidate => candidate.base.repo.full_name = 'other/repo'];
  for (const mutate of mutations) { const candidate = structuredClone(pull); mutate(candidate); assert.throws(() => validatePull(candidate, requestIdentity(env))); }
});

test('only staging itself can be released to live', () => {
  const live = requestIdentity({ ...env, WORKFLOW_REF: 'refs/heads/main' });
  validatePull({ ...pull, base: { ...pull.base, ref: 'main' }, head: { ...pull.head, ref: 'staging' } }, live);
  assert.throws(() => validatePull({ ...pull, base: { ...pull.base, ref: 'main' } }, live), /Only staging/);
});
