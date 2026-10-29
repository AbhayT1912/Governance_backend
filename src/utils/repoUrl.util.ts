export const normalizeRepoUrl = (url: string): string => {
  let normalized = url.trim().toLowerCase();

  // Remove trailing slash
  if (normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }

  // Remove .git
  if (normalized.endsWith(".git")) {
    normalized = normalized.slice(0, -4);
  }

  return normalized;
};

export const validateGithubRepoUrl = (url: string): boolean => {
  if (!url) return false;

  // Length limit
  if (url.length > 200) return false;

  // Strict GitHub HTTPS format only
  const githubRegex =
    /^https:\/\/github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/;

  return githubRegex.test(url);
};