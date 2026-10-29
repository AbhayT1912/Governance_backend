/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "fs";
import path from "path";
import { parse } from "@babel/parser";
// @ts-ignore — no @types/babel__traverse available
import traverse from "@babel/traverse";
import * as t from "@babel/types";
import mongoose from "mongoose";

import { FileModel } from "../models/file.model";
import { FunctionModel } from "../models/function.model";
import { ImportModel } from "../models/import.model";
import { CallModel } from "../models/call.model";
import { RepoModel } from "../models/repo.model";
import { logger } from "../config/logger";
import { getRepoPath } from "../utils/repoPath.util";

const SUPPORTED_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx"];

/**
 * Plugins always enabled regardless of file type.
 * Cast to any[] to avoid PluginConfig type strictness issues.
 */
const BASE_PLUGINS: any[] = [
  "jsx",
  "classProperties",
  "classPrivateProperties",
  "classPrivateMethods",
  ["decorators", { decoratorsBeforeExport: true }],
  "dynamicImport",
  "objectRestSpread",
  "optionalChaining",
  "nullishCoalescingOperator",
  "optionalCatchBinding",
  "logicalAssignment",
  "numericSeparator",
  "bigInt",
  "importMeta",
  "exportDefaultFrom",
  "exportNamespaceFrom",
  "asyncGenerators",
  "doExpressions",
  "throwExpressions",
  "moduleStringNames",
  "topLevelAwait",
];

/**
 * Try multiple Babel parse strategies in order.
 * Handles TypeScript, Flow, and ambiguous JS (e.g. React DevTools uses Flow).
 * Returns the first successful AST, or null if all strategies fail.
 */
function tryParseFile(code: string, ext: string): any {
  const isTypeScript = ext === ".ts" || ext === ".tsx";

  const strategies: any[][] = [
    // Strategy 1: canonical type system for extension
    [...(isTypeScript ? ["typescript"] : ["flow", "flowComments"]), ...BASE_PLUGINS],
    // Strategy 2: opposite type system (some .js files in TS repos and vice versa)
    [...(isTypeScript ? ["flow", "flowComments"] : ["typescript"]), ...BASE_PLUGINS],
    // Strategy 3: no type annotations — plain JS with all proposals
    [...BASE_PLUGINS],
    // Strategy 4: minimal TypeScript + JSX (last resort for very unusual syntax)
    ["typescript", "jsx"],
  ];

  for (const plugins of strategies) {
    try {
      const ast = parse(code, {
        sourceType: "unambiguous",
        errorRecovery: true,
        strictMode: false,
        plugins,
      });
      if (ast && ast.program) return ast;
    } catch {
      // Try next strategy
    }
  }

  return null;
}

export const parseRepository = async (repoId: string) => {
  const files = await FileModel.find({ repo_id: repoId });
  const basePath = getRepoPath(repoId);
  const repoObjectId = new mongoose.Types.ObjectId(repoId);

  let totalFunctionCount = 0;
  let parsedFiles = 0;
  let skippedFiles = 0;

  for (const file of files) {
    const ext = path.extname(file.path);
    if (!SUPPORTED_EXTENSIONS.includes(ext)) continue;

    const absolutePath = path.join(basePath, file.path);
    if (!fs.existsSync(absolutePath)) continue;

    try {
      const code = fs.readFileSync(absolutePath, "utf-8");

      // Skip empty or trivially small files
      if (!code || code.trim().length < 10) continue;

      // Skip oversized files (minified bundles) to protect memory on Render free tier
      if (code.length > 500_000) {
        logger.debug("Skipping oversized file", { file: file.path, size: code.length });
        skippedFiles++;
        continue;
      }

      const ast = tryParseFile(code, ext);

      if (!ast) {
        logger.warn("Parser: all strategies exhausted, skipping file", { file: file.path });
        skippedFiles++;
        continue;
      }

      parsedFiles++;

      const functionsToInsert: any[] = [];
      const importsToInsert: any[] = [];
      const callsToInsert: any[] = [];

      let currentFunction: string | null = null;
      let complexity = 1;

      // ============================
      // FIRST PASS — FUNCTIONS & IMPORTS
      // ============================

      try {
        traverse(ast, {
          // Cyclomatic complexity counters
          IfStatement() { complexity++; },
          ForStatement() { complexity++; },
          WhileStatement() { complexity++; },
          DoWhileStatement() { complexity++; },
          SwitchCase() { complexity++; },
          ConditionalExpression() { complexity++; },
          LogicalExpression(nodePath: any) {
            const op = nodePath.node.operator;
            if (op === "&&" || op === "||") complexity++;
          },

          // Import collection
          ImportDeclaration(nodePath: any) {
            const node = nodePath.node;
            const specifiers = node.specifiers.map((s: any) => {
              if (t.isImportSpecifier(s) && t.isIdentifier(s.imported)) return s.imported.name;
              if (t.isImportDefaultSpecifier(s) && t.isIdentifier(s.local)) return s.local.name;
              return "unknown";
            });
            importsToInsert.push({
              repo_id: repoObjectId,
              file_id: file._id,
              source: node.source.value,
              specifiers,
              is_external: !node.source.value.startsWith("."),
            });
          },

          // Named function declarations
          FunctionDeclaration: {
            enter(nodePath: any) {
              if (!nodePath.node.id) return;
              currentFunction = nodePath.node.id.name;
              functionsToInsert.push({
                repo_id: repoObjectId,
                file_id: file._id,
                name: currentFunction,
                type: "FunctionDeclaration",
                start_line: nodePath.node.loc?.start.line ?? 0,
                end_line: nodePath.node.loc?.end.line ?? 0,
                complexity,
              });
            },
            exit() { currentFunction = null; },
          },

          // Arrow functions and function expressions assigned to variables
          VariableDeclarator(nodePath: any) {
            const node = nodePath.node;
            if (
              t.isIdentifier(node.id) &&
              (t.isArrowFunctionExpression(node.init) || t.isFunctionExpression(node.init))
            ) {
              functionsToInsert.push({
                repo_id: repoObjectId,
                file_id: file._id,
                name: node.id.name,
                type: "FunctionExpression",
                start_line: node.loc?.start.line ?? 0,
                end_line: node.loc?.end.line ?? 0,
                complexity,
              });
            }
          },
        });
      } catch (traverseErr: any) {
        logger.warn("Traverse error in pass 1 (partial results kept)", {
          file: file.path,
          error: traverseErr?.message,
        });
      }

      // ============================
      // INSERT FUNCTIONS FIRST
      // ============================

      let insertedFunctions: any[] = [];
      if (functionsToInsert.length > 0) {
        insertedFunctions = await FunctionModel.insertMany(functionsToInsert);
        totalFunctionCount += insertedFunctions.length;
      }

      const functionMap = new Map<string, mongoose.Types.ObjectId>();
      for (const fn of insertedFunctions) {
        functionMap.set(fn.name, fn._id);
      }

      // ============================
      // SECOND PASS — CALL GRAPH
      // ============================

      try {
        traverse(ast, {
          FunctionDeclaration: {
            enter(nodePath: any) {
              if (nodePath.node.id) currentFunction = nodePath.node.id.name;
            },
            exit(nodePath: any) {
              if (nodePath.node.id?.name === currentFunction) currentFunction = null;
            },
          },
          VariableDeclarator: {
            enter(nodePath: any) {
              const node = nodePath.node;
              if (
                t.isIdentifier(node.id) &&
                (t.isArrowFunctionExpression(node.init) || t.isFunctionExpression(node.init))
              ) {
                currentFunction = node.id.name;
              }
            },
            exit(nodePath: any) {
              const node = nodePath.node;
              if (t.isIdentifier(node.id) && node.id.name === currentFunction) {
                currentFunction = null;
              }
            },
          },
          CallExpression(nodePath: any) {
            if (!currentFunction) return;
            const node = nodePath.node;
            let calleeName: string | null = null;
            if (t.isIdentifier(node.callee)) calleeName = node.callee.name;
            if (!calleeName || !functionMap.has(calleeName)) return;

            const callerId = functionMap.get(currentFunction);
            const calleeId = functionMap.get(calleeName);
            if (!callerId || !calleeId) return;

            callsToInsert.push({
              repo_id: repoObjectId,
              file_id: file._id,
              caller_function_id: callerId,
              callee_function_id: calleeId,
              start_line: node.loc?.start.line ?? 0,
            });
          },
        });
      } catch (traverseErr: any) {
        logger.warn("Traverse error in pass 2 (calls partial)", {
          file: file.path,
          error: traverseErr?.message,
        });
      }

      // ============================
      // FLUSH TO DB
      // ============================

      if (importsToInsert.length > 0) await ImportModel.insertMany(importsToInsert);
      if (callsToInsert.length > 0) await CallModel.insertMany(callsToInsert);

    } catch (error: any) {
      // File-level error — log as warning and continue; never block the pipeline
      logger.warn("Parsing failed for file (skipped)", {
        file: file.path,
        error: error.message,
      });
      skippedFiles++;
    }
  }

  await RepoModel.findByIdAndUpdate(repoId, { function_count: totalFunctionCount });

  logger.info("Repository parsing completed", {
    repo_id: repoId,
    parsed_files: parsedFiles,
    skipped_files: skippedFiles,
    total_functions: totalFunctionCount,
  });

  return totalFunctionCount;
};
