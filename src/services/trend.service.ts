// src/services/trend.service.ts

export function detectRegression(reports: any[]) {
  if (reports.length < 2) return null;

  const latest = reports[reports.length - 1];
  const previous = reports[reports.length - 2];

  const drop =
    latest.architecture_health_score -
    previous.architecture_health_score;

  if (drop < -5) {
    return {
      severity: "HIGH",
      message: "Significant architecture regression detected",
      delta: drop,
    };
  }

  if (drop < 0) {
    return {
      severity: "LOW",
      message: "Minor architecture score drop detected",
      delta: drop,
    };
  }

  return null;
}

export function calculateVelocity(reports: any[]) {
  if (reports.length < 2) return 0;

  const first = reports[0].architecture_health_score;
  const latest = reports[reports.length - 1].architecture_health_score;

  return Number(((latest - first) / reports.length).toFixed(2));
}

export function calculateStabilityIndex(reports: any[]) {
  if (reports.length < 2) return 100;

  const scores = reports.map(r => r.architecture_health_score);

  const mean =
    scores.reduce((a, b) => a + b, 0) / scores.length;

  const variance =
    scores.reduce((sum, score) => {
      return sum + Math.pow(score - mean, 2);
    }, 0) / scores.length;

  const stdDev = Math.sqrt(variance);

  // Higher stdDev → lower stability
  const stability = Math.max(0, 100 - stdDev * 5);

  return Math.round(stability);
}

export function calculateVolatilityScore(reports: any[]) {
  if (reports.length < 2) return 0;

  let totalChange = 0;

  for (let i = 1; i < reports.length; i++) {
    totalChange += Math.abs(
      reports[i].architecture_health_score -
      reports[i - 1].architecture_health_score
    );
  }

  const volatility =
    totalChange / (reports.length - 1);

  return Number(volatility.toFixed(2));
}

export function predictDegradation(reports: any[]) {
  if (reports.length < 3) return null;

  const lastThree = reports.slice(-3);

  const isDownward =
    lastThree[2].architecture_health_score <
    lastThree[1].architecture_health_score &&
    lastThree[1].architecture_health_score <
    lastThree[0].architecture_health_score;

  if (isDownward) {
    return {
      severity: "HIGH",
      message: "Architecture score declining consistently over last 3 versions",
    };
  }

  return null;
}