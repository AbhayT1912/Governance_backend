import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import { SecurityFindingModel } from "../models/securityFinding.model";
import { logger } from "../config/logger";
import axios from "axios";

interface SecurityFinding {
  type: "SECRET" | "CVE" | "MALICIOUS_PATTERN" | "BAD_PRACTICE" | "LICENSE_ISSUE";
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  title: string;
  description: string;
  file_path?: string;
  line_number?: number;
  pattern?: string;
  evidence?: string;
  impact: string;
  remediation: string;
  cve_id?: string;
  affected_package?: string;
  affected_version?: string;
  available_fix?: string;
  source_url?: string;
  license_name?: string;
  license_type?: string;
  is_compliant?: boolean;
  pattern_type?: string;
  context_lines?: string;
}

// Secret patterns: AWS keys, API tokens, passwords, etc.
const SECRET_PATTERNS = [
  {
    name: "AWS Access Key",
    pattern: /AKIA[0-9A-Z]{16}/,
    confidence: "HIGH",
  },
  {
    name: "AWS Secret Key",
    pattern: /(aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*=\s*["']?([A-Za-z0-9/+=]{40})["']?/,
    confidence: "HIGH",
  },
  {
    name: "Private Key (RSA/SSH)",
    pattern: /-----BEGIN (RSA|DSA|EC|OPENSSH) PRIVATE KEY/,
    confidence: "CRITICAL",
  },
  {
    name: "GitHub Token",
    pattern: /ghp_[0-9a-zA-Z]{36}/,
    confidence: "CRITICAL",
  },
  {
    name: "Stripe API Key",
    pattern: /(sk_live|pk_live|sk_test|pk_test)_[0-9a-zA-Z]{24,}/,
    confidence: "CRITICAL",
  },
  {
    name: "JWT Token",
    pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./,
    confidence: "HIGH",
  },
  {
    name: "Slack Token",
    pattern: /xox[baprs]-[0-9]{10,13}-[0-9]{10,13}-[A-Za-z0-9_-]{24,}/,
    confidence: "CRITICAL",
  },
  {
    name: "API Key Pattern",
    pattern: /(api[_-]?key|apikey|api_secret)\s*[:=]\s*["']([A-Za-z0-9_-]{20,})["']/i,
    confidence: "HIGH",
  },
  {
    name: "Hardcoded Password",
    pattern: /(password|passwd|pwd)\s*[:=]\s*["']([^"']{8,})["']/i,
    confidence: "MEDIUM",
  },
];

// SAST patterns: Common code vulnerabilities
const SAST_PATTERNS = [
  {
    name: "Unsafe eval() usage",
    pattern: /\beval\s*\(/,
    type: "CODE_INJECTION",
    severity: "CRITICAL",
  },
  {
    name: "SQL Concatenation (Injection Risk)",
    pattern: /query\s*[\+=]*\s*["'`][^"'`]*["'`]\s*\+\s*|SQL\s+.*\+\s*/i,
    type: "SQL_INJECTION",
    severity: "HIGH",
  },
  {
    name: "Unsafe Deserialization",
    pattern: /pickle\.loads|JSON\.parse|yaml\.load|eval|exec\s*\(/,
    type: "DESERIALIZATION",
    severity: "HIGH",
  },
  {
    name: "Hardcoded Secret in Code",
    pattern: /(password|secret|token|api_key)\s*=\s*["']([A-Za-z0-9_-]{8,})["']/i,
    type: "HARDCODED_SECRET",
    severity: "HIGH",
  },
  {
    name: "Use of exec() or system()",
    pattern: /\b(exec|system|shell_exec|os\.system|subprocess\.call)\s*\(/,
    type: "COMMAND_INJECTION",
    severity: "HIGH",
  },
  {
    name: "Missing Input Validation",
    pattern: /\.innerHTML\s*=|dangerouslySetInnerHTML|innerHTML\s*\+=/i,
    type: "XSS",
    severity: "HIGH",
  },
];

// MALICIOUS patterns: Suspicious code behavior
const MALICIOUS_PATTERNS = [
  {
    name: "Obfuscated Code",
    pattern: /String\.fromCharCode\(|atob\(|btoa\(|charCodeAt/,
    type: "OBFUSCATION",
    severity: "MEDIUM",
  },
  {
    name: "Network Call to Unknown Host",
    pattern: /(fetch|axios|http\.get|http\.post)\s*\(\s*["']http[s]?:\/\/([a-z0-9]+\.)+[a-z]{2,}["']/i,
    type: "NETWORK_CALL",
    severity: "MEDIUM",
  },
  {
    name: "Process/Child Process Spawn",
    pattern: /spawn|fork|child_process|subprocess|Process\.Start/,
    type: "EXECUTION",
    severity: "MEDIUM",
  },
];

/**
 * Scan repository for secrets in code
 */
export const scanSecrets = async (
  repoPath: string,
  repoId: string
): Promise<SecurityFinding[]> => {
  const findings: SecurityFinding[] = [];
  const MAX_FILES = 5000;
  let fileCount = 0;

  const SCAN_EXTENSIONS = [".js", ".ts", ".jsx", ".tsx", ".json", ".env", ".yaml", ".yml", ".xml"];
  const IGNORED_DIRS = ["node_modules", ".git", "dist", "build", ".next"];

  const walk = (currentPath: string) => {
    if (fileCount > MAX_FILES) return;

    try {
      const entries = fs.readdirSync(currentPath);

      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry);
        const stats = fs.statSync(fullPath);

        if (stats.isDirectory()) {
          if (!IGNORED_DIRS.includes(entry)) {
            walk(fullPath);
          }
        } else {
          const ext = path.extname(fullPath).toLowerCase();
          if (SCAN_EXTENSIONS.includes(ext)) {
            fileCount++;
            const relativePath = path.relative(repoPath, fullPath);

            try {
              const content = fs.readFileSync(fullPath, "utf-8");
              const lines = content.split("\n");

              for (let lineNum = 0; lineNum < lines.length; lineNum++) {
                const line = lines[lineNum];

                // Skip comments and common non-issues
                if (line.trim().startsWith("//") || line.trim().startsWith("#")) {
                  continue;
                }

                for (const secretPattern of SECRET_PATTERNS) {
                  const match = line.match(secretPattern.pattern);
                  if (match) {
                    findings.push({
                      type: "SECRET",
                      severity: secretPattern.confidence as "CRITICAL" | "HIGH" | "MEDIUM" | "LOW",
                      title: `${secretPattern.name} Detected`,
                      description: `Found ${secretPattern.name} in source code that may be exposed.`,
                      file_path: relativePath,
                      line_number: lineNum + 1,
                      pattern: secretPattern.pattern.source,
                      evidence: line.substring(0, 100),
                      impact: "Exposed credentials can be used by attackers to access external services.",
                      remediation: "1. Revoke the exposed credential immediately. 2. Remove from code and commit history. 3. Use environment variables or secrets management. 4. Use pre-commit hooks to prevent future exposure.",
                    });
                  }
                }
              }
            } catch (err: any) {
              logger.warn(`Failed to scan file: ${fullPath}`, { error: err.message });
            }
          }
        }
      }
    } catch (err: any) {
      logger.warn(`Failed to walk directory: ${currentPath}`, { error: err.message });
    }
  };

  walk(repoPath);
  return findings;
};

/**
 * Scan for SAST vulnerabilities
 */
export const scanSASTVulnerabilities = async (
  repoPath: string,
  repoId: string
): Promise<SecurityFinding[]> => {
  const findings: SecurityFinding[] = [];
  const MAX_FILES = 5000;
  let fileCount = 0;

  const SCAN_EXTENSIONS = [".js", ".ts", ".jsx", ".tsx", ".py", ".java"];
  const IGNORED_DIRS = ["node_modules", ".git", "dist", "build", ".next"];

  const walk = (currentPath: string) => {
    if (fileCount > MAX_FILES) return;

    try {
      const entries = fs.readdirSync(currentPath);

      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry);
        const stats = fs.statSync(fullPath);

        if (stats.isDirectory()) {
          if (!IGNORED_DIRS.includes(entry)) {
            walk(fullPath);
          }
        } else {
          const ext = path.extname(fullPath).toLowerCase();
          if (SCAN_EXTENSIONS.includes(ext)) {
            fileCount++;
            const relativePath = path.relative(repoPath, fullPath);

            try {
              const content = fs.readFileSync(fullPath, "utf-8");
              const lines = content.split("\n");

              for (let lineNum = 0; lineNum < lines.length; lineNum++) {
                const line = lines[lineNum];

                for (const sastPattern of SAST_PATTERNS) {
                  if (sastPattern.pattern.test(line)) {
                    findings.push({
                      type: "BAD_PRACTICE",
                      severity: sastPattern.severity as "CRITICAL" | "HIGH" | "MEDIUM" | "LOW",
                      title: sastPattern.name,
                      description: `Potential ${sastPattern.type} vulnerability detected.`,
                      file_path: relativePath,
                      line_number: lineNum + 1,
                      pattern: sastPattern.pattern.source,
                      evidence: line.substring(0, 120),
                      impact: `This pattern is vulnerable to ${sastPattern.type} attacks.`,
                      remediation: `Refactor code to avoid ${sastPattern.type}. Use parameterized queries, input validation, and safe libraries.`,
                      pattern_type: sastPattern.type,
                      context_lines: [
                        lineNum > 0 ? lines[lineNum - 1] : "",
                        line,
                        lineNum < lines.length - 1 ? lines[lineNum + 1] : "",
                      ].join("\n"),
                    });
                  }
                }
              }
            } catch (err: any) {
              logger.warn(`Failed to scan SAST: ${fullPath}`, { error: err.message });
            }
          }
        }
      }
    } catch (err: any) {
      logger.warn(`Failed to walk directory for SAST: ${currentPath}`, {
        error: err.message,
      });
    }
  };

  walk(repoPath);
  return findings;
};

/**
 * Scan package.json for dependency vulnerabilities (SCA)
 */
export const scanDependencyVulnerabilities = async (
  repoPath: string,
  repoId: string
): Promise<SecurityFinding[]> => {
  const findings: SecurityFinding[] = [];

  // Check for package.json
  const packageJsonPath = path.join(repoPath, "package.json");
  const requirementsPath = path.join(repoPath, "requirements.txt");
  const pomPath = path.join(repoPath, "pom.xml");

  // Scan package.json (NPM)
  if (fs.existsSync(packageJsonPath)) {
    try {
      const content = fs.readFileSync(packageJsonPath, "utf-8");
      const packageJson = JSON.parse(content);

      // Common vulnerable versions (simplified SCA)
      const vulnDatabase: {
        [key: string]: { version: string; cve: string; fix: string }[];
      } = {
        lodash: [
          {
            version: "<4.17.21",
            cve: "CVE-2021-23337",
            fix: "lodash@^4.17.21",
          },
        ],
        axios: [
          {
            version: "<0.27.1",
            cve: "CVE-2023-26159",
            fix: "axios@^0.27.1",
          },
        ],
        express: [
          {
            version: "<4.18.0",
            cve: "CVE-2022-26691",
            fix: "express@^4.18.0",
          },
        ],
        jquery: [
          {
            version: "<3.6.0",
            cve: "CVE-2020-11022",
            fix: "jquery@^3.6.0",
          },
        ],
      };

      // Check dependencies
      const allDeps = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
      };

      for (const [pkg, version] of Object.entries(allDeps)) {
        if (vulnDatabase[pkg]) {
          for (const vuln of vulnDatabase[pkg]) {
            // Simplified version check (strip ^ and ~)
            const versionStr = (version as string).replace(/[\^~=]/g, "").split(".")[0];
            const vulnMajor = vuln.version
              .replace(/[<>=]/g, "")
              .split(".")[0];

            if (parseInt(versionStr) <= parseInt(vulnMajor)) {
              findings.push({
                type: "CVE",
                severity: "HIGH",
                title: `Vulnerable Dependency: ${pkg}`,
                description: `Package ${pkg}@${version} is vulnerable to ${vuln.cve}`,
                file_path: "package.json",
                affected_package: pkg,
                affected_version: (version as string),
                cve_id: vuln.cve,
                available_fix: vuln.fix,
                source_url: `https://nvd.nist.gov/vuln/detail/${vuln.cve}`,
                impact: `This CVE can compromise your application. Check the CVE details for attack vectors.`,
                remediation: `Upgrade to ${vuln.fix} or later version. Run \`npm update ${pkg}\` or edit package.json.`,
              });
            }
          }
        }
      }

      // Check for outdated packages (simple heuristic)
      if (packageJson.dependencies) {
        for (const [pkg, version] of Object.entries(packageJson.dependencies)) {
          if ((version as string).includes("<")) {
            findings.push({
              type: "CVE",
              severity: "MEDIUM",
              title: `Pinned Old Version: ${pkg}`,
              description: `${pkg} is pinned to an old version which may have security issues.`,
              affected_package: pkg,
              affected_version: (version as string),
              impact: `Old versions may have unpatched vulnerabilities.`,
              remediation: `Consider updating to a more recent stable version.`,
            });
          }
        }
      }
    } catch (err: any) {
      logger.warn("Failed to scan package.json for vulnerabilities", {
        error: err.message,
      });
    }
  }

  return findings;
};

/**
 * Scan for malicious patterns
 */
export const scanMaliciousPatterns = async (
  repoPath: string,
  repoId: string
): Promise<SecurityFinding[]> => {
  const findings: SecurityFinding[] = [];
  const MAX_FILES = 3000;
  let fileCount = 0;

  const SCAN_EXTENSIONS = [".js", ".ts", ".jsx", ".tsx", ".json"];
  const IGNORED_DIRS = ["node_modules", ".git", "dist", "build"];

  const walk = (currentPath: string) => {
    if (fileCount > MAX_FILES) return;

    try {
      const entries = fs.readdirSync(currentPath);

      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry);
        const stats = fs.statSync(fullPath);

        if (stats.isDirectory()) {
          if (!IGNORED_DIRS.includes(entry)) {
            walk(fullPath);
          }
        } else {
          const ext = path.extname(fullPath).toLowerCase();
          if (SCAN_EXTENSIONS.includes(ext)) {
            fileCount++;
            const relativePath = path.relative(repoPath, fullPath);

            try {
              const content = fs.readFileSync(fullPath, "utf-8");
              const lines = content.split("\n");

              for (let lineNum = 0; lineNum < lines.length; lineNum++) {
                const line = lines[lineNum];

                for (const malPattern of MALICIOUS_PATTERNS) {
                  if (malPattern.pattern.test(line)) {
                    findings.push({
                      type: "MALICIOUS_PATTERN",
                      severity: malPattern.severity as "CRITICAL" | "HIGH" | "MEDIUM" | "LOW",
                      title: malPattern.name,
                      description: `Suspicious code pattern detected: ${malPattern.name}`,
                      file_path: relativePath,
                      line_number: lineNum + 1,
                      pattern_type: malPattern.type,
                      evidence: line.substring(0, 100),
                      impact: `This pattern may indicate ${malPattern.type} attempts.`,
                      remediation: `Review this code carefully. Ensure it is legitimate and not part of a payload.`,
                      context_lines: line,
                    });
                  }
                }
              }
            } catch (err: any) {
              logger.warn(`Failed to scan malicious patterns: ${fullPath}`, {
                error: err.message,
              });
            }
          }
        }
      }
    } catch (err: any) {
      logger.warn("Failed to walk directory for malicious patterns", {
        error: err.message,
      });
    }
  };

  walk(repoPath);
  return findings;
};

/**
 * Scan license compliance
 */
export const scanLicenseCompliance = async (
  repoPath: string,
  repoId: string
): Promise<SecurityFinding[]> => {
  const findings: SecurityFinding[] = [];

  const packageJsonPath = path.join(repoPath, "package.json");

  // Restrictive licenses that may cause IP issues
  const restrictiveLicenses = ["GPL", "AGPL", "SSPL"];

  if (fs.existsSync(packageJsonPath)) {
    try {
      const content = fs.readFileSync(packageJsonPath, "utf-8");
      const packageJson = JSON.parse(content);

      // Check for GPL licenses in dependencies
      const allDeps = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
      };

      for (const [pkg, version] of Object.entries(allDeps)) {
        // In a real implementation, you'd fetch license info from npm registry
        // For now, we'll flag common GPL packages as a warning
        if (
          ["express", "mongoose", "lodash"].includes(pkg.toLowerCase())
        ) {
          // This is just a demo; real check would verify actual license
          continue;
        }
      }

      // Check if repo has a LICENSE file
      const licenseFiles = fs
        .readdirSync(repoPath)
        .filter((f) => f.toLowerCase().includes("license"));

      if (licenseFiles.length === 0) {
        findings.push({
          type: "LICENSE_ISSUE",
          severity: "MEDIUM",
          title: "Missing LICENSE File",
          description:
            "No LICENSE file found in repository root. This is important for legal protection.",
          file_path: "root",
          impact:
            "Without explicit licensing, your code's usage rights are ambiguous and may lead to disputes.",
          remediation:
            "Add a LICENSE file to the repository root. Choose an appropriate license for your project (MIT, Apache 2.0, GPL, etc.).",
          license_type: "UNKNOWN",
          is_compliant: false,
        });
      }
    } catch (err: any) {
      logger.warn("Failed to scan license compliance", { error: err.message });
    }
  }

  return findings;
};

/**
 * Main security analysis function
 */
export const performSecurityAnalysis = async (
  repoPath: string,
  repoId: string
): Promise<{ findings: SecurityFinding[]; trustScore: number; summary: any }> => {
  try {
    logger.info("Starting security analysis", { repo_id: repoId });

    const [secrets, sast, dependencies, malicious, licenses] = await Promise.all([
      scanSecrets(repoPath, repoId),
      scanSASTVulnerabilities(repoPath, repoId),
      scanDependencyVulnerabilities(repoPath, repoId),
      scanMaliciousPatterns(repoPath, repoId),
      scanLicenseCompliance(repoPath, repoId),
    ]);

    const allFindings = [...secrets, ...sast, ...dependencies, ...malicious, ...licenses];

    // Save findings to database
    if (allFindings.length > 0) {
      const findingsWithRepoId = allFindings.map((f) => ({
        ...f,
        repo_id: new mongoose.Types.ObjectId(repoId),
      }));

      await SecurityFindingModel.insertMany(findingsWithRepoId);
    }

    // Calculate trust score (0-100)
    let trustScore = 100;
    const severityWeights = { CRITICAL: 15, HIGH: 10, MEDIUM: 5, LOW: 1 };

    for (const finding of allFindings) {
      trustScore -= severityWeights[finding.severity as keyof typeof severityWeights] || 0;
    }

    trustScore = Math.max(0, Math.min(100, trustScore));

    // Summary
    const summary = {
      total_findings: allFindings.length,
      by_type: {
        secrets: secrets.length,
        sast: sast.length,
        dependencies: dependencies.length,
        malicious: malicious.length,
        licenses: licenses.length,
      },
      by_severity: {
        critical: allFindings.filter((f) => f.severity === "CRITICAL").length,
        high: allFindings.filter((f) => f.severity === "HIGH").length,
        medium: allFindings.filter((f) => f.severity === "MEDIUM").length,
        low: allFindings.filter((f) => f.severity === "LOW").length,
      },
      trust_score: trustScore,
    };

    logger.info("Security analysis completed", {
      repo_id: repoId,
      findings_count: allFindings.length,
      trust_score: trustScore,
    });

    return { findings: allFindings, trustScore, summary };
  } catch (error: any) {
    logger.error("Security analysis failed", { repo_id: repoId, error: error.message });
    throw error;
  }
};
