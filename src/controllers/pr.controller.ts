import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { PRAnalysisModel, PRFileImpact, PRIssue } from '../models/prAnalysis.model';
import { PRAnalysisService } from '../services/prAnalysis.service';
import { RepoModel } from '../models/repo.model';
import mongoose from 'mongoose';
import crypto from 'crypto';
import { logger } from '../config/logger';

// Verify GitHub webhook signature
function verifyGitHubSignature(req: any): boolean {
  const signature = req.headers['x-hub-signature-256'];
  if (!signature) {
    logger.warn('Webhook signature missing');
    return false;
  }

  const payload = req.rawBody || '';
  const secret = process.env.GITHUB_WEBHOOK_SECRET || '';

  if (!secret) {
    logger.warn('GITHUB_WEBHOOK_SECRET not configured');
    return false;
  }

  if (!payload) {
    logger.warn('Webhook payload is empty');
    return false;
  }

  // Generate expected signature
  const hash = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const expectedSignature = `sha256=${hash}`;

  // Extract just the hash part from the incoming signature (remove "sha256=" prefix if present)
  const incomingHash = signature.startsWith('sha256=')
    ? signature.substring(7)
    : signature;

  logger.info(`Signature received (hash only): ${incomingHash}`);
  logger.info(`Signature expected (hash only): ${hash}`);
  logger.info(`Payload length: ${payload.length}`);

  try {
    // Compare just the hash parts (same length)
    const isValid = crypto.timingSafeEqual(
      Buffer.from(incomingHash),
      Buffer.from(hash)
    );
    return isValid;
  } catch (error) {
    logger.error('Signature verification failed:', error);
    return false;
  }
}

export const handleGitHubWebhook = asyncHandler(async (req: Request, res: Response) => {
  const event = req.headers['x-github-event'];

  // Only process pull_request events
  if (event !== 'pull_request') {
    return res.status(200).json({ message: 'Event ignored - not a pull_request' });
  }

  // Verify webhook signature
  if (!verifyGitHubSignature(req)) {
    logger.warn('Invalid webhook signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const { action, pull_request, repository } = req.body;

  // Only analyze on PR open or synchronize (new commits)
  if (!['opened', 'synchronize'].includes(action)) {
    return res.status(200).json({ message: `Action '${action}' ignored - only processing opened/synchronize` });
  }

  try {
    const { owner, name: repoName } = repository;
    const { number: prNumber, head, title, html_url } = pull_request;

    logger.info(`Processing PR #${prNumber} for ${owner.login}/${repoName}`);

    // Find repo in database (case-insensitive search)
    const repo = await RepoModel.findOne({
      repo_url: new RegExp(`^https://github\\.com/${owner.login}/${repoName}$`, 'i'),
    });

    if (!repo) {
      logger.warn(`Repository not found: ${owner.login}/${repoName}`);
      return res.status(404).json({ error: 'Repository not found in RepoLink' });
    }

    const githubToken = process.env.GITHUB_TOKEN || '';
    if (!githubToken) {
      logger.error('GITHUB_TOKEN not configured');
      return res.status(500).json({ error: 'GitHub token not configured' });
    }

    // Fetch PR diff
    const files = await PRAnalysisService.fetchPRDiff(
      owner.login,
      repoName,
      prNumber,
      githubToken
    );

    if (files.length === 0) {
      logger.info(`No files found in PR #${prNumber}`);
      return res.status(200).json({ message: 'No files to analyze' });
    }

    logger.info(`Analyzing ${files.length} files in PR #${prNumber}`);

    // Analyze all files
    const allIssues: PRIssue[] = [];
    const fileImpacts: PRFileImpact[] = [];
    let totalComplexityDelta = 0;
    let architectureViolationsCount = 0;
    let securityIssuesCount = 0;

    for (const file of files) {
      const filePath = file.filename;
      const patchText = String(file.patch || '');

      // File-level impact is always assessed, even for non-code files.
      const fileImpactAssessment = PRAnalysisService.assessFileImpact(file);
      fileImpacts.push(fileImpactAssessment.impact);
      allIssues.push(...fileImpactAssessment.derivedIssues);
      securityIssuesCount += fileImpactAssessment.derivedIssues.filter(
        (issue) => issue.type === 'security'
      ).length;

      // Skip non-code files
      if (/\.(md|txt|json|yml|yaml|config|lock|env)$/i.test(filePath)) {
        logger.debug(`Skipping non-code file: ${filePath}`);
        continue;
      }

      logger.debug(`Analyzing file: ${filePath}`);

      // Security checks
      const securityIssues = PRAnalysisService.detectSecurityIssues(patchText, filePath);
      allIssues.push(...securityIssues);
      securityIssuesCount += securityIssues.length;

      // Performance checks
      const perfIssues = PRAnalysisService.detectPerformanceIssues(patchText, filePath);
      allIssues.push(...perfIssues);

      // Code quality checks
      const qualityIssues = PRAnalysisService.detectQualityIssues(patchText, filePath);
      allIssues.push(...qualityIssues);

      // Complexity analysis
      const metrics = PRAnalysisService.analyzeComplexityDelta('', patchText);
      totalComplexityDelta += metrics.complexity_increase;

      if (metrics.complexity_increase > 5) {
        allIssues.push({
          file: filePath,
          line: 0,
          message: `Complexity increased by ${metrics.complexity_increase}`,
          type: 'complexity',
          severity: metrics.complexity_increase > 15 ? 'HIGH' : 'MEDIUM',
          suggestion: 'Consider refactoring to reduce complexity',
        });
      }
    }

    // Architecture violations
    try {
      const archIssues = await PRAnalysisService.detectArchitectureViolations(
        repo._id.toString(),
        files.map(f => f.filename)
      );
      allIssues.push(...archIssues);
      architectureViolationsCount = archIssues.length;
    } catch (error) {
      logger.error('Architecture analysis failed:', error);
    }

    // Calculate risk score
    const riskScore = PRAnalysisService.calculateRiskScore({
      issues: allIssues,
      complexityDelta: totalComplexityDelta,
      changedFiles: files,
      fileImpacts,
    });

    logger.info(`PR #${prNumber}: Found ${allIssues.length} issues, risk score: ${riskScore}`);

    let aiReview = 'AI review unavailable for this run.';
    try {
      aiReview = await PRAnalysisService.generateAIReview(
        repo._id.toString(),
        files,
        allIssues,
        riskScore,
        fileImpacts
      );
    } catch (error) {
      logger.error('AI review generation failed:', error);
    }
    const criticalityReductionFixes =
      PRAnalysisService.buildCriticalityReductionFixes(allIssues);

    // Post GitHub comment
    let commentId: string | null = null;
    let githubCommentBody: string | null = null;
    try {
      const postedComment = await PRAnalysisService.postGitHubComment(
        owner.login,
        repoName,
        prNumber,
        allIssues,
        riskScore,
        githubToken,
        aiReview,
        criticalityReductionFixes,
        fileImpacts
      );
      if (postedComment) {
        commentId = postedComment.id;
        githubCommentBody = postedComment.comment;
        logger.info(`GitHub comment posted for PR #${prNumber}`);
      } else {
        logger.warn(`GitHub comment was not created for PR #${prNumber}`);
      }
    } catch (error) {
      logger.error('Failed to post GitHub comment:', error);
    }

    // Save analysis to database
    const analysis = await PRAnalysisModel.create({
      repo_id: repo._id,
      pr_number: prNumber,
      pr_title: title,
      pr_url: html_url,
      github_pr_id: pull_request.id,
      files_changed: files.length,
      files_analyzed: files.map(f => f.filename),
      issues: allIssues,
      file_impacts: fileImpacts,
      issue_summary: {
        total: allIssues.length,
        critical: allIssues.filter(i => i.severity === 'CRITICAL').length,
        high: allIssues.filter(i => i.severity === 'HIGH').length,
        medium: allIssues.filter(i => i.severity === 'MEDIUM').length,
        low: allIssues.filter(i => i.severity === 'LOW').length,
      },
      complexity_delta: totalComplexityDelta,
      architecture_violations_count: architectureViolationsCount,
      security_issues: securityIssuesCount,
      overall_risk_score: riskScore,
      ai_review: aiReview,
      criticality_reduction_fixes: criticalityReductionFixes,
      github_comment_id: commentId || undefined,
      github_comment_body: githubCommentBody || undefined,
    });

    logger.info(`PR analysis saved: ${analysis._id}`);

    res.status(200).json({
      success: true,
      message: `PR #${prNumber} analyzed successfully`,
      data: analysis,
    });
  } catch (error) {
    logger.error('Webhook processing error:', error);
    res.status(500).json({
      error: 'Processing failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Get PR analysis for a specific PR
export const getPRAnalysis = asyncHandler(async (req: Request, res: Response) => {
  const { repoId, prNumber } = req.params;

  if (!mongoose.Types.ObjectId.isValid(repoId as string)) {
    return res.status(400).json({ success: false, error: 'Invalid repo ID' });
  }

  const analysis = await PRAnalysisModel.findOne({
    repo_id: repoId as string,
    pr_number: parseInt(prNumber as string),
  });

  if (!analysis) {
    return res.status(404).json({
      success: false,
      error: 'Analysis not found',
      data: null
    });
  }

  res.status(200).json({
    success: true,
    data: analysis,
  });
});

// Get all PR analyses for a repository
export const getReposPRAnalyses = asyncHandler(async (req: Request, res: Response) => {
  const { repoId } = req.params;
  const { limit = 20, skip = 0 } = req.query;

  if (!mongoose.Types.ObjectId.isValid(repoId as string)) {
    return res.status(400).json({ success: false, error: 'Invalid repo ID' });
  }

  const analyses = await PRAnalysisModel.find({
    repo_id: repoId as string,
  })
    .sort({ created_at: -1 })
    .limit(parseInt(limit as string))
    .skip(parseInt(skip as string));

  const total = await PRAnalysisModel.countDocuments({ repo_id: repoId as string });

  res.status(200).json({
    success: true,
    data: analyses,
    pagination: {
      total,
      limit: parseInt(limit as string),
      skip: parseInt(skip as string),
    },
  });
});

// Get PR analysis summary
export const getPRAnalysisSummary = asyncHandler(async (req: Request, res: Response) => {
  const { repoId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(repoId as string)) {
    return res.status(400).json({ success: false, error: 'Invalid repo ID' });
  }

  const analyses = await PRAnalysisModel.find({
    repo_id: repoId as string,
  })
    .sort({ created_at: -1 })
    .lean();

  const summary = {
    total_prs_analyzed: analyses.length,
    average_risk_score: 0,
    total_issues_found: 0,
    issue_breakdown: {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    },
    issue_types: {
      complexity: 0,
      architecture: 0,
      dead_code: 0,
      security: 0,
      performance: 0,
      quality: 0,
    },
  };

  if (analyses.length > 0) {
    summary.average_risk_score =
      analyses.reduce((sum, a: any) => sum + Number(a.overall_risk_score || 0), 0) /
      analyses.length;

    analyses.forEach((analysis: any) => {
      const issues = Array.isArray(analysis.issues) ? analysis.issues : [];

      if (issues.length > 0) {
        summary.total_issues_found += issues.length;

        issues.forEach((issue: any) => {
          const sev = String(issue?.severity || '').toUpperCase();
          if (sev === 'CRITICAL') summary.issue_breakdown.critical += 1;
          else if (sev === 'HIGH') summary.issue_breakdown.high += 1;
          else if (sev === 'MEDIUM') summary.issue_breakdown.medium += 1;
          else if (sev === 'LOW') summary.issue_breakdown.low += 1;

          const type = String(issue?.type || '');
          if (type in summary.issue_types) {
            summary.issue_types[type as keyof typeof summary.issue_types] += 1;
          }
        });
      } else {
        summary.total_issues_found += Number(analysis?.issue_summary?.total || 0);
        summary.issue_breakdown.critical += Number(analysis?.issue_summary?.critical || 0);
        summary.issue_breakdown.high += Number(analysis?.issue_summary?.high || 0);
        summary.issue_breakdown.medium += Number(analysis?.issue_summary?.medium || 0);
        summary.issue_breakdown.low += Number(analysis?.issue_summary?.low || 0);
      }
    });
  }

  res.status(200).json({
    success: true,
    data: summary,
  });
});
