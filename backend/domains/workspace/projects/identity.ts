import { nativePathIdentity } from '../../../infrastructure/settings/sandbox.js';

export function sameProjectPath(left: string, right: string): boolean {
  return nativePathIdentity(left) === nativePathIdentity(right);
}
