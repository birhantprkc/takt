import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closePr,
  createPullRequest,
  fetchPrReviewComments,
  fetchCodeRabbitReviewStatus,
  fetchCodeRabbitReviewThreads,
  fetchCacciaPullRequestDetails,
  findExistingPr,
  mergePr,
  resolveReviewThread,
} from '../infra/github/pr.js';

const execFileSync = vi.hoisted(() => vi.fn());
const checkGhCli = vi.hoisted(() => vi.fn(() => ({ available: true })));

vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => execFileSync(...args),
}));
vi.mock('../infra/github/issue.js', () => ({ checkGhCli }));
vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  getErrorMessage: (error: unknown) => String(error),
}));

describe('GitHub PR command boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execFileSync.mockReset();
    checkGhCli.mockReturnValue({ available: true });
  });

  it('finds an open PR and treats CLI failure as no match', () => {
    execFileSync.mockReturnValueOnce(JSON.stringify([{ number: 42, url: 'https://example.test/pr/42' }]));
    expect(findExistingPr('feature/branch', '/project')).toEqual({
      number: 42,
      url: 'https://example.test/pr/42',
    });

    execFileSync.mockImplementationOnce(() => { throw new Error('lookup failed'); });
    expect(findExistingPr('feature/branch', '/project')).toBeUndefined();
  });

  it('passes PR options and returns the created URL', () => {
    const title = 'dynamic title';
    const body = 'dynamic body';
    const branch = 'feature/dynamic';
    execFileSync.mockReturnValue('https://example.test/pr/7\n');

    const result = createPullRequest({
      title,
      body,
      branch,
      base: 'main',
      repo: 'org/repo',
      draft: true,
      labels: ['automation'],
    }, '/project');

    expect(result).toEqual({ success: true, url: 'https://example.test/pr/7' });
    const args = execFileSync.mock.calls[0]?.[1] as string[];
    expect(args).toEqual(expect.arrayContaining([
      '--title', title,
      '--body', body,
      '--head', branch,
      '--base', 'main',
      '--repo', 'org/repo',
      '--draft',
      '--label', 'automation',
    ]));
  });

  it('returns a failure result when merge or close cannot be executed', () => {
    execFileSync.mockImplementation(() => { throw new Error('remote operation failed'); });

    expect(mergePr(7, '/project')).toMatchObject({
      success: false,
      error: expect.stringContaining('remote operation failed'),
    });
    expect(closePr(7, '/project')).toMatchObject({
      success: false,
      error: expect.stringContaining('remote operation failed'),
    });
  });

  it('maps PR review metadata and thread comments across the provider boundary', () => {
    execFileSync
      .mockReturnValueOnce(JSON.stringify({
        number: 7,
        title: 'review target',
        body: 'description',
        url: 'https://github.com/org/repo/pull/7',
        headRefName: 'feature/review',
        baseRefName: 'main',
        comments: [{ author: { login: 'commenter' }, body: 'general comment' }],
        reviews: [{ author: { login: 'reviewer' }, body: 'review body' }],
        files: [{ path: 'src/changed.ts' }],
      }))
      .mockReturnValueOnce(JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{
                  id: 'thread-1',
                  isResolved: false,
                  isOutdated: false,
                  resolvedBy: null,
                  comments: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [{
                      path: 'src/changed.ts',
                      line: null,
                      originalLine: 11,
                      body: 'thread comment',
                      url: 'https://example.test/comment/1',
                      author: null,
                    }],
                  },
                }],
              },
            },
          },
        },
      }));

    const result = fetchPrReviewComments(7, '/project');
    expect(result).toMatchObject({
      number: 7,
      headRefName: 'feature/review',
      baseRefName: 'main',
      files: ['src/changed.ts'],
    });
    expect(result.comments).toEqual([{ author: 'commenter', body: 'general comment' }]);
    expect(result.reviews).toEqual(expect.arrayContaining([
      { author: 'reviewer', body: 'review body' },
      expect.objectContaining({
        author: expect.any(String),
        body: 'thread comment',
        path: 'src/changed.ts',
        line: 11,
        threadState: 'active',
      }),
    ]));
  });

  it('returns only unresolved CodeRabbit threads, using the thread starter and all pages', () => {
    execFileSync
      .mockReturnValueOnce(JSON.stringify({
        url: 'https://github.com/org/repo/pull/7',
        headRefOid: 'head-7',
      }))
      .mockReturnValueOnce(JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
                nodes: [
                  {
                    id: 'human-thread',
                    isResolved: false,
                    isOutdated: false,
                    resolvedBy: null,
                    comments: {
                      pageInfo: { hasNextPage: false, endCursor: null },
                      nodes: [
                        {
                          path: 'src/a.ts',
                          line: 4,
                          originalLine: 4,
                          body: 'human started this thread',
                          url: 'https://example.test/comment/1',
                          author: { login: 'reviewer' },
                        },
                        {
                          path: 'src/a.ts',
                          line: 4,
                          originalLine: 4,
                          body: 'CodeRabbit replied to a human thread',
                          url: 'https://example.test/comment/2',
                          author: { login: 'coderabbitai' },
                        },
                      ],
                    },
                  },
                  {
                    id: 'resolved-bot-thread',
                    isResolved: true,
                    isOutdated: false,
                    resolvedBy: { login: 'maintainer' },
                    comments: {
                      pageInfo: { hasNextPage: false, endCursor: null },
                      nodes: [{
                        path: 'src/a.ts',
                        line: 8,
                        originalLine: 8,
                        body: 'already resolved',
                        url: 'https://example.test/comment/3',
                        author: { login: 'coderabbitai' },
                      }],
                    },
                  },
                ],
              },
            },
          },
        },
      }))
      .mockReturnValueOnce(JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{
                  id: 'outdated-bot-thread',
                  isResolved: false,
                  isOutdated: true,
                  resolvedBy: null,
                  comments: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [{
                      path: 'src/b.ts',
                      line: null,
                      originalLine: 12,
                      body: 'unresolved outdated CodeRabbit finding',
                      url: 'https://example.test/comment/4',
                      author: { login: 'coderabbitai' },
                    }],
                  },
                }],
              },
            },
          },
        },
      }));

    const result = fetchCodeRabbitReviewThreads(7, '/project');

    expect(result.map((thread) => thread.id)).toEqual(['outdated-bot-thread']);
    expect(execFileSync).toHaveBeenCalledTimes(3);
  });

  it('surfaces GitHub GraphQL errors while fetching CodeRabbit threads', () => {
    execFileSync
      .mockReturnValueOnce(JSON.stringify({
        url: 'https://github.com/org/repo/pull/7',
        headRefOid: 'head-7',
      }))
      .mockReturnValueOnce(JSON.stringify({ errors: [{ message: 'review thread access denied' }] }));

    expect(() => fetchCodeRabbitReviewThreads(7, '/project'))
      .toThrow(/review thread access denied/u);
  });

  it('resolves the requested review thread without posting a PR comment', () => {
    execFileSync.mockReturnValue(JSON.stringify({
      data: { resolveReviewThread: { thread: { id: 'thread-42', isResolved: true } } },
    }));

    resolveReviewThread('thread-42', '/project');

    expect(execFileSync).toHaveBeenCalledTimes(1);
    const [binary, args] = execFileSync.mock.calls[0] as [string, string[]];
    expect(binary).toBe('gh');
    expect(args.slice(0, 2)).toEqual(['api', 'graphql']);
    expect(args).toContain('threadId=thread-42');
    const mutation = args.find((arg) => arg.startsWith('query='));
    expect(mutation).toContain('resolveReviewThread');
    expect(mutation).not.toContain('addPullRequestReviewComment');
  });

  it('surfaces errors from the review thread Resolve mutation', () => {
    execFileSync.mockReturnValue(JSON.stringify({ errors: [{ message: 'thread resolve denied' }] }));

    expect(() => resolveReviewThread('thread-42', '/project')).toThrow(/thread resolve denied/u);
  });

  it('reports CodeRabbit review completion only for the exact reviewed commit SHA', () => {
    execFileSync
      .mockReturnValueOnce(JSON.stringify({
        url: 'https://github.com/org/repo/pull/7',
        headRefOid: 'head-7',
      }))
      .mockReturnValueOnce(JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviews: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{
                  author: { login: 'coderabbitai' },
                  state: 'COMMENTED',
                  submittedAt: '2026-09-25T18:00:00Z',
                  commit: { oid: 'head-7' },
                }],
              },
            },
          },
        },
      }))
      .mockReturnValueOnce(JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{ comments: { nodes: [{ author: { login: 'coderabbitai' } }] } }],
              },
            },
          },
        },
      }));

    expect(fetchCodeRabbitReviewStatus(7, '/project')).toEqual({
      headSha: 'head-7',
      hasCodeRabbitPost: true,
      reviewedHeadShas: ['head-7'],
    });
    for (const [, , options] of execFileSync.mock.calls) {
      expect(options).not.toHaveProperty('timeout');
      expect(options).not.toHaveProperty('killSignal');
    }
  });

  it('uses the remaining absolute deadline for every status page and kills timed out gh processes', () => {
    let now = 10_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const timeSpentByCall = [100, 200, 100, 250, 0];
    let callNumber = 0;
    execFileSync.mockImplementation((_command: string, rawArgs: unknown, rawOptions: unknown) => {
      const args = rawArgs as string[];
      const options = rawOptions as { timeout?: number; killSignal?: string };
      const callIndex = callNumber;
      callNumber += 1;
      const query = args.find((arg) => arg.startsWith('query='));
      const cursor = args.find((arg) => arg.startsWith('endCursor='));
      let response: unknown;

      if (callIndex === 0) {
        response = { url: 'https://github.com/org/repo/pull/7', headRefOid: 'head-7' };
      } else if (query?.includes('reviewThreads')) {
        response = {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: cursor === undefined
                    ? { hasNextPage: true, endCursor: 'thread-cursor' }
                    : { hasNextPage: false, endCursor: null },
                  nodes: [],
                },
              },
            },
          },
        };
      } else {
        response = {
          data: {
            repository: {
              pullRequest: {
                reviews: {
                  pageInfo: cursor === undefined
                    ? { hasNextPage: true, endCursor: 'review-cursor' }
                    : { hasNextPage: false, endCursor: null },
                  nodes: cursor === undefined
                    ? [{
                        author: { login: 'coderabbitai' },
                        state: 'COMMENTED',
                        submittedAt: '2026-09-25T18:00:00Z',
                        commit: { oid: 'head-7' },
                      }]
                    : [],
                },
              },
            },
          },
        };
      }

      now += timeSpentByCall[callIndex] ?? 0;
      return JSON.stringify(response);
    });

    try {
      expect(fetchCodeRabbitReviewStatus(7, '/project', 11_000)).toEqual({
        headSha: 'head-7',
        hasCodeRabbitPost: true,
        reviewedHeadShas: ['head-7'],
      });
      const options = execFileSync.mock.calls.map(([, , rawOptions]) =>
        rawOptions as { timeout?: number; killSignal?: string },
      );
      expect(options.map(({ timeout }) => timeout)).toEqual([1_000, 900, 700, 600, 350]);
      expect(options.map(({ killSignal }) => killSignal)).toEqual(Array(5).fill('SIGKILL'));
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('returns no partial status when a later page reaches the deadline', () => {
    execFileSync
      .mockReturnValueOnce(JSON.stringify({
        url: 'https://github.com/org/repo/pull/7',
        headRefOid: 'head-7',
      }))
      .mockReturnValueOnce(JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviews: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{
                  author: { login: 'coderabbitai' },
                  state: 'COMMENTED',
                  submittedAt: '2026-09-25T18:00:00Z',
                  commit: { oid: 'head-7' },
                }],
              },
            },
          },
        },
      }))
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('spawnSync gh ETIMEDOUT'), { code: 'ETIMEDOUT' });
      });

    expect(fetchCodeRabbitReviewStatus(7, '/project', Date.now() + 1_000)).toBeUndefined();
    expect(execFileSync).toHaveBeenCalledTimes(3);
    expect(execFileSync.mock.calls[2]?.[2]).toMatchObject({
      killSignal: 'SIGKILL',
      timeout: expect.any(Number),
    });
  });

  it('does not convert GraphQL failures into a missing review status', () => {
    execFileSync
      .mockReturnValueOnce(JSON.stringify({
        url: 'https://github.com/org/repo/pull/7',
        headRefOid: 'head-7',
      }))
      .mockReturnValueOnce(JSON.stringify({ errors: [{ message: 'GraphQL authentication failed' }] }));

    expect(() => fetchCodeRabbitReviewStatus(7, '/project', Date.now() + 1_000))
      .toThrow('GraphQL authentication failed');
    expect(execFileSync).toHaveBeenCalledTimes(2);
  });

  it('does not start status retrieval after the absolute deadline', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(11_000);
    try {
      expect(fetchCodeRabbitReviewStatus(7, '/project', 11_000)).toBeUndefined();
      expect(execFileSync).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('returns the fork branch and exact PR head used to create an isolated clone', () => {
    execFileSync
      .mockReturnValueOnce(JSON.stringify({
        url: 'https://github.com/org/repo/pull/7',
        headRefOid: 'head-7',
      }))
      .mockReturnValueOnce(JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              number: 7,
              headRefName: 'fix/review-thread',
              headRefOid: 'head-7',
              headRepository: { sshUrl: 'git@github.com:contributor/repo.git' },
            },
          },
        },
      }));

    expect(fetchCacciaPullRequestDetails(7, '/project')).toEqual({
      number: 7,
      headBranch: 'fix/review-thread',
      headSha: 'head-7',
      headRepositorySshUrl: 'git@github.com:contributor/repo.git',
    });
  });

  it('does not treat a dismissed CodeRabbit review as a completed review', () => {
    execFileSync
      .mockReturnValueOnce(JSON.stringify({
        url: 'https://github.com/org/repo/pull/7',
        headRefOid: 'head-7',
      }))
      .mockReturnValueOnce(JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviews: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{
                  author: { login: 'coderabbitai' },
                  state: 'DISMISSED',
                  submittedAt: '2026-09-25T18:00:00Z',
                  commit: { oid: 'head-7' },
                }],
              },
            },
          },
        },
      }))
      .mockReturnValueOnce(JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [],
              },
            },
          },
        },
      }));

    expect(fetchCodeRabbitReviewStatus(7, '/project')).toEqual({
      headSha: 'head-7',
      hasCodeRabbitPost: false,
      reviewedHeadShas: [],
    });
  });
});
