import { rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import {
  ensurePrivateDirectory,
  writeNewPrivateFileWithMode,
} from '../../shared/utils/private-file.js';
import type { DeepSeekCredentialBinding } from './credential-binding.js';

const PATCH_FILE_NAME = 'credentials.patch.yml';
const PATCH_DIRECTORY_PREFIX = 'takt-deepseek-credentials-';
const PATCH_FILE_MODE = 0o600;
const PATCH_CREATION_FAILURE_MESSAGE = 'DeepSeek Harness credentials patch could not be created';

export interface DeepSeekCredentialPatch {
  readonly path: string;
  dispose: () => Promise<void>;
  disposeSync: () => void;
}

/**
 * Build the process-owned patch that hands the official runtime the credential store
 * path and the reference name. The patch never contains a credential value.
 */
export async function createDeepSeekCredentialPatch(
  binding: DeepSeekCredentialBinding,
): Promise<DeepSeekCredentialPatch> {
  let patchDirectoryPath: string;
  try {
    patchDirectoryPath = await mkdtemp(path.join(os.tmpdir(), PATCH_DIRECTORY_PREFIX));
  } catch (error) {
    throw new Error(PATCH_CREATION_FAILURE_MESSAGE, { cause: error });
  }
  try {
    const patchPath = path.join(patchDirectoryPath, PATCH_FILE_NAME);
    const document = [
      { id: 'credentials', config: { path: binding.home.credentialsPath } },
      { id: 'llm-deepseek', config: { apiKeyEnv: binding.ref } },
    ];
    ensurePrivateDirectory(patchDirectoryPath);
    writeNewPrivateFileWithMode(patchPath, stringifyYaml(document), PATCH_FILE_MODE);
    let disposed = false;
    return {
      path: patchPath,
      dispose: async (): Promise<void> => {
        if (disposed) {
          return;
        }
        disposed = true;
        await rm(patchPath, { force: true });
        await rm(patchDirectoryPath, { recursive: true, force: true });
      },
      disposeSync: (): void => {
        if (disposed) {
          return;
        }
        disposed = true;
        rmSync(patchPath, { force: true });
        rmSync(patchDirectoryPath, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(patchDirectoryPath, { recursive: true, force: true });
    throw new Error(PATCH_CREATION_FAILURE_MESSAGE, { cause: error });
  }
}
