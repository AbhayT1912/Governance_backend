import { RepoModel } from "../models/repo.model";

export const requireRepoOwnership = async (req: any, res: any, next: any) => {
  const { repoId } = req.params;
  const userId = req.auth.userId;

  const repo = await RepoModel.findById(repoId);

  if (!repo) {
    return res.status(404).json({ message: "Repository not found" });
  }

  if (String(repo.owner_id) !== String(userId)) {
    return res.status(403).json({ message: "Forbidden" });
  }

  next();
};
