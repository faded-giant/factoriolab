const API = 'https://api.github.com';

export interface GitHubConfig {
  owner: string;
  repo: string;
  token: string;
}

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }

  /** The file changed on GitHub since we last read it */
  get isConflict(): boolean {
    return this.status === 409 || this.status === 422;
  }
}

/** Path -> blob sha for every file in the repo */
export type RemoteTree = Record<string, string>;

export function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodeBase64(base64: string): string {
  const binary = atob(base64.replace(/\s/g, ''));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Minimal client for the GitHub REST API, using only the endpoints needed to
 * keep a repo of small JSON files in sync. Every write is a commit.
 */
export class GitHubClient {
  constructor(private readonly config: GitHubConfig) {}

  private get repoUrl(): string {
    const { owner, repo } = this.config;
    return `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  }

  private async request<T>(
    method: string,
    url: string,
    body?: unknown,
  ): Promise<T> {
    const response = await fetch(url, {
      method,
      cache: 'no-store',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.config.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: body == null ? undefined : JSON.stringify(body),
    });

    if (!response.ok) {
      let message = response.statusText;
      try {
        message = ((await response.json()) as { message: string }).message;
      } catch {
        // Keep status text
      }
      throw new GitHubError(response.status, message);
    }

    return (await response.json()) as T;
  }

  /** Checks that the token can reach the repo */
  async verify(): Promise<void> {
    await this.request('GET', this.repoUrl);
  }

  /** Lists all files in the default branch; an empty repo has no files */
  async getTree(): Promise<RemoteTree> {
    let result: {
      tree: { path: string; type: string; sha: string }[];
      truncated: boolean;
    };
    try {
      result = await this.request(
        'GET',
        `${this.repoUrl}/git/trees/HEAD?recursive=1`,
      );
    } catch (err) {
      // GitHub answers 409 for a repo without any commits yet
      if (err instanceof GitHubError && err.status === 409) return {};
      throw err;
    }

    if (result.truncated)
      throw new GitHubError(0, 'Repository too large to list');

    const tree: RemoteTree = {};
    for (const entry of result.tree)
      if (entry.type === 'blob') tree[entry.path] = entry.sha;

    return tree;
  }

  async getBlob(sha: string): Promise<string> {
    const result = await this.request<{ content: string }>(
      'GET',
      `${this.repoUrl}/git/blobs/${sha}`,
    );
    return decodeBase64(result.content);
  }

  /** Creates or updates a file, returning its new blob sha */
  async putFile(
    path: string,
    content: string,
    sha: string | undefined,
    message: string,
  ): Promise<string> {
    const result = await this.request<{ content: { sha: string } }>(
      'PUT',
      `${this.repoUrl}/contents/${encodePath(path)}`,
      { message, content: encodeBase64(content), sha },
    );
    return result.content.sha;
  }

  async deleteFile(path: string, sha: string, message: string): Promise<void> {
    await this.request(
      'DELETE',
      `${this.repoUrl}/contents/${encodePath(path)}`,
      { message, sha },
    );
  }
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}
