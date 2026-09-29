import { describeDeepSeekCredentialHomeOrigin, type DeepSeekCredentialHomeOrigin } from './credential-home.js';
import { isValidDeepSeekCredentialReference } from './credential-settings.js';

export type DeepSeekCredentialFailureClassification =
  | 'missing-credential'
  | 'invalid-store'
  | 'invalid-selector'
  | 'endpoint-mismatch'
  | 'invalid-effective-endpoint'
  | 'auth-rejected'
  | 'binding-changed'
  | 'runtime-failure'
  | 'settings-unreadable'
  | 'settings-too-large'
  | 'invalid-settings'
  | 'invalid-stored-endpoint';

export type DeepSeekRuntimeCredentialFailureClassification =
  | 'missing-credential'
  | 'invalid-store'
  | 'auth-rejected'
  | 'unknown';

export const DEEPSEEK_CREDENTIAL_DIAGNOSTIC_CLASSIFICATIONS: readonly DeepSeekCredentialFailureClassification[] = [
  'missing-credential',
  'invalid-store',
  'invalid-selector',
  'endpoint-mismatch',
  'invalid-effective-endpoint',
  'auth-rejected',
  'binding-changed',
  'runtime-failure',
  'settings-unreadable',
  'settings-too-large',
  'invalid-settings',
  'invalid-stored-endpoint',
];

export interface DeepSeekCredentialDiagnosticContext {
  classification: DeepSeekCredentialFailureClassification;
  sourceHomeOrigin: DeepSeekCredentialHomeOrigin;
  reference?: string | undefined;
}

const CLASSIFICATION_DETAILS: Record<
  DeepSeekCredentialFailureClassification,
  (reference: string | undefined) => string
> = {
  'missing-credential': (reference) => reference === undefined
    ? 'Resolve the settings.yaml credential selector before configuring its store entry or environment variable.'
    : 'No stored credential resolved for this reference: save the key '
    + 'in the DeepSeek Harness Settings Models page (the credentials service writes it) '
    + `or export ${reference} in the launching environment.`,
  'invalid-store': () => 'The credential store for this reference could not be read: '
    + 'repair or recreate it with the DeepSeek Harness credentials service, then retry.',
  'invalid-selector': () => 'The settings.yaml selector llm-deepseek.apiKeyEnv is invalid: '
    + 'set it to the environment variable name to resolve or remove it from settings.yaml.',
  'endpoint-mismatch': () => 'The stored llm-deepseek.baseURL disagrees with the effective endpoint: '
    + 'align DEEPSEEK_BASE_URL, the deepseek_harness provider option base_url, or the stored baseURL.',
  'auth-rejected': () => 'The provider refused this credential: '
    + 'verify the saved credential and the endpoint, then save a valid key.',
  'binding-changed': () => 'The credential binding (DSH_HOME source home, reference, or endpoint) '
    + 'changed during this session: start a new run or session to use the changed binding.',
  'runtime-failure': () => 'The provider bridge/SDK failed. Verify the selected credential, endpoint, '
    + 'runtime installation and connectivity, then retry. Upstream error details are withheld.',
  'settings-unreadable': () => 'The settings.yaml file could not be read. Check its permissions and file type.',
  'settings-too-large': () => 'The settings.yaml file exceeds 1 MiB. Reduce its size before retrying.',
  'invalid-settings': () => 'The settings.yaml document is invalid. Correct its YAML syntax, types, '
    + 'duplicate keys or unsupported tags before retrying.',
  'invalid-effective-endpoint': () => 'The effective endpoint must be an absolute http(s) URL without userinfo. '
    + 'Correct DEEPSEEK_BASE_URL or the deepseek_harness provider option base_url.',
  'invalid-stored-endpoint': () => 'The settings.yaml llm-deepseek.baseURL must be an absolute http(s) URL without userinfo. '
    + 'Correct or remove that field before retrying.',
};

function safeReference(reference: string | undefined): string | undefined {
  return isValidDeepSeekCredentialReference(reference)
    ? reference
    : undefined;
}

/** Build a classified, secret-free diagnostic in the existing provider error format. */
export function buildCredentialDiagnostic(context: DeepSeekCredentialDiagnosticContext): string {
  const reference = safeReference(context.reference);
  const origin = describeDeepSeekCredentialHomeOrigin(context.sourceHomeOrigin);
  const detail = CLASSIFICATION_DETAILS[context.classification](reference);
  return `DeepSeek Harness credential resolution failed. Credential source: ${origin}. `
    + `Reference: ${reference ?? 'unresolved (settings.yaml could not be applied)'}. ${detail}`;
}

/**
 * Classify a failure reported by the official runtime. Only patterns observed from
 * the pinned runtime are classified; anything else stays unknown so the caller
 * emits a fixed failure diagnostic without exposing upstream text.
 */
export function classifyDeepSeekRuntimeCredentialFailure(
  failure: string,
): DeepSeekRuntimeCredentialFailureClassification {
  if (typeof failure !== 'string' || failure.length === 0) {
    return 'unknown';
  }
  if (/MISSING_CREDENTIAL/u.test(failure) || /no API key for provider route/iu.test(failure)) {
    return 'missing-credential';
  }
  if (
    /invalid document/iu.test(failure)
    || /failed to apply loader entry credentials/iu.test(failure)
  ) {
    return 'invalid-store';
  }
  if (/(?:^|[^A-Za-z])AUTH(?:[^A-Za-z]|$)/u.test(failure)) {
    return 'auth-rejected';
  }
  return 'unknown';
}

/** Carry a safe classification from the resolution boundary to the failure formatter. */
export class DeepSeekCredentialDiagnosticError extends Error {
  readonly classification: DeepSeekCredentialFailureClassification;
  readonly sourceHomeOrigin: DeepSeekCredentialHomeOrigin | undefined;
  readonly reference: string | undefined;

  constructor(
    classification: DeepSeekCredentialFailureClassification,
    message: string,
    context: { sourceHomeOrigin?: DeepSeekCredentialHomeOrigin; reference?: string } = {},
  ) {
    super(message);
    this.name = 'DeepSeekCredentialDiagnosticError';
    this.classification = classification;
    this.sourceHomeOrigin = context.sourceHomeOrigin;
    this.reference = context.reference;
  }
}
