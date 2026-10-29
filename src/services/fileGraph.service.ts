// src/services/fileGraph.service.ts

import { arch } from "node:os";

interface Edge {
  from: string;
  to: string;
}

interface FileGraph {
  adj: Record<string, string[]>;
}

/* ===============================
   BUILD ADJACENCY LIST
================================ */
function buildAdjacency(edges: Edge[]): FileGraph {
  const adj: Record<string, string[]> = {};

  for (const { from, to } of edges) {
    if (!adj[from]) adj[from] = [];
    adj[from].push(to);

    if (!adj[to]) adj[to] = [];
  }

  return { adj };
}

/* ===============================
   TARJAN SCC (Strongly Connected Components)
================================ */
function findStronglyConnectedComponents(graph: FileGraph) {
  let index = 0;
  const stack: string[] = [];
  const indices: Record<string, number> = {};
  const lowlink: Record<string, number> = {};
  const onStack: Record<string, boolean> = {};
  const sccs: string[][] = [];

  function strongConnect(node: string) {
    indices[node] = index;
    lowlink[node] = index;
    index++;

    stack.push(node);
    onStack[node] = true;

    for (const neighbor of graph.adj[node] || []) {
      if (indices[neighbor] === undefined) {
        strongConnect(neighbor);
        lowlink[node] = Math.min(lowlink[node], lowlink[neighbor]);
      } else if (onStack[neighbor]) {
        lowlink[node] = Math.min(lowlink[node], indices[neighbor]);
      }
    }

    if (lowlink[node] === indices[node]) {
      const component: string[] = [];
      let w: string | undefined;

      do {
        w = stack.pop();
        if (!w) break;
        onStack[w] = false;
        component.push(w);
      } while (w !== node);

      sccs.push(component);
    }
  }

  for (const node of Object.keys(graph.adj)) {
    if (indices[node] === undefined) {
      strongConnect(node);
    }
  }

  return sccs;
}

/* ===============================
   CIRCULAR DEPENDENCY ANALYSIS
================================ */
function extractCycles(sccs: string[][]) {
  return sccs.filter(component => component.length > 1);
}

function analyzeCycles(cycles: string[][], graph: FileGraph) {
  return cycles.map(cycle => {
    let totalEdges = 0;

    for (const node of cycle) {
      totalEdges += (graph.adj[node] || []).length;
    }

    const severityScore = cycle.length * totalEdges;

    return {
      nodes: cycle,
      size: cycle.length,
      total_internal_edges: totalEdges,
      severity_score: severityScore,
    };
  });
}

/* ===============================
   GRAPH METRICS
================================ */
function calculateGraphMetrics(
  graph: FileGraph,
  cycles: string[][]
) {
  const totalNodes = Object.keys(graph.adj).length;

  const totalEdges = Object.values(graph.adj).reduce(
    (sum, neighbors) => sum + neighbors.length,
    0
  );

  const largestCycle = cycles.reduce(
    (max, cycle) => Math.max(max, cycle.length),
    0
  );

  return {
    total_files: totalNodes,
    total_dependencies: totalEdges,
    total_cycles: cycles.length,
    largest_cycle_size: largestCycle,
    average_dependencies_per_file:
      totalNodes > 0 ? totalEdges / totalNodes : 0,
  };
}

function calculateArchitectureHealthScore(
  totalFiles: number,
  totalDependencies: number,
  cycles: any[]
) {
  const totalCycles = cycles.length;

  const largestCycleSize = cycles.reduce(
    (max, c) => Math.max(max, c.size),
    0
  );

  const severitySum = cycles.reduce(
    (sum, c) => sum + c.severity_score,
    0
  );

  const density =
    totalFiles > 0 ? totalDependencies / totalFiles : 0;

  const cyclePenalty = Math.min(30, totalCycles * 5);
  const largestCyclePenalty = Math.min(20, largestCycleSize * 3);
  const densityPenalty = Math.min(25, density * 5);
  const severityPenalty = Math.min(25, severitySum / 10);

  let score =
    100 -
    cyclePenalty -
    largestCyclePenalty -
    densityPenalty -
    severityPenalty;

  if (score < 0) score = 0;

  return {
    score: Math.round(score),
    breakdown: {
      cyclePenalty,
      largestCyclePenalty,
      densityPenalty,
      severityPenalty,
    },
  };
}

/* ===============================
   MASTER ANALYZER
================================ */
export function analyzeFileGraph(edges: Edge[]) {
  const graph = buildAdjacency(edges);

  const sccs = findStronglyConnectedComponents(graph);
  const cycles = extractCycles(sccs);
  const analyzedCycles = analyzeCycles(cycles, graph);
  const metrics = calculateGraphMetrics(graph, cycles);
  const health = calculateArchitectureHealthScore(
    metrics.total_files,
    metrics.total_dependencies,
    analyzedCycles
  );

  return {
    nodes: Object.keys(graph.adj),
    edges,
    clusters: sccs,
    cycles: analyzedCycles,
    metrics,
    architecture_health_score: health.score,
    health_breakdown: health.breakdown,
  };
}