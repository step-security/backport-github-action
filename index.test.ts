import * as core from '@actions/core';
import type { context as ghContext } from '@actions/github';
import type { BackportResponse } from 'backport';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { executeBackport, extractErrorMessages } from './index.js';

vi.mock('@actions/core', () => ({
  info: vi.fn(),
  setFailed: vi.fn(),
  getInput: vi.fn(),
  setOutput: vi.fn(),
}));

vi.mock('backport', () => ({
  backportRun: vi.fn(),
  getOptionsFromGithub: vi.fn(),
  getCommits: vi.fn(),
}));

type GithubContext = typeof ghContext;

function makeContext(overrides: Record<string, any> = {}): GithubContext {
  return {
    repo: { owner: 'elastic', repo: 'kibana' },
    payload: {
      pull_request: {
        merged: true,
        number: 1345,
        user: { login: 'sorenlouv' },
        requested_reviewers: [{ login: 'sorenlouv' }],
      },
    },
    serverUrl: 'https://github.my-own-enterprise.com',
    apiUrl: 'https://github.my-own-enterprise.com/api/v3',
    graphqlUrl: 'https://github.my-own-enterprise.com/api/graphql',
    ...overrides,
  } as unknown as GithubContext;
}

function makeInputs(overrides: Record<string, any> = {}) {
  return {
    token: 'very-secret',
    labelPrefix: 'backport-to-',
    forkOwner: '',
    includeReviewers: true,
    ...overrides,
  };
}

function response(
  results: BackportResponse['results'] = [],
): BackportResponse {
  return { commits: [], results };
}

describe('executeBackport', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  test('passes assembled config to backportRun', async () => {
    const { backportRun, getOptionsFromGithub, getCommits } =
      await import('backport');
    const spy = vi.mocked(backportRun).mockResolvedValue(
      'backport return value' as unknown as BackportResponse,
    );
    vi.mocked(getOptionsFromGithub).mockResolvedValue({} as any);
    vi.mocked(getCommits).mockResolvedValue(
      [{ suggestedTargetBranches: ['7.x'] }] as any,
    );

    await executeBackport({ inputs: makeInputs(), ctx: makeContext() });

    expect(spy).toHaveBeenCalledWith({
      exitCodeOnFailure: false,
      options: {
        accessToken: 'very-secret',
        assignees: ['sorenlouv'],
        branchLabelMapping: { '^backport-to-(.+)$': '$1' },
        interactive: false,
        publishStatusCommentOnFailure: true,
        pullNumber: 1345,
        repoForkOwner: 'elastic',
        repoName: 'kibana',
        repoOwner: 'elastic',
        gitHostname: 'github.my-own-enterprise.com',
        githubActionRunId: undefined,
        githubApiBaseUrlV3: 'https://github.my-own-enterprise.com/api/v3',
        githubApiBaseUrlV4:
          'https://github.my-own-enterprise.com/api/graphql',
        reviewers: ['sorenlouv'],
      },
    });
  });

  test('returns empty result when PR has not been merged', async () => {
    const { backportRun } = await import('backport');
    const spy = vi.mocked(backportRun);
    const logSpy = vi.mocked(core.info);

    const ctx = makeContext({
      payload: {
        pull_request: { merged: false, number: 1345, user: { login: 'sorenlouv' } },
      },
      serverUrl: 'https://github.com',
      apiUrl: 'https://api.github.com',
      graphqlUrl: 'https://api.github.com/graphql',
    });

    const out = await executeBackport({
      inputs: makeInputs({ includeReviewers: false }),
      ctx,
    });

    expect(spy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      'Pull request is still open — nothing to cherry-pick.',
    );
    expect(out).toEqual({ commits: [], results: [] });
  });

  test('throws when no branch configuration exists', async () => {
    const { backportRun, getOptionsFromGithub } = await import('backport');
    const spy = vi.mocked(backportRun);
    vi.mocked(getOptionsFromGithub).mockResolvedValue({} as any);

    const promise = executeBackport({
      inputs: makeInputs({ labelPrefix: '' }),
      ctx: makeContext(),
    });

    await expect(promise).rejects.toThrow(
      'No target branches found. Add "targetBranches" to .backportrc.json or set the "auto_backport_label_prefix" action input.',
    );
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('extractErrorMessages', () => {
  test('returns undefined for an empty result set', () => {
    expect(extractErrorMessages(response())).toBeUndefined();
  });

  test('surfaces a single error', () => {
    const res = response([
      { status: 'error', errorCode: 'config-error-exception', errorMessage: 'Hello', targetBranch: '7.x' },
    ]);
    expect(extractErrorMessages(res)).toBe('Hello');
  });

  test('surfaces permission failures', () => {
    const msg =
      'Could not create pull request: GitHub Actions is not permitted to create or approve pull requests.';
    const res = response([
      { status: 'error', errorCode: 'pr-creation-exception', errorMessage: msg, targetBranch: 'gmpy2-2.3.x' },
    ]);
    expect(extractErrorMessages(res)).toBe(msg);
  });

  test('suppresses errors whose code is in the suppressed list', () => {
    const res = response([
      {
        status: 'error',
        errorCode: 'merge-conflict-exception',
        errorMessage: 'Commit could not be cherrypicked due to conflicts in: file.ts',
        errorContext: { code: 'merge-conflict-exception', conflictingFiles: ['file.ts'], commitsWithoutBackports: [] },
        targetBranch: '7.x',
      },
    ]);
    expect(extractErrorMessages(res, ['merge-conflict-exception'])).toBeUndefined();
  });

  test('only suppresses matching codes — other errors still surface', () => {
    const res = response([
      {
        status: 'error',
        errorCode: 'merge-conflict-exception',
        errorMessage: 'Commit could not be cherrypicked due to conflicts in: file.ts',
        errorContext: { code: 'merge-conflict-exception', conflictingFiles: ['file.ts'], commitsWithoutBackports: [] },
        targetBranch: '7.x',
      },
      { status: 'error', errorCode: 'pr-creation-exception', errorMessage: 'Could not create pull request', targetBranch: '8.x' },
    ]);
    expect(extractErrorMessages(res, ['merge-conflict-exception'])).toBe('Could not create pull request');
  });

  test('joins multiple unsuppressed errors', () => {
    const res = response([
      { status: 'error', errorCode: 'unhandled-exception', errorMessage: 'My unhandled error', targetBranch: '7.x' },
      { status: 'error', errorCode: 'unhandled-exception', errorMessage: 'Another unhandled error', targetBranch: '7.x' },
    ]);
    expect(extractErrorMessages(res)).toBe('My unhandled error, Another unhandled error');
  });

  test('ignores success entries and only returns errors', () => {
    const res = response([
      { status: 'success', targetBranch: '7.x', pullRequestUrl: 'https://github.com/my-org/my-repo/pull/1', pullRequestNumber: 1 },
      { status: 'error', errorCode: 'cherrypick-exception', errorMessage: 'Cherry-pick failed', targetBranch: '8.x' },
    ]);
    expect(extractErrorMessages(res)).toBe('Cherry-pick failed');
  });

  test('returns undefined when every error is suppressed', () => {
    const res = response([
      { status: 'error', errorCode: 'merge-conflict-exception', errorMessage: 'Conflict in file.ts', targetBranch: '7.x' },
      { status: 'error', errorCode: 'merge-conflict-exception', errorMessage: 'Conflict in other.ts', targetBranch: '8.x' },
    ]);
    expect(extractErrorMessages(res, ['merge-conflict-exception'])).toBeUndefined();
  });

  test('joins errors from different codes', () => {
    const res = response([
      { status: 'error', errorCode: 'cherrypick-exception', errorMessage: 'Handled failure', targetBranch: '7.x' },
      { status: 'error', errorCode: 'unhandled-exception', errorMessage: 'Unhandled failure', targetBranch: '8.x' },
    ]);
    expect(extractErrorMessages(res)).toBe('Handled failure, Unhandled failure');
  });

  test('surfaces a single unhandled error', () => {
    const res = response([
      { status: 'error', errorCode: 'unhandled-exception', errorMessage: 'My failure' },
    ]);
    expect(extractErrorMessages(res)).toBe('My failure');
  });

  test('suppresses config-error-exception when listed', () => {
    const res = response([
      { status: 'error', errorCode: 'config-error-exception', errorMessage: 'My config error' },
    ]);
    expect(extractErrorMessages(res, ['config-error-exception'])).toBeUndefined();
  });

  test('surfaces no-branches-exception when not suppressed', () => {
    const res = response([
      { status: 'error', errorCode: 'no-branches-exception', errorMessage: 'There are no branches to backport to. Aborting.' },
    ]);
    expect(extractErrorMessages(res)).toBe('There are no branches to backport to. Aborting.');
  });

  test('suppresses no-branches-exception when listed', () => {
    const res = response([
      { status: 'error', errorCode: 'no-branches-exception', errorMessage: 'There are no branches to backport to. Aborting.' },
    ]);
    expect(extractErrorMessages(res, ['no-branches-exception'])).toBeUndefined();
  });

  describe('with typical production defaults', () => {
    const defaults = ['merge-conflict-exception', 'no-branches-exception'];

    test('suppresses merge-conflict-exception', () => {
      const res = response([
        {
          status: 'error',
          errorCode: 'merge-conflict-exception',
          errorMessage: 'Commit could not be cherrypicked due to conflicts in: file.ts',
          errorContext: { code: 'merge-conflict-exception', conflictingFiles: ['file.ts'], commitsWithoutBackports: [] },
          targetBranch: '7.x',
        },
      ]);
      expect(extractErrorMessages(res, defaults)).toBeUndefined();
    });

    test('suppresses no-branches-exception', () => {
      const res = response([
        { status: 'error', errorCode: 'no-branches-exception', errorMessage: 'There are no branches to backport to. Aborting.' },
      ]);
      expect(extractErrorMessages(res, defaults)).toBeUndefined();
    });

    test('lets pr-creation-exception through', () => {
      const msg =
        'Could not create pull request: GitHub Actions is not permitted to create or approve pull requests.';
      const res = response([
        { status: 'error', errorCode: 'pr-creation-exception', errorMessage: msg, targetBranch: '7.x' },
      ]);
      expect(extractErrorMessages(res, defaults)).toBe(msg);
    });

    test('lets non-default errors through even alongside suppressed ones', () => {
      const res = response([
        {
          status: 'error',
          errorCode: 'merge-conflict-exception',
          errorMessage: 'Commit could not be cherrypicked due to conflicts in: file.ts',
          errorContext: { code: 'merge-conflict-exception', conflictingFiles: ['file.ts'], commitsWithoutBackports: [] },
          targetBranch: '7.x',
        },
        { status: 'error', errorCode: 'config-error-exception', errorMessage: 'Invalid config', targetBranch: '8.x' },
      ]);
      expect(extractErrorMessages(res, defaults)).toBe('Invalid config');
    });
  });
});
