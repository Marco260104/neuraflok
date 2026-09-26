import type { ProjectGitChanged } from '../../../../contracts/workspace/project-git.js';
import { readRepositoryContext } from './repository.js';
import { ProjectGitWatchSetCore, type ProjectGitWatchFactory } from './watch.js';

export { readProjectGitSnapshot } from './snapshot.js';
export { readProjectGitDiff } from './diff.js';
export { gitExecutable } from './process.js';
export type { ProjectGitWatchFactory } from './watch.js';

export class ProjectGitWatchSet extends ProjectGitWatchSetCore {
  constructor(changed: (event: ProjectGitChanged) => void, watchFactory?: ProjectGitWatchFactory) {
    super(changed, readRepositoryContext, watchFactory);
  }
}
