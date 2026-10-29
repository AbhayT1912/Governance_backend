# RepoLens Formula Sheet

This file lists the core formulas used in this project.

## 1) Engineering Velocity
- Formula: `(latest_architecture_health_score - first_architecture_health_score) / number_of_reports`
- Output: rounded to 2 decimals
- Source: `src/services/trend.service.ts` (`calculateVelocity`)

## 2) Volatility Score
- Formula: `sum(abs(score[i] - score[i-1])) / (number_of_reports - 1)`
- Output: rounded to 2 decimals
- Source: `src/services/trend.service.ts` (`calculateVolatilityScore`)

## 3) Stability Index
- Mean: `mean = sum(scores) / n`
- Variance: `variance = sum((score - mean)^2) / n`
- Std Dev: `stdDev = sqrt(variance)`
- Stability: `max(0, 100 - stdDev * 5)`
- Output: rounded to nearest integer
- Source: `src/services/trend.service.ts` (`calculateStabilityIndex`)

## 4) Regression Detection Delta
- Delta: `drop = latest_architecture_health_score - previous_architecture_health_score`
- Rules:
  - `drop < -5` -> HIGH regression
  - `drop < 0` -> LOW regression
- Source: `src/services/trend.service.ts` (`detectRegression`)

## 5) Degradation Prediction
- Rule: last 3 architecture scores strictly decreasing
  - `s3 < s2 && s2 < s1` -> HIGH degradation prediction
- Source: `src/services/trend.service.ts` (`predictDegradation`)

## 6) Complexity Metrics
- Average Complexity: `sum(function_complexity) / total_functions`
- Max Complexity: `max(function_complexity)`
- High Complexity Functions: complexity `>= 10`
- Source: `src/services/report.service.ts` (`calculateComplexityMetrics`)

## 7) Layer Health Score (Report)
- Formula: `max(0, 100 - total_violations * 5)`
- Source: `src/services/report.service.ts` (`analyzeLayerSeparation`)

## 8) Dependency Density
- File Density Score: `incoming_dependencies + outgoing_dependencies`
- Repo Density: `total_edges / total_files`
- Output: repo density rounded to 2 decimals
- Source: `src/services/report.service.ts` (`calculateDependencyDensity`)

## 9) Architecture Health Score (Report)
- Layer Penalty: `total_layer_violations * 3`
- Complexity Penalty: `average_complexity * 2`
- Dead Ratio: `dead_functions / max(1, total_functions)`
- Dead Penalty: `dead_ratio * 40`
- Density Penalty: `repo_density * 5`
- Score: `100 - layer_penalty - complexity_penalty - dead_penalty - density_penalty`
- Final: clamped to `[0, 100]`, rounded to nearest integer
- Source: `src/services/report.service.ts` (`calculateArchitectureHealthScore`)

## 10) Risk Exposure Scores
- Complexity Risk: `average_complexity * 10`
- Dead Code Risk: `(dead_functions / max(1, total_functions)) * 100`
- Layer Violation Risk: `total_layer_violations * 5`
- Dependency Density Risk: `repo_density * 10`
- Final: each rounded to nearest integer
- Source: `src/services/report.service.ts` (`calculateRiskExposure`)

## 11) Engineering Maturity Score + Grade
- Dead Ratio: `dead_functions_count / total_functions`
- Weighted Score:
  - `architecture_health_score * 0.35`
  - `+ layer_health_score * 0.25`
  - `+ (100 - average_complexity * 5) * 0.20`
  - `+ (100 - dead_ratio * 100) * 0.20`
- Final Score: clamped to `[0, 100]`, rounded to nearest integer
- Grade Rules:
  - `>= 90` -> `A`
  - `>= 75` -> `B`
  - `>= 60` -> `C`
  - else `D`
- Source: `src/services/report.service.ts` (`calculateEngineeringMaturity`)

## 12) Score Delta (Version-to-Version)
- Architecture Delta: `current_architecture_health_score - previous_architecture_health_score`
- Layer Delta: `current_layer_health_score - previous_layer_health_score`
- Complexity Delta: `current_avg_complexity - previous_avg_complexity` (rounded to 2 decimals)
- Dead Functions Delta: `current_dead_functions - previous_dead_functions`
- Source: `src/services/report.service.ts` (`generateRepoReport`)

## 13) File Graph Cycle Severity
- Per cycle severity: `cycle_size * total_internal_edges`
- Source:
  - `src/controllers/fileGraph.controller.ts`
  - `src/services/fileGraph.service.ts`

## 14) Architecture Health Score (File Graph)
- Density: `total_dependencies / total_files` (0 if no files)
- Penalties:
  - `cyclePenalty = min(30, total_cycles * 5)`
  - `largestCyclePenalty = min(20, largest_cycle_size * 3)`
  - `densityPenalty = min(25, density * 5)`
  - `severityPenalty = min(25, severity_sum / 10)`
- Score: `100 - cyclePenalty - largestCyclePenalty - densityPenalty - severityPenalty`
- Final: floor at `0`, rounded to nearest integer
- Source:
  - `src/controllers/fileGraph.controller.ts` (`calculateArchitectureHealthScore`)
  - `src/services/fileGraph.service.ts` (`calculateArchitectureHealthScore`)

## 15) Impact Analysis Severity Score
- Formula: `impact_count * impact_depth + fan_out * 2 + fan_in * 1.5`
- Final: capped at `100`, rounded to 2 decimals
- Source: `src/services/impactAnalysis.service.ts` (`calculateSeverity`)

## 16) Layer Discipline Score
- Violation Ratio: `violations_count / total_edges`
- Score: `100 - violation_ratio * 100`
- Edge case: if `total_edges == 0`, score is `100`
- Output: rounded to 2 decimals
- Source: `src/services/layerDetection.service.ts` (`calculateDisciplineScore`)

## 17) PR Overall Risk Score (Changed Files Aware)
- Inputs:
  - `issues[]` severity + type
  - `complexity_delta`
  - changed files list (`filename`, `additions`, `deletions`)
- Severity weights:
  - `CRITICAL=22`, `HIGH=12`, `MEDIUM=6`, `LOW=2`
- Derived metrics:
  - `issue_density = weighted_issue_sum / changed_files_count`
  - `impact_coverage = impacted_changed_files / changed_files_count`
  - `total_changed_lines = sum(additions + deletions)`
- Components:
  - `issueScore = min(55, issue_density * 3.2)`
  - `coverageScore = min(15, impact_coverage * 15)`
  - `complexityScore = min(12, max(0, complexity_delta) / changed_files_count * 2.2)`
  - `architectureScore = min(10, architecture_issue_count * 2.5)`
  - `securityScore = min(12, security_issue_count * 3)`
  - `churnScore = min(8, total_changed_lines / (changed_files_count * 220) * 8)`
- Final:
  - `overall_risk_score = round(clamp(issueScore + coverageScore + complexityScore + architectureScore + securityScore + churnScore, 0, 100))`
- Source: `src/services/prAnalysis.service.ts` (`calculateRiskScore`)
