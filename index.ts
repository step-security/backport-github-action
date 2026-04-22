import * as fs from 'fs';
import * as core from '@actions/core';
import type { context as ghContext } from '@actions/github';
import axios, { isAxiosError } from 'axios';
import {
  type BackportResponse,
  backportRun,
  getOptionsFromGithub,
} from 'backport';

type GithubContext = typeof ghContext;

type ActionInputs = {
  token: string;
  labelPrefix: string;
  forkOwner: string;
  includeReviewers: boolean;
};

async function validateSubscription() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  let repoPrivate: boolean | undefined;

  if (eventPath && fs.existsSync(eventPath)) {
    const eventData = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
    repoPrivate = eventData?.repository?.private;
  }

  const upstream = 'sorenlouv/backport-github-action';
  const action = process.env.GITHUB_ACTION_REPOSITORY;
  const docsUrl =
    'https://docs.stepsecurity.io/actions/stepsecurity-maintained-actions';

  core.info('');
  core.info('\u001b[1;36mStepSecurity Maintained Action\u001b[0m');
  core.info(`Secure drop-in replacement for ${upstream}`);
  if (repoPrivate === false)
    core.info('\u001b[32m\u2713 Free for public repositories\u001b[0m');
  core.info(`\u001b[36mLearn more:\u001b[0m ${docsUrl}`);
  core.info('');

  if (repoPrivate === false) return;

  const serverUrl = process.env.GITHUB_SERVER_URL || 'https://github.com';
  const body: Record<string, string> = { action: action || '' };
  if (serverUrl !== 'https://github.com') body.ghes_server = serverUrl;
  try {
    await axios.post(
      `https://agent.api.stepsecurity.io/v1/github/${process.env.GITHUB_REPOSITORY}/actions/maintained-actions-subscription`,
      body,
      { timeout: 3000 },
    );
  } catch (error) {
    if (isAxiosError(error) && error.response?.status === 403) {
      core.error(
        `\u001b[1;31mThis action requires a StepSecurity subscription for private repositories.\u001b[0m`,
      );
      core.error(
        `\u001b[31mLearn how to enable a subscription: ${docsUrl}\u001b[0m`,
      );
      process.exit(1);
    }
    core.info('Timeout or API not reachable. Continuing to next step.');
  }
}

function parseHostname(url: string): string {
  return url.replace(/^https{0,1}:\/\//, '');
}

function deriveLabelMapping(
  prefix: string,
): Record<string, string> | undefined {
  if (prefix === '') return undefined;
  return { [`^${prefix}(.+)$`]: '$1' };
}

function collectReviewerLogins(
  pr: Record<string, any>,
  include: boolean,
): string[] {
  const reviewers = pr.requested_reviewers as
    | Array<{ login: string }>
    | undefined;
  if (include && Array.isArray(reviewers)) {
    return reviewers.map((r) => r.login);
  }
  return [];
}

function requirePullRequest(payload: Record<string, any>) {
  const pr = payload.pull_request;
  if (!pr) {
    throw Error('This action requires a pull_request event trigger.');
  }
  return pr;
}

function buildActionConfig(inputs: ActionInputs, ctx: GithubContext) {
  const { payload, repo, runId } = ctx;
  const pr = requirePullRequest(payload);

  return {
    accessToken: inputs.token,
    assignees: [pr.user.login as string],
    branchLabelMapping: deriveLabelMapping(inputs.labelPrefix),
    gitHostname: parseHostname(ctx.serverUrl),
    githubActionRunId: runId,
    githubApiBaseUrlV3: ctx.apiUrl,
    githubApiBaseUrlV4: ctx.graphqlUrl,
    interactive: false,
    publishStatusCommentOnFailure: true,
    pullNumber: pr.number,
    repoForkOwner: inputs.forkOwner !== '' ? inputs.forkOwner : repo.owner,
    repoName: repo.repo,
    repoOwner: repo.owner,
    reviewers: collectReviewerLogins(pr, inputs.includeReviewers),
  };
}

async function loadRepoConfig(actionConfig: Record<string, any>) {
  return getOptionsFromGithub({
    accessToken: actionConfig.accessToken,
    repoName: actionConfig.repoName,
    repoOwner: actionConfig.repoOwner,
    githubApiBaseUrlV4: actionConfig.githubApiBaseUrlV4,
  });
}

function ensureBranchesConfigured(
  repoSettings: Record<string, any>,
  actionCfg: Record<string, any>,
) {
  if (
    !repoSettings.targetBranches &&
    !repoSettings.branchLabelMapping &&
    !actionCfg.branchLabelMapping
  ) {
    throw new Error(
      'No target branches found. Add "targetBranches" to .backportrc.json or set the "auto_backport_label_prefix" action input.',
    );
  }
}

export async function executeBackport({
  ctx,
  inputs,
}: {
  ctx: GithubContext;
  inputs: ActionInputs;
}): Promise<BackportResponse> {
  core.info('Initiating cherry-pick for merged pull request');

  const pr = ctx.payload.pull_request;
  if (pr && !pr.merged) {
    core.info('Pull request is still open — nothing to cherry-pick.');
    return { commits: [], results: [] };
  }

  const actionCfg = buildActionConfig(inputs, ctx);
  const repoSettings = await loadRepoConfig(actionCfg);

  core.info(JSON.stringify({ repoSettings, actionCfg }));

  ensureBranchesConfigured(repoSettings, actionCfg);

  const outcome = await backportRun({
    options: actionCfg,
    exitCodeOnFailure: false,
  });

  core.info(`Cherry-pick outcome: ${JSON.stringify(outcome, null, 2)}`);
  return outcome;
}

function collectErrors(
  results: BackportResponse['results'],
  suppressedCodes: string[],
): string | undefined {
  const messages: string[] = [];
  for (const entry of results) {
    if (entry.status !== 'error') continue;
    if (suppressedCodes.includes(entry.errorCode)) continue;
    messages.push(entry.errorMessage);
  }
  return messages.length > 0 ? messages.join(', ') : undefined;
}

export function extractErrorMessages(
  res: BackportResponse,
  suppressedCodes: string[] = [],
) {
  return collectErrors(res.results, suppressedCodes);
}

if (!process.env.VITEST) {
  const { context } = await import('@actions/github');

  await validateSubscription();

  const suppressedCodes = core
    .getInput('ignore_error_codes', { required: false })
    .split(',')
    .map((code) => code.trim())
    .filter(Boolean);

  try {
    const outcome = await executeBackport({
      ctx: context,
      inputs: {
        token: core.getInput('github_token', { required: true }),
        labelPrefix: core.getInput('auto_backport_label_prefix', {
          required: false,
        }),
        forkOwner: core.getInput('repo_fork_owner', { required: false }),
        includeReviewers: core.getBooleanInput('add_original_reviewers', {
          required: false,
        }),
      },
    });

    core.setOutput('Result', outcome);
    const errorSummary = extractErrorMessages(outcome, suppressedCodes);
    if (errorSummary) {
      core.setFailed(errorSummary);
    } else {
      core.info('All cherry-pick operations finished');
    }
  } catch (err: any) {
    core.error(`Cherry-pick operation failed: ${err.message}`);
    core.setFailed(err.message);
  }
}
