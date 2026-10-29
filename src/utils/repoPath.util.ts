import path from "path";
import { ENV } from "../config/env";

export const getRepoPath = (repoId: string) => {
  const basePath = path.isAbsolute(ENV.TEMP_DIR_PATH)
    ? ENV.TEMP_DIR_PATH
    : path.join(process.cwd(), ENV.TEMP_DIR_PATH);

  return path.join(basePath, repoId);
};
