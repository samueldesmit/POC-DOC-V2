import path from 'node:path';

export const WORKFLOW = '.github/workflows/review-pr.yml';
export const CHECK_NAME = 'Release Desk';
export const ROLES = ['security', 'correctness', 'maintainability'];

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHOP_PATTERN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const BRANCH_PATTERN = /^[A-Za-z0-9._/-]{1,100}$/;

// One deployment serves exactly one store and one repository. Both are fixed at
// boot from the environment; nothing in a request can change them.
export function configuration(env = process.env) {
  const reviewers = new Set((env.SHOPIFY_REVIEWER_IDS || '').split(',').map(v => v.trim()).filter(v => /^\d+$/.test(v)));
  const repository = REPOSITORY_PATTERN.test(env.GITHUB_REPOSITORY || '') ? env.GITHUB_REPOSITORY : '';
  const shop = SHOP_PATTERN.test(env.SHOP_DOMAIN || '') ? env.SHOP_DOMAIN : '';
  const stagingBranch = BRANCH_PATTERN.test(env.STAGING_BRANCH || '') ? env.STAGING_BRANCH : 'staging';
  const liveBranch = BRANCH_PATTERN.test(env.LIVE_BRANCH || '') ? env.LIVE_BRANCH : 'main';
  return {
    apiKey: env.SHOPIFY_API_KEY || '', apiSecret: env.SHOPIFY_API_SECRET || '',
    shop, repository, reviewers, stagingBranch, liveBranch,
    githubAppId: env.GITHUB_APP_ID || '', githubPrivateKey: (env.GITHUB_APP_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    githubInstallationId: env.GITHUB_INSTALLATION_ID || '',
    githubToken: env.NODE_ENV === 'development' && env.ALLOW_DEV_GITHUB_TOKEN === 'true' ? env.GITHUB_TOKEN || '' : '',
    webhookSecret: env.GITHUB_WEBHOOK_SECRET || '', anthropicKey: env.ANTHROPIC_API_KEY || '',
    reviewMode: env.CLAUDE_REVIEW_MODE || 'live',
    anthropicModel: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
    dataDir: path.resolve(env.DATA_DIR || './.data'), port: Number(env.PORT || 3000),
    publicUrl: env.APP_URL || '', production: env.NODE_ENV === 'production',
    maxActiveRuns: 2, maxRunsPerHour: 10, maxRunMs: 20 * 60_000, pollMs: 8_000,
    previewThemeToken: env.SHOPIFY_THEME_TOKEN || '',
    previewCliPath: env.SHOPIFY_CLI_PATH || '', maxPreviewsPerHour: 10, maxPreviewMs: 15 * 60_000,
    maxDiffBytes: 200_000, maxFiles: 80, expectedJobs: ['review-checks', 'theme-check'],
  };
}

// The two release steps: a change goes into staging, and staging goes live.
export function releaseTargets(config) { return [config.stagingBranch, config.liveBranch]; }
export function stageOf(config, baseRef) { return baseRef === config.liveBranch ? 'live' : baseRef === config.stagingBranch ? 'staging' : null; }

export function setupBlockers(config) {
  const blockers = [];
  const add = (code, message) => blockers.push({ code, message });
  if (!config.shop) add('SHOP_MISSING', 'SHOP_DOMAIN must be the store\'s myshopify.com domain.');
  if (!config.repository) add('REPOSITORY_MISSING', 'GITHUB_REPOSITORY must be set as owner/name.');
  if (config.stagingBranch === config.liveBranch) add('BRANCHES_INVALID', 'STAGING_BRANCH and LIVE_BRANCH must differ.');
  if (!config.apiKey || !config.apiSecret) add('SHOPIFY_AUTH_MISSING', 'Shopify app credentials are not configured.');
  if (!config.reviewers.size) add('REVIEWERS_MISSING', 'No Shopify reviewers are authorized. Configure SHOPIFY_REVIEWER_IDS explicitly.');
  if (!(config.githubAppId && config.githubPrivateKey && config.githubInstallationId) && !config.githubToken) add('GITHUB_AUTH_MISSING', 'GitHub App installation credentials are not configured.');
  if (!config.webhookSecret) add('WEBHOOK_SECRET_MISSING', 'The GitHub webhook signing secret is not configured.');
  if (!['live', 'demo'].includes(config.reviewMode)) add('REVIEW_MODE_INVALID', 'CLAUDE_REVIEW_MODE must be live or demo.');
  if (config.reviewMode !== 'demo' && !config.anthropicKey) add('ANTHROPIC_KEY_MISSING', 'Claude review credentials are not configured.');
  return blockers;
}
