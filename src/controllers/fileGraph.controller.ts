import { Request, Response } from "express";
import mongoose from "mongoose";
import { asyncHandler } from "../utils/asyncHandler";
import { AppError } from "../utils/AppError";
import { rankFilesByRisk } from "../services/impactAnalysis.service";
import { buildRepoDependencyGraph } from "../services/repoDependency.service";

/* ===============================
   TARJAN SCC
================================ */
function findStronglyConnectedComponents(
  adj: Record<string, string[]>
) {
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

    for (const neighbor of adj[node] || []) {
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

  for (const node of Object.keys(adj)) {
    if (indices[node] === undefined) {
      strongConnect(node);
    }
  }

  return sccs;
}

/* ===============================
   HEALTH SCORE CALCULATION
================================ */
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
   CONTROLLER
================================ */
export const getFileGraph = asyncHandler(
  async (req: Request, res: Response) => {
    const repoId = Array.isArray(req.params.repoId)
      ? req.params.repoId[0]
      : req.params.repoId;

    if (!mongoose.Types.ObjectId.isValid(repoId)) {
      throw new AppError("Invalid repository ID", 400);
    }

    const repoObjectId = new mongoose.Types.ObjectId(repoId);
    const graph = await buildRepoDependencyGraph(repoObjectId);
    const { nodes, edges, fileById, externalDependencyCount } = graph;

    if (!nodes.length) {
      return res.status(200).json({
        success: true,
        data: {
          repo_id: repoId,
          total_files: 0,
          total_dependencies: 0,
          external_dependencies: 0,
          cycles: [],
          nodes: [],
          edges: [],
          blast_radius_ranking: [],
          architecture_health_score: 100,
          health_breakdown: {},
        },
      });
    }

    /* ===============================
       BUILD ADJACENCY LIST
    ================================ */
    const adj: Record<string, string[]> = {};

    for (const node of nodes) {
      adj[node.id] = [];
    }

    for (const edge of edges) {
      adj[edge.from].push(edge.to);
    }

    /* ===============================
       FIND CYCLES
    ================================ */
    const sccs = findStronglyConnectedComponents(adj);

    const cycles = sccs
      .filter((c) => c.length > 1)
      .map((cycle) => {
        let totalEdges = 0;
        for (const node of cycle) {
          totalEdges += adj[node].length;
        }

        return {
          nodes: cycle,
          paths: cycle.map((nodeId) => fileById.get(nodeId)?.path || nodeId),
          size: cycle.length,
          total_internal_edges: totalEdges,
          severity_score: cycle.length * totalEdges,
        };
      });

    /* ===============================
       HEALTH SCORE
    ================================ */
    const health = calculateArchitectureHealthScore(
      nodes.length,
      edges.length,
      cycles
    );

    const blastRadiusRanking = rankFilesByRisk(edges)
      .map((entry) => {
        const file = fileById.get(entry.file_id);
        if (!file) return null;

        return {
          ...entry,
          path: file.path,
          language: file.language,
          size: file.size,
        };
      })
      .filter(Boolean);

    return res.status(200).json({
      success: true,
      data: {
        repo_id: repoId,
        total_files: nodes.length,
        total_dependencies: edges.length,
        external_dependencies: externalDependencyCount,
        cycles,
        nodes,
        edges,
        blast_radius_ranking: blastRadiusRanking,
        architecture_health_score: health.score,
        health_breakdown: health.breakdown,
      },
    });
  }
);
