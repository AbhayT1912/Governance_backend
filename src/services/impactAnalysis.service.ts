// src/services/impactAnalysis.service.ts

interface Edge {
  from: string;
  to: string;
}

interface ImpactMetrics {
  impacted_files: string[];
  impact_depth: number;
  impact_count: number;
  fan_in: number;
  fan_out: number;
  severity_score: number;
}

interface ImpactAnalysisResult {
  file_id: string;
  metrics: ImpactMetrics;
  dependency_tree: any;
}

function buildGraphs(edges: Edge[]) {
  const forward: Record<string, string[]> = {};
  const reverse: Record<string, string[]> = {};

  for (const { from, to } of edges) {
    if (!forward[from]) forward[from] = [];
    forward[from].push(to);

    if (!forward[to]) forward[to] = [];

    if (!reverse[to]) reverse[to] = [];
    reverse[to].push(from);

    if (!reverse[from]) reverse[from] = [];
  }

  return { forward, reverse };
}

function buildDependencyTree(
  node: string,
  reverse: Record<string, string[]>,
  visited = new Set<string>()
): any {
  if (visited.has(node)) return null;
  visited.add(node);

  return {
    file: node,
    dependents: (reverse[node] || [])
      .map(child => buildDependencyTree(child, reverse, visited))
      .filter(Boolean),
  };
}

function traverseImpact(
  start: string,
  reverse: Record<string, string[]>
) {
  const visited = new Set<string>();
  let maxDepth = 0;

  function dfs(node: string, depth: number) {
    if (visited.has(node)) return;
    visited.add(node);
    maxDepth = Math.max(maxDepth, depth);

    for (const neighbor of reverse[node] || []) {
      dfs(neighbor, depth + 1);
    }
  }

  dfs(start, 0);
  visited.delete(start);

  return {
    impacted_files: Array.from(visited),
    impact_depth: maxDepth,
    impact_count: visited.size,
  };
}

function calculateSeverity(
  impact_count: number,
  impact_depth: number,
  fan_in: number,
  fan_out: number
) {
  let score =
    impact_count * impact_depth +
    fan_out * 2 +
    fan_in * 1.5;

  if (score > 100) score = 100;

  return Number(score.toFixed(2));
}

export function analyzeFullImpact(
  fileId: string,
  edges: Edge[]
): ImpactAnalysisResult {

  const { forward, reverse } = buildGraphs(edges);

  const impact = traverseImpact(fileId, reverse);

  const fan_out = (forward[fileId] || []).length;
  const fan_in = (reverse[fileId] || []).length;

  const severity_score = calculateSeverity(
    impact.impact_count,
    impact.impact_depth,
    fan_in,
    fan_out
  );

  const dependency_tree = buildDependencyTree(fileId, reverse);

  return {
    file_id: fileId,
    metrics: {
      ...impact,
      fan_in,
      fan_out,
      severity_score,
    },
    dependency_tree,
  };
}

export function rankFilesByRisk(edges: Edge[]) {
  const { forward, reverse } = buildGraphs(edges);

  const allFiles = new Set([
    ...Object.keys(forward),
    ...Object.keys(reverse),
  ]);

  const ranking: any[] = [];

  for (const file of allFiles) {
    const impact = traverseImpact(file, reverse);

    const fan_out = (forward[file] || []).length;
    const fan_in = (reverse[file] || []).length;

    const severity_score = calculateSeverity(
      impact.impact_count,
      impact.impact_depth,
      fan_in,
      fan_out
    );

    ranking.push({
      file_id: file,
      severity_score,
      impact_count: impact.impact_count,
      fan_in,
      fan_out,
    });
  }

  ranking.sort((a, b) => b.severity_score - a.severity_score);

  return ranking;
}