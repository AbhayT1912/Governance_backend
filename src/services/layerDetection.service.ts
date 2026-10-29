// src/services/layerDetection.service.ts

interface Edge {
  from: string;
  to: string;
}

type Layer =
  | "presentation"
  | "application"
  | "domain"
  | "infrastructure"
  | "shared"
  | "unknown";

interface LayeredNode {
  file_id: string;
  layer: Layer;
}

interface LayerAnalysisResult {
  layer_distribution: Record<Layer, number>;
  violations: {
    from: string;
    to: string;
    type: string;
  }[];
  architecture_discipline_score: number;
}

function detectLayerFromPath(path: string): Layer {
  const p = path.toLowerCase();

  if (p.includes("controller") || p.includes("route"))
    return "presentation";

  if (p.includes("service") || p.includes("usecase"))
    return "application";

  if (p.includes("model") || p.includes("entity"))
    return "domain";

  if (p.includes("repository") || p.includes("db") || p.includes("config"))
    return "infrastructure";

  if (p.includes("util") || p.includes("helper") || p.includes("common"))
    return "shared";

  return "unknown";
}

function buildLayerMap(files: { id: string; path: string }[]) {
  const map: Record<string, Layer> = {};

  for (const file of files) {
    map[file.id] = detectLayerFromPath(file.path);
  }

  return map;
}

function calculateDisciplineScore(
  violationsCount: number,
  totalEdges: number
) {
  if (totalEdges === 0) return 100;

  const violationRatio = violationsCount / totalEdges;
  const score = 100 - violationRatio * 100;

  return Number(score.toFixed(2));
}

export function analyzeLayers(
  files: { id: string; path: string }[],
  edges: Edge[]
): LayerAnalysisResult {

  const layerMap = buildLayerMap(files);

  const violations: {
    from: string;
    to: string;
    type: string;
  }[] = [];

  for (const edge of edges) {
    const fromLayer = layerMap[edge.from];
    const toLayer = layerMap[edge.to];

    if (!fromLayer || !toLayer) continue;

    // RULE: lower layer cannot depend upward
    const order: Layer[] = [
      "presentation",
      "application",
      "domain",
      "infrastructure",
      "shared",
      "unknown",
    ];

    const fromIndex = order.indexOf(fromLayer);
    const toIndex = order.indexOf(toLayer);

    if (toIndex < fromIndex) {
      violations.push({
        from: edge.from,
        to: edge.to,
        type: "UPWARD_DEPENDENCY",
      });
    }
  }

  const distribution: Record<Layer, number> = {
    presentation: 0,
    application: 0,
    domain: 0,
    infrastructure: 0,
    shared: 0,
    unknown: 0,
  };

  Object.values(layerMap).forEach(layer => {
    distribution[layer]++;
  });

  const disciplineScore = calculateDisciplineScore(
    violations.length,
    edges.length
  );

  return {
    layer_distribution: distribution,
    violations,
    architecture_discipline_score: disciplineScore,
  };
}