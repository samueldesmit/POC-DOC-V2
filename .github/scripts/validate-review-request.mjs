import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BRANCH = /^[A-Za-z0-9._/-]{1,100}$/;
export function branches(env) {
  const staging = env.STAGING_BRANCH || 'staging', live = env.LIVE_BRANCH || 'main';
  assert(BRANCH.test(staging) && BRANCH.test(live) && staging !== live, 'Invalid release branch configuration');
  return { staging, live };
}

export function requestIdentity(env) {
  const { REVIEW_PR: pr, REVIEW_HEAD: head, REVIEW_BASE: base, REVIEW_RUN_ID: id, WORKFLOW_SHA: workflow, WORKFLOW_REF: ref, WORKFLOW_EVENT: event, GITHUB_REPOSITORY: repository } = env;
  const { staging, live } = branches(env);
  assert(/^[1-9]\d{0,8}$/.test(pr || ''), 'Invalid PR number');
  assert(/^[a-f0-9]{40}$/.test(head || '') && /^[a-f0-9]{40}$/.test(base || ''), 'Invalid commit');
  assert(/^[a-zA-Z0-9-]{8,100}$/.test(id || ''), 'Invalid review identifier');
  assert(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || ''), 'Invalid workflow repository');
  // The trusted workflow runs from the PR's target branch, at exactly its base commit.
  const baseBranch = [staging, live].find(branch => ref === `refs/heads/${branch}`);
  assert(baseBranch, `Review workflow must be dispatched from ${staging} or ${live}`);
  assert.equal(event, 'workflow_dispatch', 'Only an explicit review dispatch is supported');
  assert.equal(workflow, base, 'The target branch changed before dispatch; restart the review');
  return { pr, head, base, id, baseBranch, repository, staging, live };
}

export function validatePull(pull, { head, base, baseBranch, repository, staging, live }) {
  assert.equal(pull.state, 'open', 'PR is no longer open');
  assert.equal(pull.draft, false, 'Draft PRs cannot be approved');
  assert.equal(pull.merged, false, 'PR has already merged');
  assert.equal(pull.base.ref, baseBranch, 'The PR does not target the branch this review runs from');
  assert(baseBranch !== live || pull.head.ref === staging, `Only ${staging} can be released to ${live}`);
  assert.equal(pull.base.repo.full_name, repository, 'Wrong base repository');
  assert.equal(pull.head.repo.full_name, repository, 'Fork execution is not supported');
  assert.equal(pull.head.sha, head, 'PR changed before the review started');
  assert.equal(pull.base.sha, base, 'The target branch changed before the review started');
}

async function main() {
  const identity = requestIdentity(process.env), token = process.env.GITHUB_TOKEN;
  assert(token, 'GitHub read token missing');
  const response = await fetch(`https://api.github.com/repos/${identity.repository}/pulls/${identity.pr}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(15000), redirect: 'error',
  });
  assert(response.ok, `Could not verify pull request: HTTP ${response.status}`);
  validatePull(await response.json(), identity);
  console.log(`Validated PR ${identity.pr} at ${identity.head}, base ${identity.baseBranch} ${identity.base}, review ${identity.id}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
