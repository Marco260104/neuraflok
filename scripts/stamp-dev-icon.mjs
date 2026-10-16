// Stamp the authored NEURAFLOK mark onto a private Electron dist so `npm run dev` does not show Electron's stock icon.
// electron-vite 5 launches ELECTRON_EXEC_PATH (or node_modules/electron/dist from path.txt). It ignores
// ELECTRON_OVERRIDE_DIST_PATH, which only require('electron') honors.
// rcedit reports success but leaves Electron's RT_GROUP_ICON in place for this ICO; resedit rewrites the PE resource.

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stampOnly = process.argv.includes('--stamp-only');
const passthrough = process.argv.slice(2).filter((arg) => arg !== '--stamp-only');
const ico = path.join(root, 'build', 'icon.ico');
if (!existsSync(ico)) {
  execFileSync(process.execPath, [path.join(root, 'scripts', 'make-icon.mjs')], { stdio: 'inherit', cwd: root });
}

const require = createRequire(import.meta.url);
const electronExe = require('electron');
const electronDist = path.dirname(electronExe);
const brandedDist = path.join(root, '.dev-electron');
const brandedExe = path.join(brandedDist, 'NEURAFLOK.exe');
const stampPath = path.join(brandedDist, '.neuraflok-icon-stamp');
const electronVersion = JSON.parse(readFileSync(require.resolve('electron/package.json'), 'utf8')).version;
const digest = `v3-resedit\n${electronVersion}\n${createHash('sha256').update(readFileSync(ico)).digest('hex')}`;

function stampBrandedExe() {
  const ResEdit = require('resedit');
  const PELibrary = require('pe-library');
  const exe = PELibrary.NtExecutable.from(readFileSync(electronExe));
  const resources = PELibrary.NtExecutableResource.from(exe);
  const iconFile = ResEdit.Data.IconFile.from(readFileSync(ico));
  const icons = iconFile.icons.filter((item) => item.data.isIcon()).map((item) => item.data);
  if (icons.length === 0) throw new Error('build/icon.ico has no BMP frames for the Windows executable');
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries);
  const targets = groups.length > 0 ? groups : [{ id: 1, lang: 1033 }];
  for (const group of targets) {
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(resources.entries, group.id, group.lang, icons);
  }
  const versions = ResEdit.Resource.VersionInfo.fromEntries(resources.entries);
  if (versions[0]) {
    versions[0].setStringValues({ lang: 1033, codepage: 1200 }, {
      FileDescription: 'NEURAFLOK',
      ProductName: 'NEURAFLOK',
      InternalName: 'NEURAFLOK',
      OriginalFilename: 'NEURAFLOK.exe',
      CompanyName: 'NEURAFLOK contributors'
    });
    versions[0].outputToResourceEntries(resources.entries);
  }
  resources.outputResource(exe);
  mkdirSync(brandedDist, { recursive: true });
  writeFileSync(brandedExe, Buffer.from(exe.generate()));
}

function hasElectronRuntime(dir) {
  return ['ffmpeg.dll', 'icudtl.dat'].every((name) => existsSync(path.join(dir, name)));
}

if (process.platform === 'win32') {
  const stamped = existsSync(stampPath) && readFileSync(stampPath, 'utf8') === digest && existsSync(brandedExe);
  if (!stamped) {
    mkdirSync(brandedDist, { recursive: true });
    if (!hasElectronRuntime(brandedDist)) {
      cpSync(electronDist, brandedDist, {
        recursive: true,
        filter: (source) => path.basename(source).toLowerCase() !== 'electron.exe'
      });
    }
    stampBrandedExe();
    writeFileSync(stampPath, digest);
  }
  process.env.ELECTRON_EXEC_PATH = brandedExe;
  process.stdout.write(`NEURAFLOK dev Electron: ${brandedExe}\n`);
}

if (stampOnly) process.exit(0);

const electronVite = path.join(path.dirname(require.resolve('electron-vite/package.json')), 'bin', 'electron-vite.js');
const child = spawn(process.execPath, [electronVite, 'dev', ...passthrough], {
  stdio: 'inherit',
  cwd: root,
  env: process.env
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
