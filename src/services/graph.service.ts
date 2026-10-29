import mongoose from "mongoose";
import { FunctionModel } from "../models/function.model";
import { CallModel } from "../models/call.model";
import { logger } from "../config/logger";
import { object } from "zod";

export const buildCallGraph = async (repoId: string) => {
  logger.info("Graph building started", { repo_id: repoId });

  const repoObjectId = new mongoose.Types.ObjectId(repoId);

  await FunctionModel.updateMany(
    { repo_id: repoObjectId },
    {
      is_entry: false,
      is_dead: false,
      depth: 0,
      component_id: null,
      outgoing_calls: [],
    }
  );

  const functions = await FunctionModel.find({
    repo_id: repoObjectId,
  }).lean();

  const calls = await CallModel.find({
    repo_id: repoObjectId,
  }).lean();
  console.log("DEBUG -> total calls:",calls.length);

  // Build graph in memory
  const graph: Record<string, string[]> = {};

  for (const fn of functions) {
    graph[fn._id.toString()] = [];
  }

  for (const call of calls) {
    const caller = call.caller_function_id?.toString();
    const callee = call.callee_function_id?.toString();

    if (caller && callee && graph[caller]) {
      graph[caller].push(callee);
    }
  }

  // console.log("DEBUG: GRAPH NON EMPTY:",object.entries(graph).filter(([_, v]) => v.length > 0).length);

  // Build reverse adjacency
  const reverseAdj = new Map<string, string[]>();
  for (const fnId of Object.keys(graph)) {
    reverseAdj.set(fnId, []);
  }

  for (const [caller, callees] of Object.entries(graph)) {
    for (const callee of callees) {
      if (reverseAdj.has(callee)) {
        reverseAdj.get(callee)!.push(caller);
      }
    }
  }

  // Entry & Dead detection
  const entryFunctions: string[] = [];
  const deadFunctions: string[] = [];

  for (const [fnId, incoming] of reverseAdj.entries()) {
    const outgoing = graph[fnId] || [];

    if (incoming.length === 0 && outgoing.length > 0) {
      entryFunctions.push(fnId);
    }

    if (incoming.length === 0 && outgoing.length === 0) {
      deadFunctions.push(fnId);
    }
  }

  // Depth calculation
  const depthMap = new Map<string, number>();
  const visiting = new Set<string>();

  const dfsDepth = (node: string): number => {
    if (depthMap.has(node)) return depthMap.get(node)!;
    if (visiting.has(node)) return 0;

    visiting.add(node);

    let maxDepth = 0;

    for (const neighbor of graph[node] || []) {
      maxDepth = Math.max(maxDepth, dfsDepth(neighbor));
    }

    visiting.delete(node);

    const depth = maxDepth + 1;
    depthMap.set(node, depth);
    return depth;
  };

  for (const fnId of Object.keys(graph)) {
    dfsDepth(fnId);
  }

  // Tarjan SCC
  let index = 0;
  const indices = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  const strongConnect = (v: string) => {
    indices.set(v, index);
    lowLink.set(v, index);
    index++;

    stack.push(v);
    onStack.add(v);

    for (const w of graph[v] || []) {
      if (!indices.has(w)) {
        strongConnect(w);
        lowLink.set(v, Math.min(lowLink.get(v)!, lowLink.get(w)!));
      } else if (onStack.has(w)) {
        lowLink.set(v, Math.min(lowLink.get(v)!, indices.get(w)!));
      }
    }

    if (lowLink.get(v) === indices.get(v)) {
      const component: string[] = [];
      let w: string;

      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);

      components.push(component);
    }
  };

  for (const fnId of Object.keys(graph)) {
    if (!indices.has(fnId)) {
      strongConnect(fnId);
    }
  }

  // 🔥 MERGED BULK WRITE (optimized)

  // 🔥 SINGLE CONSOLIDATED BULK WRITE

const finalBulkOps: any[] = [];

const entrySet = new Set(entryFunctions);
const deadSet = new Set(deadFunctions);

for (const fn of functions) {
  const fnId = fn._id.toString();

  finalBulkOps.push({
    updateOne: {
      filter: { _id: new mongoose.Types.ObjectId(fnId) },
      update: {
        depth: depthMap.get(fnId) ?? 0,
        component_id:
          components.find((c, i) => c.includes(fnId))
            ? `C${components.findIndex(c => c.includes(fnId))}`
            : null,
        outgoing_calls: graph[fnId] || [],
        is_entry: entrySet.has(fnId),
        is_dead: deadSet.has(fnId),
      },
    },
  });
}

if (finalBulkOps.length > 0) {
  await FunctionModel.bulkWrite(finalBulkOps);
}


  logger.info("Graph building completed", {
    repo_id: repoId,
    total_functions: functions.length,
    total_components: components.length,
    entry_functions: entryFunctions.length,
    dead_functions: deadFunctions.length,
  });
};
