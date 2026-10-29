import * as path from "node:path";
import mongoose from "mongoose";
import { FileModel } from "../models/file.model";
import { ImportModel } from "../models/import.model";

interface FileNode {
  id: string;
  path: string;
  language: string;
  size: number;
}

interface FileEdge {
  from: string;
  to: string;
}

function normalizeFilePath(filePath: string) {
  return filePath
    .replace(/\\/g, "/")
    .replace(/\.(tsx?|jsx?)$/i, "")
    .replace(/\/index$/i, "")
    .toLowerCase();
}

function buildPathLookup(files: FileNode[]) {
  const lookup = new Map<string, string>();

  for (const file of files) {
    const normalized = normalizeFilePath(file.path);
    lookup.set(normalized, file.id);
  }

  return lookup;
}

function resolveImportTarget(
  sourcePath: string,
  importerPath: string,
  lookup: Map<string, string>
) {
  if (!sourcePath.startsWith(".")) {
    return null;
  }

  const importerDir = path.posix.dirname(importerPath.replace(/\\/g, "/"));
  const resolved = path.posix.normalize(
    path.posix.join(importerDir, sourcePath.replace(/\\/g, "/"))
  );
  const normalizedResolved = normalizeFilePath(resolved);

  return (
    lookup.get(normalizedResolved) ??
    lookup.get(`${normalizedResolved}/index`) ??
    null
  );
}

export async function buildRepoDependencyGraph(
  repoId: mongoose.Types.ObjectId
) {
  const [files, imports] = await Promise.all([
    FileModel.find({ repo_id: repoId }).lean(),
    ImportModel.find({ repo_id: repoId }).lean(),
  ]);

  const nodes: FileNode[] = files.map((file) => ({
    id: file._id.toString(),
    path: file.path,
    language: file.language,
    size: file.size,
  }));

  const fileById = new Map(nodes.map((node) => [node.id, node]));
  const lookup = buildPathLookup(nodes);
  const edgeSet = new Set<string>();
  const edges: FileEdge[] = [];
  let externalDependencyCount = 0;

  for (const imp of imports) {
    if (!imp.file_id || !imp.source) {
      continue;
    }

    if (imp.is_external) {
      externalDependencyCount += 1;
      continue;
    }

    const from = imp.file_id.toString();
    const importer = fileById.get(from);

    if (!importer) {
      continue;
    }

    const to = resolveImportTarget(imp.source, importer.path, lookup);
    if (!to || to === from) {
      continue;
    }

    const edgeKey = `${from}->${to}`;
    if (edgeSet.has(edgeKey)) {
      continue;
    }

    edgeSet.add(edgeKey);
    edges.push({ from, to });
  }

  return {
    nodes,
    edges,
    fileById,
    externalDependencyCount,
  };
}
