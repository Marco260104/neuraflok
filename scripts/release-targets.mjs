// Selects release artifacts for all supported platforms or common-platform canaries.
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ALWAYS = ['NEURAFLOK-Provider-Extension.zip', 'NEURAFLOK-Native-Sources.tar.gz'];

export function releaseTargets(platforms = 'all', targets = JSON.parse(readFileSync(new URL('../.github/release-targets.json', import.meta.url), 'utf8'))) {
  if (platforms !== 'all' && platforms !== 'common') throw new Error(`platforms must be all or common, got ${platforms}`);
  const chosen = targets.filter(target => platforms === 'all' || target.common === true);
  return {
    include: chosen.map(({ common, files, ...target }) => ({ ...target, files: files.map(file => `release/${file}`).join('\n') })),
    files: [...chosen.flatMap(target => target.files), ...ALWAYS]
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { include, files } = releaseTargets(process.argv[2] || 'all');
  const output = `include=${JSON.stringify(include)}\nfiles=${files.join(' ')}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  process.stdout.write(output);
}
