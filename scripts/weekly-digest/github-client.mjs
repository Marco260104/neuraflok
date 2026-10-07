const API_ROOT = 'https://api.github.com';

export function createGitHubClient(token, fetchRequest = globalThis.fetch) {
  async function request(endpoint, options = {}) {
    const response = await fetchRequest(`${API_ROOT}${endpoint}`, {
      ...options,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'neuraflok-weekly-digest',
        ...(options.headers ?? {})
      }
    });
    if (!response.ok) throw new Error(`GitHub ${endpoint} failed with HTTP ${response.status}`);
    return response.json();
  }

  return {
    get: endpoint => request(endpoint),
    post: (endpoint, payload) => request(endpoint, { method: 'POST', body: JSON.stringify(payload) }),
    patch: (endpoint, payload) => request(endpoint, { method: 'PATCH', body: JSON.stringify(payload) })
  };
}
