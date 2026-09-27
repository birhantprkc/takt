/**
 * GitHub Pull Request utilities
 *
 * Creates PRs via `gh` CLI for CI/CD integration.
 */

import { execFileSync } from 'node:child_process';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';
import { fetchPaginatedApi } from '../git/paginated-api.js';
import { isTaktManagedPrBody } from '../git/format.js';
import { checkGhCli } from './issue.js';
import { resolveRepositoryNameWithOwner } from './repository.js';
import type {
  CreatePrOptions,
  CreatePrResult,
  ExistingPr,
  CommentResult,
  MergeResult,
  PrListItem,
  PrReviewData,
  PrReviewComment,
  PrReviewThreadState,
} from '../git/types.js';

const log = createLogger('github-pr');

/**
 * Find an open PR for the given branch.
 * Returns undefined if no PR exists.
 */
export function findExistingPr(branch: string, cwd: string): ExistingPr | undefined {
  const ghStatus = checkGhCli(cwd);
  if (!ghStatus.available) return undefined;

  try {
    const output = execFileSync(
      'gh', ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,url', '--limit', '1'],
      { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const prs = JSON.parse(output) as ExistingPr[];
    return prs[0];
  } catch (e) {
    log.debug('gh pr list failed, treating as no PR', { error: getErrorMessage(e) });
    return undefined;
  }
}

interface GhPrListResponseItem {
  number: number;
  user: { login: string };
  base: { ref: string; repo: { full_name: string } | null };
  head: { ref: string; repo: { full_name: string } | null };
  body: string | null;
  labels: Array<{ name: string }>;
  draft: boolean;
  updated_at: string;
}

const OPEN_PRS_PER_PAGE = 100;
const REVIEW_THREADS_PER_PAGE = 100;
const REVIEW_THREAD_COMMENTS_PER_PAGE = 100;
const GRAPHQL_PAGINATION_HARD_CAP = 100;
const DELETED_GITHUB_USER_AUTHOR = 'deleted GitHub user';
const CODERABBIT_LOGIN = 'coderabbitai';
const COMPLETED_REVIEW_STATES = new Set(['COMMENTED', 'APPROVED', 'CHANGES_REQUESTED']);

export interface CodeRabbitReviewThread {
  id: string;
  author: string;
  body: string;
  path: string;
  line?: number;
  url: string;
  isOutdated: boolean;
}

export interface CodeRabbitReviewStatus {
  headSha: string;
  hasCodeRabbitPost: boolean;
  reviewedHeadShas: string[];
}

export interface CacciaPullRequestDetails {
  number: number;
  headBranch: string;
  headSha: string;
  headRepositorySshUrl: string;
}

export function listOpenPrs(cwd: string): PrListItem[] {
  const repo = resolveRepositoryNameWithOwner(cwd);
  const prs = fetchPaginatedApi<GhPrListResponseItem>({
    command: 'gh',
    cwd,
    context: 'open pull request list',
    initialEndpoint: `repos/${repo}/pulls?state=open&per_page=${OPEN_PRS_PER_PAGE}&page=1`,
    parsePage: (body) => JSON.parse(body) as GhPrListResponseItem[],
  });

  return prs.map((pr) => ({
    number: pr.number,
    author: pr.user.login,
    base_branch: pr.base.ref,
    head_branch: pr.head.ref,
    managed_by_takt: isTaktManagedPrBody(pr.body),
    labels: pr.labels.map((label) => label.name),
    same_repository: pr.head.repo?.full_name === pr.base.repo?.full_name,
    draft: pr.draft,
    updated_at: pr.updated_at,
  }));
}

export function commentOnPr(prNumber: number, body: string, cwd: string): CommentResult {
  const ghStatus = checkGhCli(cwd);
  if (!ghStatus.available) {
    return { success: false, error: ghStatus.error };
  }

  try {
    execFileSync('gh', ['pr', 'comment', String(prNumber), '--body', body], {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { success: true };
  } catch (err) {
    const errorMessage = getErrorMessage(err);
    log.error('PR comment failed', { error: errorMessage });
    return { success: false, error: errorMessage };
  }
}

/** JSON fields requested from `gh pr view` for review data */
const PR_REVIEW_JSON_FIELDS = 'number,title,body,url,headRefName,baseRefName,comments,reviews,files';

/** Raw shape returned by `gh pr view --json` for review data */
interface GhPrViewReviewResponse {
  number: number;
  title: string;
  body: string;
  url: string;
  headRefName: string;
  baseRefName?: string;
  comments: Array<{ author: { login: string }; body: string }>;
  reviews: Array<{
    author: { login: string };
    body: string;
  }>;
  files: Array<{ path: string }>;
}

const REVIEW_THREADS_QUERY = `
query($owner:String!, $repo:String!, $number:Int!, $endCursor:String) {
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$number) {
      reviewThreads(first:${REVIEW_THREADS_PER_PAGE}, after:$endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          resolvedBy { login }
          comments(first:${REVIEW_THREAD_COMMENTS_PER_PAGE}) {
            pageInfo { hasNextPage endCursor }
            nodes {
              path
              line
              originalLine
              body
              url
              author { login }
            }
          }
        }
      }
    }
  }
}
`;

const REVIEW_THREAD_COMMENTS_QUERY = `
query($threadId:ID!, $commentsEndCursor:String) {
  node(id:$threadId) {
    ... on PullRequestReviewThread {
      comments(first:${REVIEW_THREAD_COMMENTS_PER_PAGE}, after:$commentsEndCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          path
          line
          originalLine
          body
          url
          author { login }
        }
      }
    }
  }
}
`;

const CODERABBIT_REVIEWS_QUERY = `
query($owner:String!, $repo:String!, $number:Int!, $endCursor:String) {
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$number) {
      reviews(first:${REVIEW_THREADS_PER_PAGE}, after:$endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          author { login }
          state
          submittedAt
          commit { oid }
        }
      }
    }
  }
}
`;

const CODERABBIT_THREAD_STARTERS_QUERY = `
query($owner:String!, $repo:String!, $number:Int!, $endCursor:String) {
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$number) {
      reviewThreads(first:${REVIEW_THREADS_PER_PAGE}, after:$endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          comments(first:1) {
            nodes { author { login } }
          }
        }
      }
    }
  }
}
`;

const CACCIA_PULL_REQUEST_QUERY = `
query($owner:String!, $repo:String!, $number:Int!) {
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$number) {
      number
      headRefName
      headRefOid
      headRepository {
        sshUrl
      }
    }
  }
}
`;

const RESOLVE_REVIEW_THREAD_MUTATION = `
mutation($threadId:ID!) {
  resolveReviewThread(input:{threadId:$threadId}) {
    thread { id isResolved }
  }
}
`;

interface GhGraphqlReviewThreadsResponse {
  data?: {
    repository: {
      pullRequest: {
        reviewThreads: GhGraphqlReviewThreadsConnection;
      } | null;
    } | null;
  };
  errors?: Array<{ message: string }>;
}

interface GhGraphqlReviewThreadsConnection {
  pageInfo: {
    hasNextPage: boolean;
    endCursor: string | null;
  };
  nodes: GhGraphqlReviewThread[];
}

interface GhGraphqlReviewThreadCommentsResponse {
  data?: {
    node: GhGraphqlReviewThreadCommentsNode | null;
  };
  errors?: Array<{ message: string }>;
}

interface GhGraphqlReviewThreadCommentsNode {
  comments?: GhGraphqlReviewThreadCommentsConnection;
}

interface GhGraphqlReviewThreadCommentsConnection {
  pageInfo: {
    hasNextPage: boolean;
    endCursor: string | null;
  };
  nodes: GhGraphqlReviewThreadComment[];
}

interface GhGraphqlReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  resolvedBy: { login: string } | null;
  comments: GhGraphqlReviewThreadCommentsConnection;
}

interface GhGraphqlReviewThreadComment {
  path: string;
  line: number | null;
  originalLine: number | null;
  body: string;
  url: string;
  author: { login: string } | null;
}

function buildReviewThreadsGraphqlArgs(
  owner: string,
  repo: string,
  prNumber: number,
  endCursor: string | undefined,
): string[] {
  const args = [
    'api',
    'graphql',
    '-f',
    `owner=${owner}`,
    '-f',
    `repo=${repo}`,
    '-F',
    `number=${prNumber}`,
  ];

  if (endCursor !== undefined) {
    args.push('-f', `endCursor=${endCursor}`);
  }

  args.push('-f', `query=${REVIEW_THREADS_QUERY}`);
  return args;
}

function buildReviewThreadCommentsGraphqlArgs(threadId: string, commentsEndCursor: string): string[] {
  return [
    'api',
    'graphql',
    '-f',
    `threadId=${threadId}`,
    '-f',
    `commentsEndCursor=${commentsEndCursor}`,
    '-f',
    `query=${REVIEW_THREAD_COMMENTS_QUERY}`,
  ];
}

function parseReviewThreadsResponse(raw: string): GhGraphqlReviewThreadsConnection {
  const parsed = JSON.parse(raw) as GhGraphqlReviewThreadsResponse;
  if (parsed.errors && parsed.errors.length > 0) {
    throw new Error(parsed.errors.map((error) => error.message).join('; '));
  }

  const pullRequest = parsed.data?.repository?.pullRequest;
  if (!pullRequest) {
    throw new Error('Missing pull request reviewThreads in GraphQL response');
  }

  return pullRequest.reviewThreads;
}

function parseReviewThreadCommentsResponse(raw: string): GhGraphqlReviewThreadCommentsConnection {
  const parsed = JSON.parse(raw) as GhGraphqlReviewThreadCommentsResponse;
  if (parsed.errors && parsed.errors.length > 0) {
    throw new Error(parsed.errors.map((error) => error.message).join('; '));
  }

  const thread = parsed.data?.node;
  if (!thread?.comments) {
    throw new Error('Missing pull request review thread comments in GraphQL response');
  }

  return thread.comments;
}

function resolveThreadState(thread: GhGraphqlReviewThread): PrReviewThreadState {
  if (thread.isResolved) {
    return 'resolved';
  }
  if (thread.isOutdated) {
    return 'outdated-unresolved';
  }
  return 'active';
}

function resolveReviewThreadCommentAuthor(comment: GhGraphqlReviewThreadComment): string {
  if (comment.author) {
    return comment.author.login;
  }
  return DELETED_GITHUB_USER_AUTHOR;
}

function fetchReviewThreadComments(
  thread: GhGraphqlReviewThread,
  prNumber: number,
  cwd: string,
): GhGraphqlReviewThreadComment[] {
  const comments = [...thread.comments.nodes];
  let pageInfo = thread.comments.pageInfo;

  for (let page = 1; page <= GRAPHQL_PAGINATION_HARD_CAP && pageInfo.hasNextPage; page += 1) {
    if (!pageInfo.endCursor) {
      throw new Error(`Missing review thread comments endCursor for next page in pull request #${prNumber}`);
    }

    const raw = execFileSync(
      'gh',
      buildReviewThreadCommentsGraphqlArgs(thread.id, pageInfo.endCursor),
      { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const nextComments = parseReviewThreadCommentsResponse(raw);
    comments.push(...nextComments.nodes);
    pageInfo = nextComments.pageInfo;
  }

  if (pageInfo.hasNextPage) {
    throw new Error(
      `Pagination limit exceeded while fetching pull request #${prNumber} review thread comments (>${GRAPHQL_PAGINATION_HARD_CAP} pages)`,
    );
  }

  return comments;
}

function mapReviewThreadComments(
  thread: GhGraphqlReviewThread,
  comments: GhGraphqlReviewThreadComment[],
): PrReviewComment[] {
  const threadState = resolveThreadState(thread);
  return comments.map((comment) => {
    const line = comment.line ?? comment.originalLine ?? undefined;
    return {
      author: resolveReviewThreadCommentAuthor(comment),
      body: comment.body,
      path: comment.path,
      ...(line !== undefined ? { line } : {}),
      url: comment.url,
      threadState,
      ...(thread.resolvedBy ? { resolvedBy: thread.resolvedBy.login } : {}),
      isOutdated: thread.isOutdated,
    };
  });
}

function fetchPrReviewThreads(owner: string, repo: string, prNumber: number, cwd: string): PrReviewComment[] {
  try {
    const comments: PrReviewComment[] = [];
    let endCursor: string | undefined;

    for (let page = 1; page <= GRAPHQL_PAGINATION_HARD_CAP; page += 1) {
      const raw = execFileSync(
        'gh',
        buildReviewThreadsGraphqlArgs(owner, repo, prNumber, endCursor),
        { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      );
      const reviewThreads = parseReviewThreadsResponse(raw);

      for (const thread of reviewThreads.nodes) {
        const threadComments = fetchReviewThreadComments(thread, prNumber, cwd);
        comments.push(...mapReviewThreadComments(thread, threadComments));
      }

      if (!reviewThreads.pageInfo.hasNextPage) {
        return comments;
      }
      if (!reviewThreads.pageInfo.endCursor) {
        throw new Error('Missing reviewThreads endCursor for next page');
      }
      endCursor = reviewThreads.pageInfo.endCursor;
    }

    throw new Error(
      `Pagination limit exceeded while fetching pull request #${prNumber} review threads (>${GRAPHQL_PAGINATION_HARD_CAP} pages)`,
    );
  } catch (err) {
    throw new Error(`GraphQL reviewThreads failed: ${getErrorMessage(err)}`);
  }
}

function parseRepositoryFromPrUrl(prUrl: string): { owner: string; repo: string } {
  const parsed = new URL(prUrl);
  const pathSegments = parsed.pathname.split('/').filter(Boolean);

  if (pathSegments.length < 4 || pathSegments[2] !== 'pull') {
    throw new Error(`Unexpected pull request URL format: ${prUrl}`);
  }

  const [owner, repo] = pathSegments;
  if (!owner || !repo) {
    throw new Error(`Repository owner/repo is missing in pull request URL: ${prUrl}`);
  }

  return { owner, repo };
}

interface PullRequestLocator {
  owner: string;
  repo: string;
  headSha: string;
}

class ReviewStatusDeadlineExceededError extends Error {}

function isCommandTimeoutError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && error.code === 'ETIMEDOUT';
}

function runGhCommand(args: string[], cwd: string, deadlineAt?: number): string {
  const options = { cwd, encoding: 'utf-8' as const, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] };
  if (deadlineAt === undefined) {
    return execFileSync('gh', args, options);
  }

  const timeout = deadlineAt - Date.now();
  if (timeout <= 0) {
    throw new ReviewStatusDeadlineExceededError();
  }

  try {
    return execFileSync('gh', args, {
      ...options,
      timeout,
      killSignal: 'SIGKILL',
    });
  } catch (error) {
    if (isCommandTimeoutError(error)) {
      throw new ReviewStatusDeadlineExceededError();
    }
    throw error;
  }
}

function fetchPullRequestLocator(
  prNumber: number,
  cwd: string,
  deadlineAt?: number,
): PullRequestLocator {
  const raw = runGhCommand(
    ['pr', 'view', String(prNumber), '--json', 'url,headRefOid'],
    cwd,
    deadlineAt,
  );
  const response = JSON.parse(raw) as { url?: unknown; headRefOid?: unknown };
  if (typeof response.url !== 'string' || typeof response.headRefOid !== 'string' || !response.headRefOid) {
    throw new Error(`Missing pull request URL or head SHA for pull request #${prNumber}`);
  }
  return { ...parseRepositoryFromPrUrl(response.url), headSha: response.headRefOid };
}

function buildCodeRabbitGraphqlArgs(
  owner: string,
  repo: string,
  prNumber: number,
  query: string,
  endCursor: string | undefined,
): string[] {
  const args = [
    'api',
    'graphql',
    '-f', `owner=${owner}`,
    '-f', `repo=${repo}`,
    '-F', `number=${prNumber}`,
  ];
  if (endCursor !== undefined) {
    args.push('-f', `endCursor=${endCursor}`);
  }
  args.push('-f', `query=${query}`);
  return args;
}

interface CodeRabbitReviewNode {
  author: { login: string } | null;
  state: string;
  submittedAt: string | null;
  commit: { oid: string } | null;
}

interface CodeRabbitReviewPage {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: CodeRabbitReviewNode[];
}

function parseCodeRabbitReviewPage(raw: string, prNumber: number): CodeRabbitReviewPage {
  const parsed = JSON.parse(raw) as {
    data?: {
      repository?: {
        pullRequest?: { reviews?: CodeRabbitReviewPage | null } | null;
      } | null;
    };
    errors?: Array<{ message: string }>;
  };
  if (parsed.errors && parsed.errors.length > 0) {
    throw new Error(parsed.errors.map((error) => error.message).join('; '));
  }
  const reviews = parsed.data?.repository?.pullRequest?.reviews;
  if (!reviews) {
    throw new Error(`Missing pull request reviews in GraphQL response for pull request #${prNumber}`);
  }
  return reviews;
}

function fetchCodeRabbitReviews(
  locator: PullRequestLocator,
  prNumber: number,
  cwd: string,
  deadlineAt?: number,
): CodeRabbitReviewNode[] {
  const reviews: CodeRabbitReviewNode[] = [];
  let endCursor: string | undefined;
  for (let page = 1; page <= GRAPHQL_PAGINATION_HARD_CAP; page += 1) {
    const raw = runGhCommand(
      buildCodeRabbitGraphqlArgs(locator.owner, locator.repo, prNumber, CODERABBIT_REVIEWS_QUERY, endCursor),
      cwd,
      deadlineAt,
    );
    const response = parseCodeRabbitReviewPage(raw, prNumber);
    reviews.push(...response.nodes);
    if (!response.pageInfo.hasNextPage) {
      return reviews;
    }
    if (!response.pageInfo.endCursor) {
      throw new Error(`Missing reviews endCursor for pull request #${prNumber}`);
    }
    endCursor = response.pageInfo.endCursor;
  }
  throw new Error(`Pagination limit exceeded while fetching pull request #${prNumber} reviews (>${GRAPHQL_PAGINATION_HARD_CAP} pages)`);
}

interface CodeRabbitThreadStarterPage {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: Array<{ comments: { nodes: Array<{ author: { login: string } | null }> } }>;
}

function parseCodeRabbitThreadStarterPage(raw: string, prNumber: number): CodeRabbitThreadStarterPage {
  const parsed = JSON.parse(raw) as {
    data?: {
      repository?: {
        pullRequest?: { reviewThreads?: CodeRabbitThreadStarterPage | null } | null;
      } | null;
    };
    errors?: Array<{ message: string }>;
  };
  if (parsed.errors && parsed.errors.length > 0) {
    throw new Error(parsed.errors.map((error) => error.message).join('; '));
  }
  const threads = parsed.data?.repository?.pullRequest?.reviewThreads;
  if (!threads) {
    throw new Error(`Missing pull request reviewThreads in GraphQL response for pull request #${prNumber}`);
  }
  return threads;
}

function fetchCodeRabbitThreadStarters(
  locator: PullRequestLocator,
  prNumber: number,
  cwd: string,
  deadlineAt?: number,
): string[] {
  const authors: string[] = [];
  let endCursor: string | undefined;
  for (let page = 1; page <= GRAPHQL_PAGINATION_HARD_CAP; page += 1) {
    const raw = runGhCommand(
      buildCodeRabbitGraphqlArgs(locator.owner, locator.repo, prNumber, CODERABBIT_THREAD_STARTERS_QUERY, endCursor),
      cwd,
      deadlineAt,
    );
    const response = parseCodeRabbitThreadStarterPage(raw, prNumber);
    for (const thread of response.nodes) {
      const starter = thread.comments.nodes[0]?.author?.login;
      if (starter !== undefined) {
        authors.push(starter);
      }
    }
    if (!response.pageInfo.hasNextPage) {
      return authors;
    }
    if (!response.pageInfo.endCursor) {
      throw new Error(`Missing reviewThreads endCursor for pull request #${prNumber}`);
    }
    endCursor = response.pageInfo.endCursor;
  }
  throw new Error(`Pagination limit exceeded while fetching pull request #${prNumber} review threads (>${GRAPHQL_PAGINATION_HARD_CAP} pages)`);
}

/** Returns only unresolved review threads whose first comment was created by CodeRabbit. */
export function fetchCodeRabbitReviewThreads(prNumber: number, cwd: string): CodeRabbitReviewThread[] {
  const locator = fetchPullRequestLocator(prNumber, cwd);
  const threads: CodeRabbitReviewThread[] = [];
  let endCursor: string | undefined;

  for (let page = 1; page <= GRAPHQL_PAGINATION_HARD_CAP; page += 1) {
    const raw = execFileSync(
      'gh',
      buildReviewThreadsGraphqlArgs(locator.owner, locator.repo, prNumber, endCursor),
      { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const response = parseReviewThreadsResponse(raw);
    for (const thread of response.nodes) {
      if (thread.isResolved) {
        continue;
      }
      const comments = fetchReviewThreadComments(thread, prNumber, cwd);
      const starter = comments[0];
      if (!starter || starter.author?.login.toLowerCase() !== CODERABBIT_LOGIN) {
        continue;
      }
      const line = starter.line ?? starter.originalLine ?? undefined;
      threads.push({
        id: thread.id,
        author: starter.author.login,
        body: starter.body,
        path: starter.path,
        ...(line === undefined ? {} : { line }),
        url: starter.url,
        isOutdated: thread.isOutdated,
      });
    }
    if (!response.pageInfo.hasNextPage) {
      return threads;
    }
    if (!response.pageInfo.endCursor) {
      throw new Error(`Missing reviewThreads endCursor for pull request #${prNumber}`);
    }
    endCursor = response.pageInfo.endCursor;
  }
  throw new Error(`Pagination limit exceeded while fetching pull request #${prNumber} review threads (>${GRAPHQL_PAGINATION_HARD_CAP} pages)`);
}

/** Returns CodeRabbit review events and thread presence for wait and re-review checks. */
export function fetchCodeRabbitReviewStatus(prNumber: number, cwd: string): CodeRabbitReviewStatus;
export function fetchCodeRabbitReviewStatus(
  prNumber: number,
  cwd: string,
  deadlineAt: number,
): CodeRabbitReviewStatus | undefined;
export function fetchCodeRabbitReviewStatus(
  prNumber: number,
  cwd: string,
  deadlineAt?: number,
): CodeRabbitReviewStatus | undefined {
  let locator: PullRequestLocator;
  let reviews: CodeRabbitReviewNode[];
  let threadAuthors: string[];
  try {
    locator = fetchPullRequestLocator(prNumber, cwd, deadlineAt);
    reviews = fetchCodeRabbitReviews(locator, prNumber, cwd, deadlineAt);
    threadAuthors = fetchCodeRabbitThreadStarters(locator, prNumber, cwd, deadlineAt);
  } catch (error) {
    if (error instanceof ReviewStatusDeadlineExceededError) {
      return undefined;
    }
    throw error;
  }

  const coderabbitReviews = reviews.filter((review) =>
    review.author?.login.toLowerCase() === CODERABBIT_LOGIN
    && review.submittedAt !== null
    && COMPLETED_REVIEW_STATES.has(review.state));
  return {
    headSha: locator.headSha,
    hasCodeRabbitPost: coderabbitReviews.length > 0
      || threadAuthors.some((author) => author.toLowerCase() === CODERABBIT_LOGIN),
    reviewedHeadShas: coderabbitReviews
      .map((review) => review.commit?.oid)
      .filter((sha): sha is string => sha !== null && sha !== undefined),
  };
}

/** Reads the current PR head and its push target without changing the project worktree. */
export function fetchCacciaPullRequestDetails(prNumber: number, cwd: string): CacciaPullRequestDetails {
  const locator = fetchPullRequestLocator(prNumber, cwd);
  const raw = execFileSync(
    'gh',
    buildCodeRabbitGraphqlArgs(locator.owner, locator.repo, prNumber, CACCIA_PULL_REQUEST_QUERY, undefined),
    { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const parsed = JSON.parse(raw) as {
    data?: {
      repository?: {
        pullRequest?: {
          number: number;
          headRefName: string;
          headRefOid: string;
          headRepository: { sshUrl: string } | null;
        } | null;
      } | null;
    };
    errors?: Array<{ message: string }>;
  };
  if (parsed.errors && parsed.errors.length > 0) {
    throw new Error(parsed.errors.map((error) => error.message).join('; '));
  }
  const pullRequest = parsed.data?.repository?.pullRequest;
  if (!pullRequest || pullRequest.number !== prNumber || !pullRequest.headRepository) {
    throw new Error(`Missing pull request head repository for pull request #${prNumber}`);
  }
  if (pullRequest.headRefOid !== locator.headSha) {
    throw new Error(`Pull request #${prNumber} head changed while reading its metadata`);
  }
  if (!/^git@github\.com:[^\s:]+\/[^\s:]+\.git$/u.test(pullRequest.headRepository.sshUrl)) {
    throw new Error(`Invalid GitHub SSH URL for pull request #${prNumber}`);
  }
  return {
    number: pullRequest.number,
    headBranch: pullRequest.headRefName,
    headSha: pullRequest.headRefOid,
    headRepositorySshUrl: pullRequest.headRepository.sshUrl,
  };
}

/** Resolves the supplied GitHub review thread through its GraphQL thread ID. */
export function resolveReviewThread(threadId: string, cwd: string): void {
  const raw = execFileSync(
    'gh',
    ['api', 'graphql', '-f', `threadId=${threadId}`, '-f', `query=${RESOLVE_REVIEW_THREAD_MUTATION}`],
    { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const parsed = JSON.parse(raw) as {
    data?: { resolveReviewThread?: { thread?: { id: string; isResolved: boolean } | null } | null };
    errors?: Array<{ message: string }>;
  };
  if (parsed.errors && parsed.errors.length > 0) {
    throw new Error(parsed.errors.map((error) => error.message).join('; '));
  }
  const thread = parsed.data?.resolveReviewThread?.thread;
  if (!thread || thread.id !== threadId || !thread.isResolved) {
    throw new Error(`GitHub did not resolve review thread ${threadId}`);
  }
}

/**
 * Fetch PR review comments and metadata via `gh pr view`.
 * Throws on failure (PR not found, network error, etc.).
 */
export function fetchPrReviewComments(prNumber: number, cwd: string): PrReviewData {
  log.debug('Fetching PR review comments', { prNumber });

  const raw = execFileSync(
    'gh',
    ['pr', 'view', String(prNumber), '--json', PR_REVIEW_JSON_FIELDS],
    { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
  );

  const data = JSON.parse(raw) as GhPrViewReviewResponse;
  const { owner, repo } = parseRepositoryFromPrUrl(data.url);
  const threadReviewComments = fetchPrReviewThreads(owner, repo, prNumber, cwd);

  const comments: PrReviewComment[] = data.comments.map((c) => ({
    author: c.author.login,
    body: c.body,
  }));

  const reviews: PrReviewComment[] = [];
  for (const review of data.reviews) {
    if (review.body) {
      reviews.push({ author: review.author.login, body: review.body });
    }
  }
  reviews.push(...threadReviewComments);

  return {
    number: data.number,
    title: data.title,
    body: data.body,
    url: data.url,
    headRefName: data.headRefName,
    baseRefName: data.baseRefName,
    comments,
    reviews,
    files: data.files.map((f) => f.path),
  };
}

export function createPullRequest(options: CreatePrOptions, cwd: string): CreatePrResult {
  const ghStatus = checkGhCli(cwd);
  if (!ghStatus.available) {
    return { success: false, error: ghStatus.error };
  }

  const args = [
    'pr', 'create',
    '--title', options.title,
    '--body', options.body,
    '--head', options.branch,
  ];

  if (options.base) {
    args.push('--base', options.base);
  }

  if (options.repo) {
    args.push('--repo', options.repo);
  }

  if (options.draft) {
    args.push('--draft');
  }

  for (const label of options.labels ?? []) {
    args.push('--label', label);
  }

  log.info('Creating PR', { branch: options.branch, title: options.title, draft: options.draft });

  try {
    const output = execFileSync('gh', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const url = output.trim();
    log.info('PR created', { url });

    return { success: true, url };
  } catch (err) {
    const errorMessage = getErrorMessage(err);
    log.error('PR creation failed', { error: errorMessage });
    return { success: false, error: errorMessage };
  }
}

export function mergePr(prNumber: number, cwd: string): MergeResult {
  const ghStatus = checkGhCli(cwd);
  if (!ghStatus.available) {
    return { success: false, error: ghStatus.error };
  }

  try {
    execFileSync('gh', ['pr', 'merge', String(prNumber), '--merge', '--delete-branch'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { success: true };
  } catch (err) {
    const errorMessage = getErrorMessage(err);
    log.error('PR merge failed', { error: errorMessage });
    return { success: false, error: errorMessage };
  }
}

export function closePr(prNumber: number, cwd: string): MergeResult {
  const ghStatus = checkGhCli(cwd);
  if (!ghStatus.available) {
    return { success: false, error: ghStatus.error };
  }

  try {
    execFileSync('gh', ['pr', 'close', String(prNumber)], {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { success: true };
  } catch (err) {
    const errorMessage = getErrorMessage(err);
    log.error('PR close failed', { error: errorMessage });
    return { success: false, error: errorMessage };
  }
}
