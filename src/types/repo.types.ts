export type RepoStatus =
  | "RECEIVED"
  | "CLONING"
  | "SCANNING"
  | "PARSING"
  | "GRAPHING"
  | "INDEXING"
  | "READY"
  | "FAILED";

export interface RepoLifecycle {
  id: string;
  repo_url: string;
  status: RepoStatus;
  error_message?: string;
}
