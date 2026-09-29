import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  callDeepSeekHarness,
  closeDeepSeekHarnessProcesses,
} from '../infra/deepseek-harness/index.js';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { createProviderEventLogger } from '../core/logging/providerEventLogger.js';
import { renderTraceReportFromRecords } from '../features/tasks/execute/traceReport.js';
import type { StreamCallback } from '../shared/types/provider.js';

const liveEnabled = process.env.TAKT_DEEPSEEK_HARNESS_LIVE === '1';
const supportedRuntime = (
  (process.platform === 'linux' && (process.arch === 'x64' || process.arch === 'arm64'))
  || (process.platform === 'darwin' && process.arch === 'arm64')
);
const managedEnvironmentDir = path.join(getGlobalConfigDir(), 'deepseek-harness', 'venv');
const managedEnvironmentAvailable = existsSync(managedEnvironmentDir);
const suiteEnabled = liveEnabled && supportedRuntime && managedEnvironmentAvailable;

const STORE_KEY = 'dummy-store-credential-1487';
const UPDATED_STORE_KEY = 'dummy-updated-credential-1487';
const ENV_KEY = 'dummy-env-credential-1487';
const REQUEST_TIMEOUT_MS = 120_000;
const WATCHER_TIMEOUT_MS = 20_000;
const WATCHER_POLL_INTERVAL_MS = 500;
const execFileAsync = promisify(execFile);

interface RecordedRequest {
  authorization: string | undefined;
  body: string;
}

type MockMode = 'ok' | 'auth-echo';

interface MockEndpoint {
  baseUrl: string;
  requests: RecordedRequest[];
  setMode: (mode: MockMode) => void;
  holdNextResponse: () => { received: Promise<void>; release: () => void };
  close: () => Promise<void>;
}

function writeEventStream(response: import('node:http').ServerResponse): void {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const [delta, finish] of [
    [{ role: 'assistant', content: 'confirmed' }, null],
    [{}, 'stop'],
  ] as const) {
    response.write(`data: ${JSON.stringify({
      id: 'mock',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'deepseek-v4-flash',
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`);
  }
  response.write('data: [DONE]\n\n');
  response.end();
}

async function startMockEndpoint(): Promise<MockEndpoint> {
  const requests: RecordedRequest[] = [];
  let mode: MockMode = 'ok';
  let hold: { received: () => void; ready: Promise<void> } | undefined;
  let releaseHeld: (() => void) | undefined;
  const server: Server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', async () => {
      requests.push({ authorization: request.headers.authorization, body });
      const currentHold = hold;
      hold = undefined;
      if (currentHold) {
        currentHold.received();
        await currentHold.ready;
      }
      if (mode === 'auth-echo') {
        response.writeHead(401, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: {
          message: `rejected ${STORE_KEY}`, cause: { message: `nested ${STORE_KEY}` },
        } }));
        return;
      }
      writeEventStream(response);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('mock endpoint did not bind a TCP port');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    setMode: (next) => {
      mode = next;
    },
    holdNextResponse: () => {
      let received!: () => void;
      let release!: () => void;
      const receipt = new Promise<void>((resolve) => { received = resolve; });
      const ready = new Promise<void>((resolve) => { release = resolve; });
      hold = { received, ready };
      releaseHeld = release;
      return { received: receipt, release };
    },
    close: () => new Promise<void>((resolve) => {
      releaseHeld?.();
      server.close(() => resolve());
    }),
  };
}

function decompressSessionFrames(data: Buffer): Buffer {
  const frames: Buffer[] = [];
  let offset = 0;
  while (offset < data.length) {
    // Node's one-shot Zstd decoder stops after the first frame. Harness appends
    // frames, so scanning only that first frame silently misses later events.
    const decoded = zstdDecompressSync(data.subarray(offset), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    if (decoded.engine.bytesWritten <= 0) {
      throw new Error('Session decoder did not consume a frame');
    }
    offset += decoded.engine.bytesWritten;
    frames.push(decoded.buffer);
  }
  return Buffer.concat(frames);
}

describe('DeepSeek Harness persisted session inspection', () => {
  it('scans later concatenated Zstd frames instead of just the session header', () => {
    const data = Buffer.concat([
      zstdCompressSync(Buffer.from('{"type":"session/header"}\n')),
      zstdCompressSync(Buffer.from(JSON.stringify({ message: STORE_KEY }) + '\n')),
    ]);
    expect(decompressSessionFrames(data).includes(STORE_KEY)).toBe(true);
  });

  it('rejects an unreadable frame instead of treating it as secret-free', () => {
    expect(() => decompressSessionFrames(Buffer.from('invalid compressed session'))).toThrow();
  });
});

function collectSecretHits(directory: string, secret: string): string[] {
  const hits: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      let data: Buffer = readFileSync(entryPath);
      if (entryPath.endsWith('.zstd')) {
        data = decompressSessionFrames(data);
      }
      if (data.includes(secret)) {
        hits.push(entryPath);
      }
    }
  };
  visit(directory);
  return hits;
}

describe.skipIf(!suiteEnabled)('DeepSeek Harness credential store integration', () => {
  let root: string;
  let workspace: string;
  let sourceHome: string;
  let dshHome: string;
  let storePath: string;
  let settingsPath: string;
  let endpoint: MockEndpoint;

  async function writeStore(content: string): Promise<void> {
    await writeFile(storePath, content, 'utf8');
    await chmod(storePath, 0o600);
  }

  async function writeSettings(baseUrl: string, reference = 'DEEPSEEK_API_KEY'): Promise<void> {
    await writeFile(settingsPath, [
      'llm-deepseek:',
      `  apiKeyEnv: ${reference}`,
      `  baseURL: ${baseUrl}`,
      '',
    ].join('\n'), 'utf8');
  }

  async function runTurn(options: {
    prompt?: string;
    sessionId?: string;
    model?: string;
    childProcessEnv?: Readonly<Record<string, string>>;
    onStream?: StreamCallback;
  } = {}): Promise<Awaited<ReturnType<typeof callDeepSeekHarness>>> {
    return callDeepSeekHarness('live-smoke', options.prompt ?? 'Return ok.', {
      cwd: workspace,
      ...(options.onStream === undefined ? {} : { onStream: options.onStream }),
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      ...(options.childProcessEnv === undefined ? {} : { childProcessEnv: options.childProcessEnv }),
      ...(options.model === undefined ? {} : { model: options.model }),
      providerOptions: { baseUrl: endpoint.baseUrl, requestTimeoutMs: REQUEST_TIMEOUT_MS },
    });
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'takt-deepseek-credential-store-'));
    workspace = path.join(root, 'workspace');
    sourceHome = path.join(root, 'source-home');
    const managedRoot = path.join(root, 'config', 'deepseek-harness');
    dshHome = path.join(managedRoot, 'dsh-home');
    storePath = path.join(sourceHome, '.credentials.yaml');
    settingsPath = path.join(sourceHome, 'settings.yaml');
    await mkdir(workspace, { recursive: true });
    await mkdir(sourceHome, { recursive: true });
    await mkdir(dshHome, { recursive: true });
    await symlink(managedEnvironmentDir, path.join(managedRoot, 'venv'));
    endpoint = await startMockEndpoint();
    await writeStore(`version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${STORE_KEY}\n`);
    await writeSettings(endpoint.baseUrl);
    vi.stubEnv('TAKT_CONFIG_DIR', path.join(root, 'config'));
    vi.stubEnv('DSH_HOME', sourceHome);
    vi.stubEnv('DEEPSEEK_API_KEY', undefined);
    vi.stubEnv('DEEPSEEK_BASE_URL', undefined);
  });

  afterEach(async () => {
    await closeDeepSeekHarnessProcesses();
    await endpoint?.close();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it('resolves the credential from the source store without reading or changing it', async () => {
    const storeBefore = await readFile(storePath);
    const modeBefore = (await stat(storePath)).mode & 0o777;

    const response = await runTurn();

    expect(response.status).toBe('done');
    expect(endpoint.requests).toHaveLength(1);
    expect(endpoint.requests[0]?.authorization).toContain(STORE_KEY);
    expect(response.content).not.toContain(STORE_KEY);
    expect(await readFile(storePath)).toEqual(storeBefore);
    expect((await stat(storePath)).mode & 0o777).toBe(modeBefore);
    expect(existsSync(path.join(dshHome, 'sessions'))).toBe(true);
    expect(existsSync(path.join(dshHome, '.credentials.yaml'))).toBe(false);
  });

  it('prefers a same-reference launch environment value over the store', async () => {
    const response = await runTurn({ childProcessEnv: { DEEPSEEK_API_KEY: ENV_KEY } });

    expect(response.status).toBe('done');
    expect(endpoint.requests.at(-1)?.authorization).toContain(ENV_KEY);
    expect(endpoint.requests.at(-1)?.authorization).not.toContain(STORE_KEY);
  });

  it('does not substitute a different reference for the selected reference', async () => {
    await writeSettings(endpoint.baseUrl, 'CUSTOM_DSH_KEY');
    const response = await runTurn({ childProcessEnv: { DEEPSEEK_API_KEY: ENV_KEY } });

    expect(response.status).toBe('error');
    expect(endpoint.requests).toHaveLength(0);
    expect(response.content).not.toContain(STORE_KEY);
    expect(response.content).not.toContain(ENV_KEY);
    await expect(readFile(storePath, 'utf8')).resolves.toContain(STORE_KEY);
  });

  it('reflects a store update on a later turn of the same session', async () => {
    const first = await runTurn({ sessionId: 'store-update-session', prompt: 'First turn.' });
    expect(first.status).toBe('done');
    expect(endpoint.requests.at(-1)?.authorization).toContain(STORE_KEY);

    await writeStore(`version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${UPDATED_STORE_KEY}\n`);

    let attempts = 0;
    await vi.waitFor(async () => {
      attempts += 1;
      const turn = await runTurn({ sessionId: 'store-update-session', prompt: `Reload check ${attempts}.` });
      expect(turn.status).toBe('done');
      expect(endpoint.requests.at(-1)?.authorization).toContain(UPDATED_STORE_KEY);
    }, { timeout: WATCHER_TIMEOUT_MS, interval: WATCHER_POLL_INTERVAL_MS });
  });

  it('fails a later turn after the store entry is deleted without sending another request', async () => {
    const first = await runTurn({ sessionId: 'store-delete-session', prompt: 'First turn.' });
    expect(first.status).toBe('done');

    await rm(storePath);

    let turnsAfterDeletion = 0;
    let requestsBeforeFailure: number | undefined;
    let failed: Awaited<ReturnType<typeof callDeepSeekHarness>> | undefined;
    await vi.waitFor(async () => {
      turnsAfterDeletion += 1;
      const requestsBeforeTurn = endpoint.requests.length;
      const turn = await runTurn({ sessionId: 'store-delete-session', prompt: `After deletion ${turnsAfterDeletion}.` });
      if (turn.status !== 'done') {
        failed = turn;
        requestsBeforeFailure = requestsBeforeTurn;
      }
      expect(failed).toBeDefined();
    }, { timeout: WATCHER_TIMEOUT_MS, interval: WATCHER_POLL_INTERVAL_MS });

    expect(failed?.content).not.toContain(STORE_KEY);
    // The official runtime may complete one more turn from its last-good credential while its
    // watcher observes the deletion; the turn that fails must not send another request.
    expect(endpoint.requests.length).toBe(requestsBeforeFailure);
  });

  it('reports a malformed store without echoing the document or its path', async () => {
    await writeStore('version: 1\nrefs: [broken\n');
    const response = await runTurn();

    expect(response.status).toBe('error');
    expect(endpoint.requests).toHaveLength(0);
    expect(response.content).not.toContain('broken');
    expect(response.content).not.toContain(storePath);
    expect(response.content).toContain('DSH_HOME');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'fails closed for an unreadable store without changing permissions or sending a request', async () => {
      const before = await readFile(storePath);
      await chmod(storePath, 0o000);
      try {
        const response = await runTurn();
        expect(response.status).toBe('error');
        expect(endpoint.requests).toHaveLength(0);
        expect(response.content).not.toContain(STORE_KEY);
        expect(response.content).not.toContain(storePath);
        expect((await stat(storePath)).mode & 0o777).toBe(0);
      } finally {
        await chmod(storePath, 0o600);
      }
      expect(await readFile(storePath)).toEqual(before);
    },
  );

  it('keeps an in-flight request on its initial credential and reloads for later turns', async () => {
    const held = endpoint.holdNextResponse();
    const pending = runTurn({ sessionId: 'snapshot-session' });
    try {
      await Promise.race([
        held.received,
        pending.then(() => { throw new Error('Turn ended before reaching mock endpoint'); }),
      ]);
      await writeStore(`version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${UPDATED_STORE_KEY}\n`);
      expect(endpoint.requests).toHaveLength(1);
      expect(endpoint.requests[0]?.authorization).toContain(STORE_KEY);
    } finally {
      held.release();
    }
    expect((await pending).status).toBe('done');
    expect(endpoint.requests).toHaveLength(1);
    await vi.waitFor(async () => {
      expect((await runTurn({ sessionId: 'snapshot-session' })).status).toBe('done');
      expect(endpoint.requests.at(-1)?.authorization).toContain(UPDATED_STORE_KEY);
    }, { timeout: WATCHER_TIMEOUT_MS, interval: WATCHER_POLL_INTERVAL_MS });
  });

  it('observes malformed live reload independently from deletion and recovers after repair', async () => {
    expect((await runTurn({ sessionId: 'malformed-reload' })).status).toBe('done');
    await writeStore('version: 1\nrefs: [broken\n');
    // Wait past the official watcher's debounce, then observe its last-good policy.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const afterCorruption = await runTurn({ sessionId: 'malformed-reload' });
    expect(afterCorruption.status).toBe('done');
    expect(endpoint.requests.at(-1)?.authorization).toContain(STORE_KEY);
    await writeStore(`version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${UPDATED_STORE_KEY}\n`);
    await vi.waitFor(async () => {
      expect((await runTurn({ sessionId: 'malformed-reload' })).status).toBe('done');
      expect(endpoint.requests.at(-1)?.authorization).toContain(UPDATED_STORE_KEY);
    }, { timeout: WATCHER_TIMEOUT_MS, interval: WATCHER_POLL_INTERVAL_MS });
  });

  it('keeps an echoed dummy credential out of TAKT output and the runtime session store', async () => {
    endpoint.setMode('auth-echo');
    await mkdir(path.join(root, 'reports'));
    const logger = createProviderEventLogger({
      logsDir: path.join(root, 'reports'), sessionId: 'credential-echo', runId: 'credential-echo', enabled: true,
    });
    const events: unknown[] = [];
    const response = await runTurn({ prompt: 'Trigger the mocked auth rejection.', onStream: (event) => {
      events.push(event);
      logger.logEvent({ provider: 'deepseek-harness', providerModel: 'deepseek-v4-flash', step: 'smoke' }, event);
    } });

    await closeDeepSeekHarnessProcesses();

    expect(endpoint.requests).toHaveLength(1);
    expect(endpoint.requests[0]?.authorization).toContain(STORE_KEY);
    expect(response.status).toBe('error');
    expect(response.content).not.toContain(STORE_KEY);
    expect(response.content).toMatch(/credential|auth/iu);
    expect(JSON.stringify(events)).not.toContain(STORE_KEY);
    expect(await readFile(logger.filepath, 'utf8')).not.toContain(STORE_KEY);

    const timestamp = '2026-09-24T12:00:00.000Z';
    const report = renderTraceReportFromRecords({
      tracePath: path.join(root, 'reports', 'trace.md'), workflowName: 'smoke', task: 'Credential echo probe',
      runSlug: 'credential-echo', status: 'failed', iterations: 1, endTime: timestamp,
    }, [{
      type: 'step_complete', step: 'smoke', persona: 'worker', iteration: 1,
      status: response.status, content: response.content, instruction: 'Trigger the mocked auth rejection.', timestamp,
    }], [], 'full');
    expect(report).toContain(response.content);
    expect(report).not.toContain(STORE_KEY);

    const leakedIntoRuntimeStore = collectSecretHits(dshHome, STORE_KEY);
    expect(
      leakedIntoRuntimeStore,
      'the pinned DeepSeek Harness runtime persisted the echoed dummy credential into its session store',
    ).toEqual([]);
  });

  it('keeps echoed credentials out of raw SDK notifications, stderr and all persisted frames', async () => {
    endpoint.setMode('auth-echo');
    const patchPath = path.join(root, 'sdk-echo-patch.json');
    await writeFile(patchPath, JSON.stringify([
      { id: 'credentials', config: { path: storePath } },
      { id: 'llm-deepseek', config: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: endpoint.baseUrl } },
      { id: 'session-telemetry-otel', disabled: true },
    ]));
    const script = [
      'import json, sys',
      'from deepseek_harness import DeepSeekHarness',
      'events = []',
      'h = DeepSeekHarness(provider="deepseek-official", model="deepseek-v4-flash", cwd=sys.argv[1], runtime_cwd=sys.argv[1], dsh_home=sys.argv[2], patches=(sys.argv[3],), initialize_timeout_seconds=10, request_timeout_seconds=10, shutdown_timeout_seconds=2)',
      'try:',
      '    result = h.run("Return ok.", on_notification=lambda n: events.append({"method": n.method, "payload": n.payload}))',
      '    print(json.dumps({"finish": result.finish_reason, "notifications": events}))',
      'finally:',
      '    h.close()',
    ].join('\n');
    const { stdout, stderr } = await execFileAsync(path.join(managedEnvironmentDir, 'bin', 'python'), [
      '-c', script, workspace, dshHome, patchPath,
    ], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env } });
    expect(endpoint.requests).toHaveLength(1);
    expect(endpoint.requests[0]?.authorization).toContain(STORE_KEY);
    const result = JSON.parse(stdout) as { finish: string; notifications: unknown[] };
    expect(result.finish).toBe('error');
    expect(result.notifications.length).toBeGreaterThan(0);
    expect.soft(stdout.includes(STORE_KEY), 'raw SDK notifications contain an echoed credential').toBe(false);
    expect.soft(stderr.includes(STORE_KEY), 'raw SDK stderr contains an echoed credential').toBe(false);
    expect.soft(collectSecretHits(dshHome, STORE_KEY), 'persisted runtime frames contain an echoed credential').toEqual([]);
  });
});
