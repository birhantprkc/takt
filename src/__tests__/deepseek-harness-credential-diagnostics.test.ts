import { describe, expect, it } from 'vitest';
import {
  buildCredentialDiagnostic,
  classifyDeepSeekRuntimeCredentialFailure,
  DEEPSEEK_CREDENTIAL_DIAGNOSTIC_CLASSIFICATIONS,
  type DeepSeekCredentialDiagnosticContext,
} from '../infra/deepseek-harness/credential-diagnostics.js';

const MISSING_CREDENTIAL_FAILURE = 'MISSING_CREDENTIAL: llm-deepseek: no API key for provider route '
  + '"deepseek-official"; store DEEPSEEK_API_KEY through the credentials service '
  + '(the web Models page writes it), or export DEEPSEEK_API_KEY in the launching environment';
const INVALID_STORE_FAILURE = 'DeepSeek Harness jsonrpc-error: failed to apply loader entry credentials '
  + '(@deepseek-ai/dsh-credentials-local): credentials-local: invalid document at '
  + '/private/tmp/example/.credentials.yaml: BAD_INDENT at line 3, column 1';
const AUTH_REJECTED_FAILURE = 'AUTH: rejected dummy-echoed-credential-value';

function createContext(
  overrides: Partial<DeepSeekCredentialDiagnosticContext> = {},
): DeepSeekCredentialDiagnosticContext {
  return {
    classification: 'missing-credential',
    sourceHomeOrigin: 'environment',
    reference: 'DEEPSEEK_API_KEY',
    ...overrides,
  };
}

function expectSafeDiagnostic(message: string): void {
  expect(message.trim().length).toBeGreaterThan(0);
  expect(message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
  expect(message).not.toMatch(/https?:\/\//iu);
  expect(message).not.toMatch(/\/(?:Users|home|private|tmp|var)\//u);
}

describe('DeepSeek Harness runtime credential failure classification', () => {
  it.each([
    ['a coded missing-credential failure', MISSING_CREDENTIAL_FAILURE, 'missing-credential'],
    [
      'an uncoded missing-credential message',
      'llm-deepseek: no API key for provider route "deepseek-official"; store DEEPSEEK_API_KEY '
      + 'through the credentials service (the web Models page writes it), or export DEEPSEEK_API_KEY '
      + 'in the launching environment',
      'missing-credential',
    ],
    ['an invalid store document failure', INVALID_STORE_FAILURE, 'invalid-store'],
    ['an auth rejection failure', AUTH_REJECTED_FAILURE, 'auth-rejected'],
  ] as const)('classifies %s', (_label, failure, expected) => {
    expect(classifyDeepSeekRuntimeCredentialFailure(failure)).toBe(expected);
  });

  it.each([
    ['an unrelated transport failure', 'DeepSeek Harness bridge transport closed'],
    ['an empty failure', ''],
  ] as const)('keeps %s unclassified', (_label, failure) => {
    expect(classifyDeepSeekRuntimeCredentialFailure(failure)).toBe('unknown');
  });
});

describe('DeepSeek Harness credential diagnostics', () => {
  it.each(['settings-unreadable', 'settings-too-large', 'invalid-settings', 'invalid-selector', 'invalid-stored-endpoint'] as const)(
    'marks the reference unresolved after %s before selector resolution', (classification) => {
      const message = buildCredentialDiagnostic({ classification, sourceHomeOrigin: 'environment' });
      expect(message).toContain('Reference: unresolved');
      expect(message).not.toContain('DEEPSEEK_API_KEY');
      expectSafeDiagnostic(message);
    },
  );

  it('does not recommend exporting an invented reference when unresolved', () => {
    const message = buildCredentialDiagnostic({ classification: 'missing-credential', sourceHomeOrigin: 'default' });
    expect(message).toContain('Reference: unresolved');
    expect(message).not.toContain('export');
    expect(message).not.toContain('DEEPSEEK_API_KEY');
  });

  it('does not invent a default reference for an invalid selector', () => {
    const message = buildCredentialDiagnostic(createContext({
      classification: 'invalid-selector', reference: 'invalid-secret\nselector',
    }));
    expect(message).toContain('Reference: unresolved');
    expect(message).not.toContain('DEEPSEEK_API_KEY');
    expect(message).not.toContain('invalid-secret');
    expectSafeDiagnostic(message);
  });

  it.each([...DEEPSEEK_CREDENTIAL_DIAGNOSTIC_CLASSIFICATIONS])(
    'builds a safe diagnostic for the %s classification',
    (classification) => {
      const message = buildCredentialDiagnostic(createContext({ classification }));

      expectSafeDiagnostic(message);
      expect(message).toContain('DEEPSEEK_API_KEY');
    },
  );

  it.each(['environment', 'child-process-env'] as const)(
    'names the %s origin as the DSH_HOME environment variable',
    (sourceHomeOrigin) => {
      const message = buildCredentialDiagnostic(createContext({ sourceHomeOrigin }));

      expect(message).toContain('DSH_HOME');
      expect(message).not.toContain('~/.dsh');
    },
  );

  it('names the default origin as the harness default home', () => {
    const message = buildCredentialDiagnostic(createContext({
      sourceHomeOrigin: 'default',
      classification: 'missing-credential',
    }));

    expect(message).toContain('~/.dsh');
  });

  it('tells the user how to repair a missing credential through the store or the environment', () => {
    const message = buildCredentialDiagnostic(createContext({ classification: 'missing-credential' }));

    expect(message).toMatch(/Settings|credentials service/iu);
    expect(message).toMatch(/export/iu);
  });

  it('tells the user which settings selector to repair', () => {
    const message = buildCredentialDiagnostic(createContext({
      classification: 'invalid-selector',
      reference: 'MY_KEY',
    }));

    expect(message).toContain('MY_KEY');
    expect(message).toMatch(/settings\.yaml|apiKeyEnv/iu);
  });

  it('tells the user to align the base URL for an endpoint mismatch', () => {
    const message = buildCredentialDiagnostic(createContext({ classification: 'endpoint-mismatch' }));

    expect(message).toMatch(/base ?url|endpoint/iu);
    expect(message).toMatch(/DEEPSEEK_BASE_URL|deepseek_harness|provider_options/iu);
  });

  it('tells the user to start a new run for a binding change', () => {
    const message = buildCredentialDiagnostic(createContext({ classification: 'binding-changed' }));

    expect(message).toMatch(/binding/iu);
    expect(message).toMatch(/new (run|session)/iu);
  });

  it('keeps an auth rejection diagnostic free of raw provider output', () => {
    const message = buildCredentialDiagnostic(createContext({ classification: 'auth-rejected' }));

    expectSafeDiagnostic(message);
    expect(message).not.toContain('dummy-echoed-credential-value');
    expect(message).not.toContain('rejected');
  });
});
