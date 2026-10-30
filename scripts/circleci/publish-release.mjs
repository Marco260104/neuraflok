import https from 'node:https';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { releaseTargets } from '../release-targets.mjs';
import { verifyReleaseAssets } from '../verify-release-assets.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const API = 'https://api.github.com';
const USER_AGENT = 'NEURAFLOK-CircleCI-release';

function requestJson(url, { token, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const request = https.request(target, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': USER_AGENT,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {})
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { /* surfaced with the HTTP error below */ }
        resolve({ status: response.statusCode ?? 0, data, text });
      });
    });
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

function uploadFile(url, { token, file }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    target.searchParams.set('name', path.basename(file));
    const request = https.request(target, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/octet-stream',
        'Content-Length': statSync(file).size
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode !== 201) {
          reject(new Error(`GitHub asset upload for ${path.basename(file)} failed with HTTP ${response.statusCode}: ${text.slice(0, 500)}`));
          return;
        }
        try { resolve(JSON.parse(text)); }
        catch { reject(new Error(`GitHub returned invalid upload metadata for ${path.basename(file)}.`)); }
      });
    });
    request.on('error', reject);
    createReadStream(file).on('error', reject).pipe(request);
  });
}

async function apiOrThrow(url, options, expectedStatuses, fetchJson) {
  const response = await fetchJson(url, options);
  if (!expectedStatuses.includes(response.status)) {
    const detail = String(response.data?.message || response.text || '').replace(/\s+/g, ' ').slice(0, 500);
    throw new Error(`GitHub API ${options?.method || 'GET'} ${url} returned HTTP ${response.status}${detail ? `: ${detail}` : ''}.`);
  }
  return response;
}

export async function publishStableRelease({
  repository,
  tag,
  token,
  releaseDir = path.join(root, 'release'),
  projectRoot = root,
  fetchJson = requestJson,
  upload = uploadFile,
  verifyAssets = verifyReleaseAssets,
  apiBase = API
} = {}) {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository ?? '')) throw new Error('NEURAFLOK_REPOSITORY must be owner/repository.');
  if (!/^v\d+\.\d+\.\d+$/.test(tag ?? '')) throw new Error(`Expected a vX.Y.Z release tag, got ${tag || '(missing)'}.`);
  if (!token) throw new Error('Set GH_TOKEN in the CircleCI release context.');

  const problems = await verifyAssets({ dir: releaseDir, tag });
  if (problems.length) throw new Error(problems.join('\n'));
  const assetNames = [...releaseTargets('all').files, 'SHA256SUMS.txt'];
  const missing = assetNames.filter(name => !existsSync(path.join(releaseDir, name)));
  if (missing.length) throw new Error(`Release assets are missing: ${missing.join(', ')}.`);

  const base = `${apiBase}/repos/${repository}`;
  const lookup = await fetchJson(`${base}/releases/tags/${encodeURIComponent(tag)}`, { token });
  if (lookup.status === 200) throw new Error(`Release ${tag} already exists; refusing to replace it.`);
  if (lookup.status !== 404) throw new Error(`Release lookup returned HTTP ${lookup.status}; refusing to publish.`);

  const notes = await readFile(path.join(projectRoot, 'docs', 'release-notes', `${tag}.md`), 'utf8');
  const created = await fetchJson(`${base}/releases`, {
    token,
    method: 'POST',
    body: { tag_name: tag, name: `NEURAFLOK ${tag.slice(1)}`, body: notes, draft: true, prerelease: false }
  });
  if (created.status !== 201 || !created.data?.id || !created.data?.upload_url) {
    throw new Error(`Could not create the draft release for ${tag} (HTTP ${created.status}).`);
  }

  const release = created.data;
  try {
    const uploadBase = release.upload_url.replace(/\{\?.*$/, '');
    for (const name of assetNames) {
      await upload(uploadBase, { token, file: path.join(releaseDir, name) });
      process.stdout.write(`Uploaded ${name}\n`);
    }

    const listed = await apiOrThrow(`${base}/releases/${release.id}/assets?per_page=100`, { token }, [200], fetchJson);
    const byName = new Map((listed.data || []).map(asset => [asset.name, asset]));
    const mismatches = assetNames.filter(name => byName.get(name)?.size !== statSync(path.join(releaseDir, name)).size);
    const unexpected = [...byName.keys()].filter(name => !assetNames.includes(name));
    if (mismatches.length || unexpected.length || byName.size !== assetNames.length) {
      throw new Error(`Uploaded release asset verification failed. Missing or wrong-size: ${mismatches.join(', ') || '(none)'}; unexpected: ${unexpected.join(', ') || '(none)'}.`);
    }

    const published = await apiOrThrow(`${base}/releases/${release.id}`, {
      token,
      method: 'PATCH',
      body: { draft: false, prerelease: false, name: `NEURAFLOK ${tag.slice(1)}` }
    }, [200], fetchJson);
    process.stdout.write(`Published ${published.data.html_url}\n`);
    return published.data;
  } catch (error) {
    const deleted = await fetchJson(`${base}/releases/${release.id}`, { token, method: 'DELETE' }).catch(() => ({ status: 0 }));
    if (deleted.status !== 204) process.stderr.write(`The incomplete draft release ${tag} could not be removed automatically.\n`);
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  publishStableRelease({
    repository: process.env.NEURAFLOK_REPOSITORY || 'Marco260104/neuraflok',
    tag: process.env.CIRCLE_TAG || process.env.TAG,
    token: process.env.GH_TOKEN
  }).catch(error => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
