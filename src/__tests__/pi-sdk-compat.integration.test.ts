import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentSession, DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
import { callPi } from '../infra/pi/client.js';
import type { PiCallOptions } from '../infra/pi/types.js';
import { COMPAT_MODEL, EXECUTION_FILE } from './fixtures/pi-sdk-compat.js';

const fixturePath = fileURLToPath(new URL('./fixtures/pi-sdk-compat.ts', import.meta.url));

describe('Pi SDK compatibility through the TAKT client', () => {
  let root: string;
  let sessions: AgentSession[];
  let disposed: Set<AgentSession>;
  let options: PiCallOptions;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'takt-pi-compat-'));
    sessions = [];
    disposed = new Set();
    vi.stubEnv('PI_CODING_AGENT_DIR', path.join(root, 'agent'));
    const originalDispose = AgentSession.prototype.dispose;
    vi.spyOn(AgentSession.prototype, 'dispose').mockImplementation(function (this: AgentSession) {
      disposed.add(this);
      originalDispose.call(this);
    });
    const originalBind = AgentSession.prototype.bindExtensions;
    vi.spyOn(AgentSession.prototype, 'bindExtensions').mockImplementation(async function (this: AgentSession, bindOptions) {
      sessions.push(this);
      return originalBind.call(this, bindOptions);
    });
    options = {
      cwd: root,
      model: COMPAT_MODEL,
      permissionMode: 'readonly',
      providerOptions: {
        extensions: [fixturePath],
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      },
    };
  });

  afterEach(() => {
    for (const session of sessions) {
      if (!disposed.has(session)) session.dispose();
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  function executions(): string[] {
    const file = path.join(root, EXECUTION_FILE);
    return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : [];
  }

  it('preserves the logical ID and earlier user and assistant messages after explicit extensions change', async () => {
    const first = await callPi('worker', 'remember:nonsecret-history-marker', options);
    expect(first.status).toBe('done');
    expect(first.content).toBe('saved:nonsecret-history-marker');
    const firstRuntime = sessions[0]!;
    const dispose = vi.spyOn(firstRuntime, 'dispose');
    const shutdown = vi.spyOn(firstRuntime.extensionRunner, 'emit');

    const second = await callPi('worker', 'recall', {
      ...options,
      sessionId: first.sessionId,
      providerOptions: { ...options.providerOptions, extensions: [writeReplacementExtension()] },
    });

    expect(second.status).toBe('done');
    expect(second.sessionId).toBe(first.sessionId);
    expect(JSON.parse(second.content)).toEqual([
      'remember:nonsecret-history-marker', 'saved:nonsecret-history-marker', 'recall',
    ]);
    expect(shutdown).toHaveBeenCalledWith({ type: 'session_shutdown', reason: 'quit' });
    expect(dispose).toHaveBeenCalledOnce();
    expect(dispose.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(AgentSession.prototype.bindExtensions).mock.invocationCallOrder[1]!,
    );
  });

  function writeReplacementExtension(): string {
    const extensionPath = path.join(root, 'second-extension.js');
    writeFileSync(extensionPath, `export { default } from ${JSON.stringify(fixturePath)};`);
    return extensionPath;
  }

  it.each([false, true])('preserves history after a failed reconstruction (restore original: %s)', async (restoreOriginal) => {
    const first = await callPi('worker', 'remember:retry-marker', options);
    expect(first.status).toBe('done');
    const replacementOptions = {
      ...options,
      sessionId: first.sessionId,
      providerOptions: { ...options.providerOptions, extensions: [writeReplacementExtension()] },
    };
    vi.mocked(AgentSession.prototype.bindExtensions).mockRejectedValueOnce(new Error('temporary startup failure'));
    const failed = await callPi('worker', 'must not run', replacementOptions);
    expect(failed.status).toBe('error');
    const recovered = await callPi('worker', 'recall', restoreOriginal
      ? { ...options, sessionId: first.sessionId }
      : replacementOptions);
    expect(recovered.status).toBe('done');
    expect(recovered.sessionId).toBe(first.sessionId);
    expect(JSON.parse(recovered.content)).toEqual([
      'remember:retry-marker', 'saved:retry-marker', 'recall',
    ]);
    expect(sessions).toHaveLength(2);
  });

  it('blocks replacement when SDK shutdown handlers report an error without rejecting emit', async () => {
    const failingPath = path.join(root, 'shutdown-failure.js');
    writeFileSync(failingPath, `
import register from ${JSON.stringify(fixturePath)};
export default function extension(pi) {
  register(pi);
  pi.on('session_shutdown', () => { throw new Error('cleanup barrier failed'); });
}
`);
    const initial = { ...options, providerOptions: { ...options.providerOptions, extensions: [failingPath] } };
    const first = await callPi('worker', 'remember:shutdown-marker', initial);
    expect(first.status).toBe('done');
    const second = await callPi('worker', 'recall', {
      ...options, sessionId: first.sessionId,
    });
    expect(second).toMatchObject({ status: 'error', error: expect.stringContaining('cleanup barrier failed') });
    expect(await callPi('worker', 'must not reuse disposed runtime', {
      ...initial, sessionId: first.sessionId,
    })).toMatchObject({ status: 'error', error: expect.stringContaining('cleanup barrier failed') });
    expect(sessions).toHaveLength(1);
  });

  it('restores canonical context edits when a changed extension configuration rebuilds the runtime', async () => {
    const first = await callPi('worker', 'remember:original-marker', options);
    expect(first.status).toBe('done');
    const manager = sessions[0]!.sessionManager;
    const userEntry = manager.getEntries().find((entry) => entry.type === 'message' && entry.message.role === 'user');
    if (userEntry === undefined) throw new Error('Missing canonical user entry');
    manager.appendContextEdit(userEntry.id, { content: 'remember:edited-marker' });

    const second = await callPi('worker', 'recall', {
      ...options,
      sessionId: first.sessionId,
      providerOptions: { ...options.providerOptions, extensions: [writeReplacementExtension()] },
    });

    expect(second.status).toBe('done');
    expect(JSON.parse(second.content)).toEqual([
      'remember:edited-marker', 'saved:original-marker', 'recall',
    ]);
  });

  it('restores the default thinking level when an explicit level is removed during runtime replacement', async () => {
    const first = await callPi('worker', 'remember:thinking-marker', {
      ...options, providerOptions: { ...options.providerOptions, thinkingLevel: 'high' },
    });
    expect(first.status).toBe('done');
    expect(sessions[0]!.thinkingLevel).toBe('high');

    const second = await callPi('worker', 'recall', {
      ...options,
      sessionId: first.sessionId,
      providerOptions: { ...options.providerOptions, extensions: [writeReplacementExtension()] },
    });

    expect(second.status).toBe('done');
    expect(second.sessionId).toBe(first.sessionId);
    expect(sessions[1]!.thinkingLevel).toBe('medium');
    expect(JSON.parse(second.content)).toEqual([
      'remember:thinking-marker', 'saved:thinking-marker', 'recall',
    ]);
  });

  it.each([
    { mode: 'readonly', allowedTools: ['read'] },
    { mode: 'edit', allowedTools: ['read'] },
    { mode: 'full', allowedTools: ['orchestrator', 'allowed_probe', 'dynamic_probe'] },
  ] as const)('allows trusted nested calls and rejects excluded tools in $mode', async ({ mode, allowedTools }) => {
    const ambientPath = path.join(root, 'agent', 'extensions', 'ambient.js');
    mkdirSync(path.dirname(ambientPath), { recursive: true });
    writeFileSync(ambientPath, `
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
export default function register(pi) {
  for (const exposure of ['deferred', 'codemode']) {
    const name = 'ambient_' + exposure;
    pi.registerTool({ name, label: name, description: name, exposure,
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      async execute(id, params, signal, onUpdate, ctx) {
        appendFileSync(join(ctx.cwd, ${JSON.stringify(EXECUTION_FILE)}), name + '\\n');
        return { content: [{ type: 'text', text: name }], details: {} };
      }
    });
  }
}
`);

    const response = await callPi('worker', 'nested tools', {
      ...options,
      permissionMode: mode,
      allowedTools: [...allowedTools],
      providerOptions: { ...options.providerOptions, noExtensions: false },
    });

    expect(response.status).toBe('done');
    // Verify the excluded tools were actually loaded, so nonexecution is not vacuous.
    expect(sessions[0]!.getAllTools().map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'ambient_deferred', 'ambient_codemode', 'write', 'dynamic_probe',
    ]));
    expect(executions()).toEqual(['allowed_probe', 'dynamic_probe']);
    expect(JSON.parse(response.content)).toEqual({
      allowed_probe: false, dynamic_probe: false, write: true, ambient_deferred: true, ambient_codemode: true,
    });
  });

  it('preserves extension-selected tools in full mode without an allowlist', async () => {
    const response = await callPi('worker', 'selected tools', { ...options, permissionMode: 'full' });

    expect(response.status).toBe('done');
    expect(response.content).toBe('selected tool executed');
    expect(executions()).toEqual(['write']);
    expect(sessions[0]!.getActiveToolNames()).toEqual(['orchestrator', 'write']);
  });

  it.each([
    { label: 'empty', allowedTools: [] },
    { label: 'whitespace-only', allowedTools: ['', '   '] },
  ])('keeps $label deny-all after dynamic registration and direct permission changes', async ({ allowedTools }) => {
    const response = await callPi('worker', 'nested tools', { ...options, allowedTools });

    expect(response.status).toBe('done');
    expect(sessions[0]!.getAllTools().map((tool) => tool.name)).toContain('dynamic_probe');
    expect(sessions[0]!.getActiveToolNames()).toEqual([]);
    expect(executions()).toEqual([]);
  });

  it('does not load builtin MCP, codemode or tool search on the standard TAKT loader path', async () => {
    const extensions: Array<{ path: string; source: string }> = [];
    const originalGet = DefaultResourceLoader.prototype.getExtensions;
    vi.spyOn(DefaultResourceLoader.prototype, 'getExtensions').mockImplementation(function (this: DefaultResourceLoader) {
      const result = originalGet.call(this);
      extensions.push(...result.extensions.map((extension) => ({
        path: extension.path, source: extension.sourceInfo.source,
      })));
      return result;
    });

    const response = await callPi('worker', 'remember:loader-probe', options);

    expect(response.status).toBe('done');
    expect(extensions.some((extension) => path.resolve(extension.path) === fixturePath)).toBe(true);
    for (const extension of extensions) {
      expect(extension.source).not.toBe('builtin');
      expect(extension.path.startsWith('builtin:')).toBe(false);
    }
    for (const tool of sessions[0]!.getAllTools()) {
      if (['mcp', 'codemode', 'tool_search'].includes(tool.name)) {
        throw new Error(`Unexpected builtin tool: ${tool.name}`);
      }
    }
  });
});
