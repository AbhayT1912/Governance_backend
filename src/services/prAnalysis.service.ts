import axios from 'axios';
import { PRFileImpact, PRIssue } from '../models/prAnalysis.model';
import { FileModel } from '../models/file.model';
import { FunctionModel } from '../models/function.model';
import { ImportModel } from '../models/import.model';
import mongoose from 'mongoose';
import { askAIService } from './ai.service';

interface PRDiff {
  filename: string;
  patch?: string;
  additions: number;
  deletions: number;
  status?: 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed' | string;
  previous_filename?: string;
}

interface PRMetrics {
  complexity_increase: number;
  new_functions: string[];
  modified_functions: string[];
  removed_functions: string[];
}

interface SymbolContextMatch {
  function_id: string;
  name: string;
  file_path: string;
  language: string;
  start_line: number;
  end_line: number;
  complexity: number;
  is_entry: boolean;
  is_dead: boolean;
  callers: string[];
  callees: string[];
  imports: Array<{
    source: string;
    specifiers: string[];
    is_external: boolean;
  }>;
}

interface SymbolContext {
  symbol: string;
  matched: boolean;
  matches: SymbolContextMatch[];
}

interface GitHubCommentPostResult {
  id: string;
  comment: string;
}

interface FileImpactAssessment {
  impact: PRFileImpact;
  derivedIssues: PRIssue[];
}

export class PRAnalysisService {
  private static readonly MAX_DIFF_CHARS = 26000;
  private static readonly MAX_CONTEXT_CHARS = 18000;
  private static readonly MAX_SYMBOLS = 20;

  private static escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private static normalizePath(value: string): string {
    return String(value || '').replace(/\\/g, '/').toLowerCase().trim();
  }

  private static stripEmoji(value: string): string {
    return String(value || '')
      .replace(/\p{Extended_Pictographic}/gu, '')
      .replace(/\uFE0F/gu, '')
      .trim();
  }

  private static getBaseName(path: string): string {
    const normalized = this.normalizePath(path);
    const parts = normalized.split('/').filter(Boolean);
    return parts[parts.length - 1] || normalized;
  }

  private static getChangeType(file: PRDiff): PRFileImpact['change_type'] {
    const status = String(file.status || '').toLowerCase();
    if (
      status === 'added' ||
      status === 'modified' ||
      status === 'removed' ||
      status === 'renamed' ||
      status === 'copied' ||
      status === 'changed'
    ) {
      return status;
    }

    if (Number(file.deletions || 0) > 0 && Number(file.additions || 0) === 0) {
      return 'removed';
    }
    if (Number(file.additions || 0) > 0 && Number(file.deletions || 0) === 0) {
      return 'added';
    }
    return 'modified';
  }

  static assessFileImpact(file: PRDiff): FileImpactAssessment {
    const filename = String(file.filename || 'unknown');
    const normalized = this.normalizePath(filename);
    const base = this.getBaseName(normalized);
    const changeType = this.getChangeType(file);
    const additions = Number(file.additions || 0);
    const deletions = Number(file.deletions || 0);
    const changedLines = additions + deletions;
    const patch = String(file.patch || '');

    const criticalInfraFiles = new Set([
      'package.json',
      'package-lock.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      'dockerfile',
      'docker-compose.yml',
      'docker-compose.yaml',
      'tsconfig.json',
      'requirements.txt',
      'go.mod',
      'cargo.toml',
      'pom.xml',
      'build.gradle',
    ]);

    const highValueConfigFiles = new Set([
      '.env',
      '.env.example',
      '.npmrc',
      '.yarnrc',
      'vite.config.js',
      'vite.config.ts',
      'next.config.js',
      'webpack.config.js',
      'webpack.config.ts',
    ]);

    const isInfraFile = criticalInfraFiles.has(base);
    const isConfigFile = highValueConfigFiles.has(base) || isInfraFile;

    let severity: PRFileImpact['severity'] = 'LOW';
    let riskPoints = Math.min(18, Math.ceil(changedLines / 60));
    let summary = `File changed with ${changedLines} modified lines.`;
    let mergeImpact = 'Localized behavior change expected after merge.';
    let recommendation = 'Review this file diff and validate behavior with targeted tests.';

    if (changeType === 'removed') {
      if (isInfraFile) {
        severity = 'CRITICAL';
        riskPoints = Math.max(riskPoints, 45);
        summary = `${base} was removed.`;
        mergeImpact =
          'Dependency resolution, build, runtime startup, or deployment is likely to fail after merge.';
        recommendation =
          `Restore ${base} or provide an equivalent replacement in the same PR and re-run CI/build checks.`;
      } else if (isConfigFile) {
        severity = 'HIGH';
        riskPoints = Math.max(riskPoints, 28);
        summary = `${base} configuration file was removed.`;
        mergeImpact =
          'Environment-specific behavior may break after merge due to missing configuration.';
        recommendation =
          'Reintroduce the configuration file or move settings to a supported alternative with validation.';
      } else if (changedLines >= 120) {
        severity = 'HIGH';
        riskPoints = Math.max(riskPoints, 22);
        summary = `Large file removal detected (${changedLines} deleted lines).`;
        mergeImpact =
          'Downstream imports or runtime paths can fail after merge if references remain.';
        recommendation =
          'Check all dependents/callers and add regression tests for removed behavior.';
      } else {
        severity = 'MEDIUM';
        riskPoints = Math.max(riskPoints, 14);
        summary = `File removal detected (${base}).`;
        mergeImpact =
          'Any unresolved references to this file can break runtime or build workflows after merge.';
        recommendation = 'Confirm all references were removed and run full test/build validation.';
      }
    } else if (isInfraFile && changedLines >= 20) {
      severity = 'HIGH';
      riskPoints = Math.max(riskPoints, 24);
      summary = `Critical infrastructure file updated (${base}).`;
      mergeImpact =
        'Dependency graph or build pipeline behavior can change immediately after merge.';
      recommendation =
        'Run install/build/deploy smoke checks and validate lockfile consistency before merging.';
    } else if (isInfraFile && changedLines > 0) {
      severity = 'MEDIUM';
      riskPoints = Math.max(riskPoints, 16);
      summary = `Infrastructure config touched (${base}).`;
      mergeImpact =
        'Toolchain behavior may shift after merge and affect reproducibility.';
      recommendation = 'Validate CI, install, and build commands on clean environment.';
    } else if (/^\.env(\.|$)/i.test(base) && changedLines > 0) {
      severity = 'HIGH';
      riskPoints = Math.max(riskPoints, 24);
      summary = 'Environment file changed.';
      mergeImpact =
        'Runtime configuration drift or secret exposure risk may increase after merge.';
      recommendation =
        'Avoid committing secrets, validate required keys, and document environment migration steps.';
    } else if (changedLines >= 500) {
      severity = 'MEDIUM';
      riskPoints = Math.max(riskPoints, 16);
      summary = `High churn file change (${changedLines} lines).`;
      mergeImpact = 'Large modifications increase probability of regressions after merge.';
      recommendation = 'Split into smaller PRs or add focused tests for touched behavior.';
    }

    if (
      base === 'package.json' &&
      /-\s*\"(build|start|test|dev)\"\s*:/i.test(patch)
    ) {
      severity = severity === 'CRITICAL' ? 'CRITICAL' : 'HIGH';
      riskPoints = Math.max(riskPoints, 30);
      summary = 'Core package scripts changed or removed in package.json.';
      mergeImpact =
        'CI/build/start workflows may fail immediately after merge if scripts are missing or incompatible.';
      recommendation =
        'Restore required scripts or update pipeline commands and verify them in CI.';
    }

    const impact: PRFileImpact = {
      file: filename,
      change_type: changeType,
      severity,
      risk_points: riskPoints,
      summary,
      merge_impact: mergeImpact,
      recommendation,
    };

    const derivedIssues: PRIssue[] = [];
    if (severity === 'CRITICAL' || severity === 'HIGH') {
      derivedIssues.push({
        file: filename,
        line: 0,
        message: `File-level merge risk: ${summary}`,
        type: 'quality',
        severity,
        suggestion: recommendation,
      });
    }

    if (/^\.env(\.|$)/i.test(base) && changedLines > 0) {
      derivedIssues.push({
        file: filename,
        line: 0,
        message: 'Sensitive environment file changed in PR.',
        type: 'security',
        severity: 'HIGH',
        suggestion:
          'Ensure no secrets are committed and verify runtime variables with a secure secret manager.',
      });
    }

    return { impact, derivedIssues };
  }

  // Fetch PR diff from GitHub
  static async fetchPRDiff(
    owner: string,
    repo: string,
    prNumber: number,
    githubToken: string
  ): Promise<PRDiff[]> {
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files`;
    
    try {
      const response = await axios.get(url, {
        headers: {
          Authorization: `token ${githubToken}`,
          Accept: 'application/vnd.github.v3+json',
        },
      });
      
      return response.data;
    } catch (error) {
      console.error('Failed to fetch PR diff:', error);
      return [];
    }
  }

  // Analyze code complexity changes
  static analyzeComplexityDelta(
    oldContent: string,
    newContent: string
  ): PRMetrics {
    const oldFunctions = this.extractFunctions(oldContent);
    const newFunctions = this.extractFunctions(newContent);
    const oldComplexity = oldFunctions.reduce((sum, f) => sum + (f.complexity || 1), 0);
    const newComplexity = newFunctions.reduce((sum, f) => sum + (f.complexity || 1), 0);

    return {
      complexity_increase: newComplexity - oldComplexity,
      new_functions: newFunctions.filter(nf => 
        !oldFunctions.some(of => of.name === nf.name)
      ).map(f => f.name),
      modified_functions: newFunctions.filter(nf =>
        oldFunctions.some(of => of.name === nf.name && of.body !== nf.body)
      ).map(f => f.name),
      removed_functions: oldFunctions.filter(of =>
        !newFunctions.some(nf => nf.name === of.name)
      ).map(f => f.name),
    };
  }

  // Extract functions from code
  private static extractFunctions(code: string) {
    const functionPattern = /(?:function|const|let|var)\s+(\w+)\s*(?:=\s*)?(?:async\s*)?(?:\([^)]*\))?(?:\s*{|=>)/g;
    const functions: any[] = [];
    let match;

    while ((match = functionPattern.exec(code)) !== null) {
      const complexity = this.calculateComplexity(
        code.substring(match.index, Math.min(match.index + 500, code.length))
      );
      functions.push({
        name: match[1],
        complexity,
        body: code.substring(match.index, Math.min(match.index + 300, code.length)),
      });
    }

    return functions;
  }

  // Calculate cyclomatic complexity estimate
  private static calculateComplexity(code: string): number {
    let complexity = 1;
    complexity += (code.match(/if\s*\(/g) || []).length;
    complexity += (code.match(/else\s*if\s*\(/g) || []).length;
    complexity += (code.match(/else/g) || []).length;
    complexity += (code.match(/for\s*\(/g) || []).length;
    complexity += (code.match(/while\s*\(/g) || []).length;
    complexity += (code.match(/case\s+/g) || []).length;
    complexity += (code.match(/catch\s*\(/g) || []).length;
    complexity += ((code.match(/\?\s*:/g) || []).length) * 0.5;
    return Math.ceil(complexity);
  }

  // Detect architecture violations
  static async detectArchitectureViolations(repoId: string, files: string[]): Promise<PRIssue[]> {
    const issues: PRIssue[] = [];
    const repoObjectId = new mongoose.Types.ObjectId(repoId);

    for (const file of files) {
      try {
        const imports = await ImportModel.find({
          repo_id: repoObjectId,
          source: file,
        }).lean();

        // Check for circular dependencies and upward dependencies
        for (const imp of imports) {
          const sourceFile = await FileModel.findById(imp.file_id).lean();
          if (!sourceFile) continue;

          const sourcePath = sourceFile.path.toLowerCase();
          const targetPath = file.toLowerCase();

          // Utils should not import from controllers
          if (sourcePath.includes('/utils/') && targetPath.includes('/controllers/')) {
            issues.push({
              file: sourcePath,
              line: 0,
              message: `Architecture violation: utils layer importing from controllers`,
              type: 'architecture',
              severity: 'HIGH',
              suggestion: `Move shared logic to a common module or refactor to avoid upward dependencies`,
            });
          }

          // Services should not import from routes
          if (sourcePath.includes('/services/') && targetPath.includes('/routes/')) {
            issues.push({
              file: sourcePath,
              line: 0,
              message: `Architecture violation: services layer importing from routes`,
              type: 'architecture',
              severity: 'HIGH',
              suggestion: `Dependency should be reversed - routes consume services`,
            });
          }
        }
      } catch (error) {
        console.error(`Error analyzing architecture for ${file}:`, error);
      }
    }

    return issues;
  }

  // Detect dead code
  static async detectDeadCode(repoId: string, files: string[]): Promise<PRIssue[]> {
    const issues: PRIssue[] = [];
    const repoObjectId = new mongoose.Types.ObjectId(repoId);

    for (const file of files) {
      try {
        const deadFunctions = await FunctionModel.find({
          repo_id: repoObjectId,
          file_path: file,
          is_dead: true,
        }).lean();

        for (const fn of deadFunctions) {
          issues.push({
            file,
            line: fn.start_line || 0,
            message: `Unused function: ${fn.name}`,
            type: 'dead_code',
            severity: 'MEDIUM',
            suggestion: `Remove or document why this function is needed`,
          });
        }
      } catch (error) {
        console.error(`Error analyzing dead code for ${file}:`, error);
      }
    }

    return issues;
  }

  // Basic security checks
  static detectSecurityIssues(patch: string, filename: string): PRIssue[] {
    const issues: PRIssue[] = [];
    const securityPatterns = [
      { 
        pattern: /eval\s*\(/g, 
        message: 'Use of eval() is dangerous',
        severity: 'CRITICAL' as const
      },
      { 
        pattern: /dangerouslySetInnerHTML/g, 
        message: 'dangerouslySetInnerHTML can expose XSS vulnerabilities',
        severity: 'CRITICAL' as const
      },
      { 
        pattern: /localStorage\s*\.\s*setItem\s*\(\s*['"]password/gi, 
        message: 'Storing passwords in localStorage is unsafe',
        severity: 'CRITICAL' as const
      },
      { 
        pattern: /INSERT\s+INTO|UPDATE|DELETE\s+FROM|\.query\(/gi, 
        message: 'Potential SQL injection vulnerability - use parameterized queries',
        severity: 'HIGH' as const
      },
      { 
        pattern: /process\.env\s*\./g, 
        message: 'Direct env variable access - should be validated',
        severity: 'MEDIUM' as const
      },
      {
        pattern: /\/\/\s*TODO|\/\/\s*FIXME|\/\/\s*HACK/gi,
        message: 'Unresolved TODO/FIXME/HACK comment in code',
        severity: 'LOW' as const
      }
    ];

    securityPatterns.forEach((rule) => {
      if (rule.pattern.test(patch)) {
        issues.push({
          file: filename,
          line: 0,
          message: rule.message,
          type: 'security',
          severity: rule.severity,
          suggestion: 'Review the security implications and use safer alternatives',
        });
      }
    });

    return issues;
  }

  // Detect performance issues
  static detectPerformanceIssues(patch: string, filename: string): PRIssue[] {
    const issues: PRIssue[] = [];

    // Expensive operations in loops
    if (/for\s*\([^)]*\)\s*{[\s\S]*?(api|fetch|query|request|db\.)/gi.test(patch)) {
      issues.push({
        file: filename,
        line: 0,
        message: 'Potential performance issue: API/DB call inside loop',
        type: 'performance',
        severity: 'HIGH',
        suggestion: 'Batch API/DB requests or move them outside the loop',
      });
    }

    // N+1 queries
    if (/\.forEach\s*\([\s\S]*?(query|find|fetch)/gi.test(patch)) {
      issues.push({
        file: filename,
        line: 0,
        message: 'Potential N+1 query problem',
        type: 'performance',
        severity: 'HIGH',
        suggestion: 'Use batch queries or joins instead of queries in loops',
      });
    }

    // Missing async/await
    if (/promise.*catch|\.then\(|\.catch\(/gi.test(patch) && !/async\s+function|async\s*\(/gi.test(patch)) {
      issues.push({
        file: filename,
        line: 0,
        message: 'Promise chain detected - consider using async/await for clarity',
        type: 'performance',
        severity: 'LOW',
        suggestion: 'Refactor promise chains to async/await syntax',
      });
    }

    return issues;
  }

  // Code quality checks (basic linting)
  static detectQualityIssues(code: string, filename: string): PRIssue[] {
    const issues: PRIssue[] = [];
    const lines = code.split('\n');

    // Long functions (estimate by looking for function definitions and their scope)
    const functionMatches = code.match(/(?:function|const|let|var)\s+\w+\s*(?:=\s*)?(?:async\s*)?\([^)]*\)\s*{/g) || [];
    if (functionMatches.length > 0 && lines.length > 50) {
      issues.push({
        file: filename,
        line: 0,
        message: `Function is too long (${lines.length} lines)`,
        type: 'quality',
        severity: 'MEDIUM',
        suggestion: 'Break down large functions into smaller, reusable components',
      });
    }

    // Missing error handling
    if (/try\s*{[\s\S]*?}(?!\s*catch)/g.test(code)) {
      issues.push({
        file: filename,
        line: 0,
        message: 'Missing error handling (try-catch block)',
        type: 'quality',
        severity: 'MEDIUM',
        suggestion: 'Add proper error handling for async operations',
      });
    }

    // Magic numbers/strings
    const magicMatches = code.match(/['"][a-zA-Z0-9]{8,}['"]|[0-9]{4,}/g) || [];
    if (magicMatches.length > 3) {
      issues.push({
        file: filename,
        line: 0,
        message: `${magicMatches.length} magic numbers or strings detected`,
        type: 'quality',
        severity: 'LOW',
        suggestion: 'Extract to named constants for better readability',
      });
    }

    // Potentially unused variables/imports (heuristic)
    const declaredVariables = Array.from(
      code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g)
    ).map((m) => m[1]);
    const hasPotentialUnusedVariable = declaredVariables.some((name) => {
      const refs = code.match(new RegExp(`\\b${this.escapeRegExp(name)}\\b`, 'g'));
      return (refs?.length || 0) <= 1;
    });

    if (/import\s+\{[^}]+\}\s+from/g.test(code) || hasPotentialUnusedVariable) {
      issues.push({
        file: filename,
        line: 0,
        message: 'Potential unused imports or variables',
        type: 'quality',
        severity: 'LOW',
        suggestion: 'Remove unused imports and variables to keep code clean',
      });
    }

    return issues;
  }

  // Calculate overall risk score based on changed files and issue concentration.
  static calculateRiskScore(params: {
    issues: PRIssue[];
    complexityDelta: number;
    changedFiles: PRDiff[];
    fileImpacts?: PRFileImpact[];
  }): number {
    const { issues, complexityDelta, changedFiles, fileImpacts = [] } = params;
    const changedCount = Math.max(1, changedFiles.length);

    const severityWeight: Record<PRIssue['severity'], number> = {
      CRITICAL: 22,
      HIGH: 12,
      MEDIUM: 6,
      LOW: 2,
    };

    const weightedIssueSum = issues.reduce(
      (sum, issue) => sum + severityWeight[issue.severity],
      0
    );

    const changedPathSet = new Set(
      changedFiles.map((f) => this.normalizePath(f.filename))
    );

    const impactedChangedFiles = new Set<string>();
    for (const issue of issues) {
      const issuePath = this.normalizePath(issue.file);
      if (!issuePath) continue;

      for (const changedPath of changedPathSet) {
        if (
          changedPath === issuePath ||
          changedPath.endsWith(issuePath) ||
          issuePath.endsWith(changedPath)
        ) {
          impactedChangedFiles.add(changedPath);
          break;
        }
      }
    }

    const issueDensity = weightedIssueSum / changedCount;
    const impactCoverage = impactedChangedFiles.size / changedCount;

    const totalChangedLines = changedFiles.reduce(
      (sum, f) => sum + Number(f.additions || 0) + Number(f.deletions || 0),
      0
    );

    const architectureCount = issues.filter((i) => i.type === 'architecture').length;
    const securityCount = issues.filter((i) => i.type === 'security').length;
    const fileImpactSum = fileImpacts.reduce(
      (sum, impact) => sum + Number(impact.risk_points || 0),
      0
    );

    const issueScore = Math.min(55, issueDensity * 3.2);
    const coverageScore = Math.min(15, impactCoverage * 15);
    const complexityScore = Math.min(
      12,
      Math.max(0, complexityDelta) / changedCount * 2.2
    );
    const architectureScore = Math.min(10, architectureCount * 2.5);
    const securityScore = Math.min(12, securityCount * 3);
    const churnScore = Math.min(8, (totalChangedLines / (changedCount * 220)) * 8);
    const fileImpactScore = Math.min(30, fileImpactSum / changedCount);

    const rawScore =
      issueScore +
      coverageScore +
      complexityScore +
      architectureScore +
      securityScore +
      churnScore +
      fileImpactScore;
    const criticalCount = issues.filter((i) => i.severity === 'CRITICAL').length;
    const criticalFileImpactCount = fileImpacts.filter(
      (f) => f.severity === 'CRITICAL'
    ).length;
    const bounded = Math.max(0, Math.min(100, Math.round(rawScore)));

    // Rule: a PR with at least one CRITICAL issue cannot be classified as LOW risk.
    if (criticalCount > 0 || criticalFileImpactCount > 0) {
      return Math.max(50, bounded);
    }

    return bounded;
  }

  // Extract likely modified symbols from patch text
  static extractModifiedSymbols(diffText: string): string[] {
    if (!diffText) return [];

    const symbols = new Set<string>();
    const patterns: RegExp[] = [
      /\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
      /\bclass\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
      /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?\(/g,
      /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g,
      /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*(?:async\s*)?\([^)]*\)\s*=>/g,
    ];

    for (const pattern of patterns) {
      for (const match of diffText.matchAll(pattern)) {
        const candidate = (match[1] || '').trim();
        if (!candidate || candidate.length < 2) continue;
        symbols.add(candidate);

        if (symbols.size >= this.MAX_SYMBOLS) {
          return Array.from(symbols);
        }
      }
    }

    return Array.from(symbols);
  }

  static async buildContextForSymbol(
    repoId: string,
    symbol: string
  ): Promise<SymbolContext> {
    const repoObjectId = new mongoose.Types.ObjectId(repoId);
    const symbolRegex = new RegExp(`^${this.escapeRegExp(symbol)}$`, 'i');

    const candidates = await FunctionModel.find({
      repo_id: repoObjectId,
      name: symbolRegex,
    })
      .limit(5)
      .lean();

    if (!candidates.length) {
      return {
        symbol,
        matched: false,
        matches: [],
      };
    }

    const matches: SymbolContextMatch[] = [];

    for (const fn of candidates) {
      const [file, callers, callees, imports] = await Promise.all([
        FileModel.findById(fn.file_id).select('path language').lean(),
        FunctionModel.find({
          repo_id: repoObjectId,
          outgoing_calls: fn._id,
        })
          .select('name')
          .limit(10)
          .lean(),
        Array.isArray(fn.outgoing_calls) && fn.outgoing_calls.length > 0
          ? FunctionModel.find({
              _id: { $in: fn.outgoing_calls },
            })
              .select('name')
              .limit(10)
              .lean()
          : Promise.resolve([]),
        ImportModel.find({
          repo_id: repoObjectId,
          file_id: fn.file_id,
        })
          .select('source specifiers is_external')
          .limit(15)
          .lean(),
      ]);

      matches.push({
        function_id: fn._id.toString(),
        name: fn.name,
        file_path: file?.path || 'unknown',
        language: file?.language || 'unknown',
        start_line: Number(fn.start_line || 0),
        end_line: Number(fn.end_line || 0),
        complexity: Number(fn.complexity || 1),
        is_entry: Boolean(fn.is_entry),
        is_dead: Boolean(fn.is_dead),
        callers: callers.map((c) => c.name),
        callees: callees.map((c) => c.name),
        imports: imports.map((imp) => ({
          source: imp.source,
          specifiers: Array.isArray(imp.specifiers) ? imp.specifiers : [],
          is_external: Boolean(imp.is_external),
        })),
      });
    }

    return {
      symbol,
      matched: true,
      matches,
    };
  }

  static async generateAIReview(
    repoId: string,
    files: PRDiff[],
    issues: PRIssue[],
    riskScore: number,
    fileImpacts: PRFileImpact[] = []
  ): Promise<string> {
    try {
      const diffText = files
        .map((f) => `FILE: ${f.filename}\n${f.patch || '[patch unavailable]'}`)
        .join('\n\n')
        .slice(0, this.MAX_DIFF_CHARS);

      const modifiedSymbols = this.extractModifiedSymbols(diffText);
      const symbolContexts = await Promise.all(
        modifiedSymbols.map((symbol) => this.buildContextForSymbol(repoId, symbol))
      );

      const contextPayload = {
        risk_score: riskScore,
        changed_files: files.map((f) => ({
          filename: f.filename,
          additions: f.additions,
          deletions: f.deletions,
        })),
        existing_issues_summary: {
          total: issues.length,
          critical: issues.filter((i) => i.severity === 'CRITICAL').length,
          high: issues.filter((i) => i.severity === 'HIGH').length,
          medium: issues.filter((i) => i.severity === 'MEDIUM').length,
          low: issues.filter((i) => i.severity === 'LOW').length,
        },
        file_impacts: fileImpacts.map((item) => ({
          file: item.file,
          change_type: item.change_type,
          severity: item.severity,
          risk_points: item.risk_points,
          summary: item.summary,
          merge_impact: item.merge_impact,
        })),
        modified_symbols: modifiedSymbols,
        symbol_contexts: symbolContexts,
      };

      const contextText = JSON.stringify(contextPayload, null, 2).slice(
        0,
        this.MAX_CONTEXT_CHARS
      );

      const reviewPrompt = `
You are an automated code reviewer.
Assess the POST-MERGE IMPACT of this pull request using the DIFF and ARCHITECTURAL CONTEXT.

DIFF:
${diffText}

CONTEXT:
${contextText}

Focus on:
1) behavior and logic impact after merge,
2) downstream module breakage risk,
3) runtime or reliability impact,
4) missing safeguards and mitigation steps,
5) file-by-file impact for changed critical/config files.

Output requirements:
- no emoji,
- concise bullets,
- each bullet must include: impact area, risk level, likely consequence after merge, and concrete fix,
- end with one line: "Overall post-merge impact: <LOW|MEDIUM|HIGH>".
- if no meaningful risk exists, return exactly: Low impact. No blocking post-merge risk detected.
`;

      const aiResponse = await askAIService(repoId, reviewPrompt);
      const answer = (aiResponse?.answer || '').trim();

      if (!answer) {
        return 'Low impact. No blocking post-merge risk detected.';
      }

      return this.stripEmoji(answer).slice(0, 12000);
    } catch (error) {
      console.error('AI PR review generation failed:', error);
      return 'AI review unavailable for this run.';
    }
  }

  static buildCriticalityReductionFixes(issues: PRIssue[]): string[] {
    const fixes: string[] = [];
    const seen = new Set<string>();

    const pushFix = (value: string) => {
      const cleaned = this.stripEmoji(value).replace(/\s+/g, ' ').trim();
      if (!cleaned) return;
      const key = cleaned.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      fixes.push(cleaned);
    };

    const priorityIssues = issues.filter(
      (i) => i.severity === 'CRITICAL' || i.severity === 'HIGH'
    );

    for (const issue of priorityIssues) {
      if (issue.suggestion) {
        pushFix(issue.suggestion);
        continue;
      }

      switch (issue.type) {
        case 'security':
          pushFix('Replace unsafe patterns with validated and sanitized alternatives; avoid dynamic code execution and unsafe HTML injection.');
          break;
        case 'architecture':
          pushFix('Refactor dependency direction so lower layers do not depend on higher layers; extract shared logic into neutral modules.');
          break;
        case 'performance':
          pushFix('Remove expensive calls from loops and batch external/database operations to avoid N+1 execution.');
          break;
        case 'complexity':
          pushFix('Split large control flow into smaller functions and isolate edge-case handling paths.');
          break;
        case 'dead_code':
          pushFix('Delete unused code paths or add references/tests proving they are required.');
          break;
        case 'quality':
          pushFix('Add explicit error handling and replace magic literals with named constants.');
          break;
        default:
          pushFix('Apply targeted refactoring and tests for the flagged area.');
          break;
      }
    }

    return fixes.slice(0, 12);
  }

  // Post analysis as GitHub comment
  static async postGitHubComment(
    owner: string,
    repo: string,
    prNumber: number,
    issues: PRIssue[],
    riskScore: number,
    githubToken: string,
    aiReview?: string,
    criticalityFixes?: string[],
    fileImpacts?: PRFileImpact[]
  ): Promise<GitHubCommentPostResult | null> {
    const groupedIssues: Record<string, PRIssue[]> = {};
    issues.forEach(issue => {
      if (!groupedIssues[issue.type]) groupedIssues[issue.type] = [];
      groupedIssues[issue.type].push(issue);
    });

    let comment = `## Code Analysis Report\n\n`;
    
    let riskLevel = 'LOW RISK';
    if (riskScore > 70) {
      riskLevel = 'HIGH RISK';
    } else if (riskScore > 40) {
      riskLevel = 'MEDIUM RISK';
    }
    
    comment += `**Overall Risk Score: ${riskScore}/100** (${riskLevel})\n\n`;

    if (Array.isArray(fileImpacts) && fileImpacts.length > 0) {
      comment += `### File-Level Merge Impact\n\n`;
      fileImpacts.slice(0, 15).forEach((impact) => {
        comment += `- [${impact.severity}] ${impact.file} (${impact.change_type}) - ${impact.summary}\n`;
        comment += `  Consequence: ${impact.merge_impact}\n`;
        if (impact.recommendation) {
          comment += `  Recommendation: ${impact.recommendation}\n`;
        }
      });
      if (fileImpacts.length > 15) {
        comment += `- ... and ${fileImpacts.length - 15} more changed files\n`;
      }
      comment += '\n';
    }

    if (issues.length === 0) {
      comment += `No issues detected.\n`;
    } else {
      comment += `### Issues Found: ${issues.length}\n\n`;

      Object.entries(groupedIssues).forEach(([type, typeIssues]) => {
        comment += `#### ${this.formatType(type)} (${typeIssues.length})\n`;
        typeIssues.slice(0, 5).forEach(issue => {
          comment += `- [${issue.severity}] ${issue.message}\n`;
          if (issue.suggestion) {
            comment += `  Suggestion: ${issue.suggestion}\n`;
          }
        });
        if (typeIssues.length > 5) {
          comment += `- ... and ${typeIssues.length - 5} more issues of this type\n`;
        }
        comment += '\n';
      });
    }

    const sanitizedAIReview = this.stripEmoji(aiReview || '');
    if (sanitizedAIReview) {
      comment += `\n### AI Post-Merge Impact Review\n${sanitizedAIReview}\n`;
    }

    const sanitizedFixes = (criticalityFixes || [])
      .map((fix) => this.stripEmoji(fix))
      .filter(Boolean);
    if (sanitizedFixes.length > 0) {
      comment += `\n### Criticality Reduction Fixes\n`;
      sanitizedFixes.forEach((fix) => {
        comment += `- ${fix}\n`;
      });
      comment += '\n';
    }

    comment += `\n---\n_Analysis Reports powered by RepoLink_`;


    try {
      const response = await axios.post(
        `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`,
        { body: comment },
        {
          headers: {
            Authorization: `token ${githubToken}`,
            Accept: 'application/vnd.github.v3+json',
          },
        }
      );

      return {
        id: String(response.data.id),
        comment,
      };
    } catch (error) {
      console.error('Failed to post GitHub comment:', error);
      return null;
    }
  }

  private static formatType(type: string): string {
    const types: Record<string, string> = {
      complexity: 'Complexity Issues',
      architecture: 'Architecture Violations',
      dead_code: 'Dead Code',
      security: 'Security Issues',
      performance: 'Performance Issues',
      quality: 'Code Quality',
    };
    return types[type] || type;
  }
}
