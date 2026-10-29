import { Request, Response } from "express";
import mongoose from "mongoose";
import { FunctionModel } from "../models/function.model";
import { asyncHandler } from "../utils/asyncHandler";
import { AppError } from "../utils/AppError";
import { successResponse } from "../utils/response.util";

export const getCallGraph = asyncHandler(
  async (req: Request, res: Response) => {
    const { repoId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(repoId as string)) {
      throw new AppError("Invalid repository ID", 400);
    }

    const repoObjectId = new mongoose.Types.ObjectId(repoId as string);

    const functions = await FunctionModel.find({
      repo_id: repoObjectId,
    }).lean();

    if (!functions.length) {
      return res.status(200).json({
        success: true,
        data: {
          repo_id: repoId,
          nodes: [],
          edges: [],
        },
      });
    }

    // -----------------------------------
    // 🔹 NODE BUILD (DEDUP + SORTED)
    // -----------------------------------

    const nodeMap = new Map<string, any>();

    for (const fn of functions) {
      const id = fn._id.toString();

      nodeMap.set(id, {
        id,
        label: fn.name || "anonymous",
        file_id: fn.file_id?.toString() || null,
        is_entry: Boolean(fn.is_entry),
        is_dead: Boolean(fn.is_dead),
        depth: Number(fn.depth ?? 0),
        component: fn.component_id ?? null,
      });
    }

    // Deterministic sorting (by label then id)
    const nodes = Array.from(nodeMap.values()).sort((a, b) => {
      if (a.label === b.label) {
        return a.id.localeCompare(b.id);
      }
      return a.label.localeCompare(b.label);
    });

    // -----------------------------------
    // 🔹 EDGE BUILD (DEDUP + SORTED)
    // -----------------------------------

    const edgeSet = new Set<string>();
    const edges: { from: string; to: string }[] = [];

    for (const fn of functions) {
      const callerId = fn._id.toString();

      if (!Array.isArray(fn.outgoing_calls)) continue;

      for (const calleeRaw of fn.outgoing_calls) {
        const calleeId = calleeRaw?.toString();
        if (!calleeId) continue;

        const edgeKey = `${callerId}->${calleeId}`;

        if (!edgeSet.has(edgeKey)) {
          edgeSet.add(edgeKey);
          edges.push({
            from: callerId,
            to: calleeId,
          });
        }
      }
    }

    // Deterministic sort (by from then to)
    edges.sort((a, b) => {
      if (a.from === b.from) {
        return a.to.localeCompare(b.to);
      }
      return a.from.localeCompare(b.from);
    });

    // -----------------------------------
    // 🔹 FINAL RESPONSE
    // -----------------------------------

    return successResponse(res, {
      repo_id: repoId,
      node_count: nodes.length,
      edge_count: edges.length,
      nodes,
      edges,
    });
  },
);
