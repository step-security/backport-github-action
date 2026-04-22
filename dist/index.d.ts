import type { context as ghContext } from '@actions/github';
import { type BackportResponse } from 'backport';
type GithubContext = typeof ghContext;
type ActionInputs = {
    token: string;
    labelPrefix: string;
    forkOwner: string;
    includeReviewers: boolean;
};
export declare function executeBackport({ ctx, inputs, }: {
    ctx: GithubContext;
    inputs: ActionInputs;
}): Promise<BackportResponse>;
export declare function extractErrorMessages(res: BackportResponse, suppressedCodes?: string[]): string | undefined;
export {};
