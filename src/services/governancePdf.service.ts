import PDFDocument from "pdfkit";

const COLORS = {
  ink: "#17251d",
  muted: "#596c60",
  green: "#26764b",
  paleGreen: "#eaf4ed",
  line: "#d7e2da",
  red: "#b74736",
  amber: "#b0781f",
  blue: "#315d83",
};

type GovernancePdfInput = {
  res: any;
  repoName: string;
  repoUrl: string;
  job: any;
  tasks: any[];
  findings: any[];
  decisions: any[];
  audit: any[];
  violations: any[];
  agents: any[];
};

const safeText = (value: unknown, fallback = "Not provided") => {
  const text = String(value ?? "").trim();
  return text || fallback;
};

const bar = (doc: PDFKit.PDFDocument, label: string, value: number, color = COLORS.green) => {
  const left = 52;
  const width = 490;
  const clamped = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  doc.font("Helvetica").fontSize(9).fillColor(COLORS.muted).text(label, left, doc.y, { continued: true });
  doc.font("Helvetica-Bold").fillColor(COLORS.ink).text(`${Math.round(clamped * 100)}%`, { align: "right" });
  const y = doc.y + 3;
  doc.roundedRect(left, y, width, 7, 3).fill(COLORS.line);
  if (clamped > 0) doc.roundedRect(left, y, Math.max(6, width * clamped), 7, 3).fill(color);
  doc.y = y + 17;
};

const ensureRoom = (doc: PDFKit.PDFDocument, height: number) => {
  if (doc.y + height > doc.page.height - 52) doc.addPage();
};

const section = (doc: PDFKit.PDFDocument, title: string) => {
  ensureRoom(doc, 44);
  doc.moveDown(0.65).font("Helvetica-Bold").fontSize(16).fillColor(COLORS.green).text(title);
  doc.moveDown(0.35).strokeColor(COLORS.line).lineWidth(1).moveTo(52, doc.y).lineTo(doc.page.width - 52, doc.y).stroke();
  doc.moveDown(0.55).font("Helvetica").fontSize(10).fillColor(COLORS.ink);
};

const metric = (doc: PDFKit.PDFDocument, label: string, value: string | number) => {
  ensureRoom(doc, 25);
  doc.font("Helvetica-Bold").fontSize(10).fillColor(COLORS.ink).text(`${label}: `, { continued: true });
  doc.font("Helvetica").fillColor(COLORS.muted).text(String(value));
};

const addFinding = (doc: PDFKit.PDFDocument, finding: any, index: number) => {
  const reviewer = finding.reviewModel
    ? `${finding.agentId || "AI agent"} · ${finding.reviewModel}`
    : `${finding.agentId || "AI specialist agent"} · RepoLens analysis`;
  const evidence = (finding.evidence || []).map((item: any) => item.label || `${item.kind}: ${item.ref}`);
  const paragraphs = [
    `${finding.category || "Finding"} | ${finding.severity || "LOW"} | Reviewed by ${reviewer}`,
    `Target: ${finding.targetLabel || finding.target || "Repository"}`,
    `Review statement: ${finding.claim || "No review statement was supplied."}`,
    `Risk: ${Number(finding.riskScore || 0).toFixed(2)}   Confidence: ${Number(finding.confidence || 0).toFixed(2)}   Critic: ${finding.reviewStatus || "Not reviewed"}`,
    `Evidence: ${evidence.length ? evidence.join("; ") : "No evidence references"}`,
  ];
  const width = doc.page.width - 112;
  const body = paragraphs.join("\n");
  const height = doc.heightOfString(body, { width, lineGap: 3 }) + 23;
  ensureRoom(doc, height + 8);
  const y = doc.y;
  doc.roundedRect(52, y, width + 8, height, 5).fill(index % 2 ? "#f7faf8" : "#eff6f1");
  doc.fillColor(COLORS.ink).font("Helvetica-Bold").fontSize(9).text(paragraphs[0], 62, y + 10, { width });
  doc.fillColor(COLORS.muted).font("Helvetica").fontSize(8.5).text(paragraphs.slice(1).join("\n"), 62, doc.y + 4, { width, lineGap: 3 });
  doc.y = y + height + 8;
};

export async function generateGovernancePDF(input: GovernancePdfInput) {
  const { res, job, tasks, findings, decisions, audit, violations, agents } = input;
  const doc = new PDFDocument({ size: "A4", margin: 52, bufferPages: true, info: { Title: "RepoLens Governance Report", Author: "RepoLens" } });
  const filename = `repolens-governance-${String(job._id)}.pdf`;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control", "no-store");
  doc.pipe(res);

  const severityCounts = ["CRITICAL", "HIGH", "MEDIUM", "LOW"].map((severity) => ({
    severity,
    count: findings.filter((finding) => (finding.severity || "LOW") === severity).length,
  }));
  const doneTasks = tasks.filter((task) => ["COMPLETED", "REUSED"].includes(task.status)).length;
  const averageRisk = decisions.length ? decisions.reduce((sum, item) => sum + Number(item.score || 0), 0) / decisions.length : 0;
  const averageAgreement = decisions.length ? decisions.reduce((sum, item) => sum + Number(item.agreement || 0), 0) / decisions.length : 0;
  const escalated = decisions.filter((decision) => decision.status === "ESCALATED").length;

  doc.rect(0, 0, doc.page.width, 250).fill(COLORS.paleGreen);
  doc.fillColor(COLORS.green).font("Helvetica-Bold").fontSize(11).text("REPOLENS  /  GOVERNED ANALYSIS", 52, 54, { characterSpacing: 1.6 });
  doc.fillColor(COLORS.ink).fontSize(28).text("Governance Report", 52, 100, { width: 470 });
  doc.fillColor(COLORS.green).fontSize(17).text(safeText(input.repoName), 52, 148, { width: 480 });
  doc.fillColor(COLORS.muted).font("Helvetica").fontSize(10).text(safeText(input.repoUrl, "Repository URL unavailable"), 52, 177, { width: 480 });
  doc.fillColor(COLORS.ink).font("Helvetica-Bold").fontSize(10).text(`Job status: ${job.status}     Generated: ${new Date().toLocaleString()}`, 52, 215);
  doc.y = 284;

  section(doc, "Executive summary");
  metric(doc, "Run ID", String(job._id));
  metric(doc, "Requested analyses", (job.analysisTypes || []).join(", ") || "None");
  metric(doc, "Workflow completion", `${doneTasks} of ${tasks.length} tasks completed or reused`);
  metric(doc, "Findings", findings.length);
  metric(doc, "Decisions", decisions.length);
  metric(doc, "Escalated decisions", escalated);
  metric(doc, "Policy events requiring attention", violations.length);
  metric(doc, "RAG indexing", job.ragIndexingStatus || "UNKNOWN");
  if (job.ragIndexingError) metric(doc, "RAG indexing detail", job.ragIndexingError);

  section(doc, "Risk and consensus profile");
  bar(doc, "Average decision risk", averageRisk, averageRisk >= 0.8 ? COLORS.red : COLORS.green);
  bar(doc, "Average agent agreement", averageAgreement, averageAgreement < 0.6 ? COLORS.amber : COLORS.blue);
  severityCounts.forEach(({ severity, count }) => {
    const fraction = findings.length ? count / findings.length : 0;
    bar(doc, `${severity} findings (${count})`, fraction, severity === "CRITICAL" || severity === "HIGH" ? COLORS.red : COLORS.green);
  });

  section(doc, "Agent task matrix");
  if (!tasks.length) doc.fillColor(COLORS.muted).text("No agent tasks were recorded for this run.");
  for (const task of tasks) {
    ensureRoom(doc, 28);
    doc.font("Helvetica-Bold").fontSize(9).fillColor(COLORS.ink).text(`${task.type}  /  ${task.assignedAgent}`, { continued: true });
    doc.font("Helvetica").fillColor(task.status === "FAILED" ? COLORS.red : COLORS.green).text(`   ${task.status}`);
    if (task.error) doc.fontSize(8).fillColor(COLORS.muted).text(`Reason: ${task.error}`, { indent: 12 });
  }

  section(doc, "Consensus decision matrix");
  if (!decisions.length) doc.fillColor(COLORS.muted).text("No consensus decisions were recorded.");
  decisions.forEach((decision: any) => {
    ensureRoom(doc, 75);
    doc.font("Helvetica-Bold").fontSize(10).fillColor(COLORS.ink).text(`${decision.category}  /  ${decision.targetLabel || decision.target || "Repository"}`);
    doc.font("Helvetica").fontSize(9).fillColor(COLORS.muted).text(`Outcome: ${decision.status}   Risk: ${Number(decision.score || 0).toFixed(2)}   Agreement: ${Number(decision.agreement || 0).toFixed(2)}`);
    doc.text(`Support: ${(decision.findings || []).length} findings   Dissent: ${(decision.dissent || []).length} findings   Audit sequence: ${decision.auditStartSeq ?? "—"} to ${decision.auditEndSeq ?? "—"}`);
    bar(doc, "Risk", Number(decision.score || 0), Number(decision.score || 0) > 0.8 ? COLORS.red : COLORS.green);
    bar(doc, "Agreement", Number(decision.agreement || 0), Number(decision.agreement || 0) < 0.6 ? COLORS.amber : COLORS.blue);
    doc.moveDown(0.35);
  });

  section(doc, "AI review statements and evidence");
  if (!findings.length) doc.fillColor(COLORS.muted).text("No findings were produced for this run.");
  const severityRank: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  const taskById = new Map(tasks.map((task) => [String(task._id), task]));
  [...findings].sort((a, b) => (severityRank[a.severity || "LOW"] ?? 4) - (severityRank[b.severity || "LOW"] ?? 4)).forEach((finding, index) => {
    const task = taskById.get(String(finding.taskId));
    const isGeminiReview = task?.assignedAgent === "qa" && Number(task.llmCalls || 0) > 0;
    addFinding(doc, {
      ...finding,
      reviewModel: isGeminiReview ? "Gemini 2.5 Flash · Repository Q&A" : undefined,
    }, index);
  });

  section(doc, "Governance and audit summary");
  metric(doc, "Active registered agents", agents.length);
  metric(doc, "Hash-linked audit entries for this job", audit.length);
  if (audit.length) metric(doc, "Audit sequence range", `${audit[0].seq} to ${audit[audit.length - 1].seq}`);
  const effectCounts = ["ALLOW", "DENY", "REDACT", "ESCALATE"].map((effect) => ({
    effect,
    count: audit.filter((entry) => entry.decision === effect).length,
  }));
  effectCounts.forEach(({ effect, count }) => metric(doc, `PEP ${effect}`, count));
  doc.moveDown(0.4).font("Helvetica").fontSize(8).fillColor(COLORS.muted)
    .text("Audit rows below are linked by the backend SHA-256 chain. Use the authenticated Governance API to verify the chain.");
  const auditRows = audit.slice(-100);
  if (audit.length > auditRows.length) doc.text(`Showing the latest ${auditRows.length} of ${audit.length} job audit events.`);
  for (const entry of auditRows) {
    ensureRoom(doc, 35);
    const actor = String(entry.actor || "unknown").startsWith("user:") ? "Human reviewer" : safeText(entry.actor);
    doc.font("Helvetica-Bold").fontSize(8).fillColor(COLORS.ink).text(`#${entry.seq} ${entry.decision} / ${entry.event} / ${entry.action}`);
    doc.font("Helvetica").fontSize(8).fillColor(COLORS.muted).text(`${actor} | ${new Date(entry.ts).toLocaleString()} | Policies: ${(entry.policyIds || []).join(", ") || "none"}${entry.reason ? ` | ${entry.reason}` : ""}`, { width: doc.page.width - 104 });
  }

  const range = doc.bufferedPageRange();
  for (let pageIndex = range.start; pageIndex < range.start + range.count; pageIndex += 1) {
    doc.switchToPage(pageIndex);
    doc.font("Helvetica").fontSize(8).fillColor(COLORS.muted)
      .text(`RepoLens Governance  |  ${String(job._id)}  |  ${pageIndex + 1}/${range.count}`, 52, doc.page.height - 34, { width: doc.page.width - 104, align: "center" });
  }
  doc.end();
}
