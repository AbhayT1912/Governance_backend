import PDFDocument from "pdfkit";
import { ChartJSNodeCanvas } from "chartjs-node-canvas";
import mongoose from "mongoose";
import { RepoReportModel } from "../models/repoReport.model";
import { RepoModel } from "../models/repo.model";

const CHART_WIDTH = 820;
const CHART_HEIGHT = 380;
const chartCanvas = new ChartJSNodeCanvas({
  width: CHART_WIDTH,
  height: CHART_HEIGHT,
});

const PRIMARY = "#1a237e";
const ACCENT = "#0d47a1";
const sectionTitle = (doc: PDFKit.PDFDocument, title: string) => {
  doc.moveDown(0.6);
  doc.fontSize(16).fillColor(PRIMARY).text(title, { underline: true });
  doc.moveDown(0.4);
  doc.fillColor("black").fontSize(11);
};

const metricRow = (
  doc: PDFKit.PDFDocument,
  label: string,
  value: string | number | undefined | null
) => {
  doc.font("Helvetica-Bold").text(`${label}: `, { continued: true });
  doc.font("Helvetica").text(`${value ?? "N/A"}`);
};

/* ===================================================
   MAIN ENTERPRISE PDF GENERATOR
=================================================== */

export const generateExecutivePDF = async (repoId: string, res: any) => {
  const repoObjectId = new mongoose.Types.ObjectId(repoId);

  const repo: any = await RepoModel.findById(repoId);
  const report: any = await RepoReportModel.findOne({
    repo_id: repoObjectId,
  });

  if (!repo || !report) {
    throw new Error("Report not found");
  }

  const doc = new PDFDocument({ margin: 45, size: "A4" });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename=${repo.name}_Enterprise_Report.pdf`
  );

  doc.pipe(res);

  /* ===============================================
     COVER PAGE - ENGINEERING MATURITY
  =============================================== */

  doc.fontSize(26)
    .fillColor(PRIMARY)
    .text("CodeLens Engineering Intelligence Report", { align: "center" });

  doc.moveDown(1.2);

  doc.fontSize(18).fillColor("black");
  doc.text(`Repository: ${repo.name}`, { align: "center" });
  doc.text(`Generated On: ${new Date().toLocaleString()}`, { align: "center" });

  doc.moveDown(1.5);

  const maturity = report.engineering_maturity || report.maturity;

  doc.fontSize(40)
    .fillColor(ACCENT)
    .text(maturity?.maturity_score ?? "N/A", { align: "center" });

  doc.fontSize(22)
    .fillColor(PRIMARY)
    .text(`Grade: ${maturity?.maturity_grade ?? "N/A"}`, { align: "center" });

  doc.moveDown(1);

  doc.fontSize(14).fillColor("black");
  doc.text(`Architecture Health Score: ${report.architecture_health_score ?? "N/A"}`, {
    align: "center",
  });
  doc.text(`Layer Health Score: ${report.layer_analysis?.layer_health_score ?? "N/A"}`, {
    align: "center",
  });

  doc.addPage();

  /* ===============================================
     INVESTOR EXECUTIVE SUMMARY
  =============================================== */

  sectionTitle(doc, "Investor Executive Summary");
  doc.text(report.overview || "No overview available.");
  doc.moveDown(0.6);

  const investor = report.investor_summary;

  if (investor) {
    metricRow(doc, "Risk Level", investor.risk_level);
    metricRow(doc, "Average Complexity", investor.avg_complexity);
    metricRow(doc, "Dead Functions", investor.dead_functions);
    metricRow(doc, "Layer Violations", investor.total_layer_violations);
    metricRow(doc, "Repository Density", investor.repo_density);
    doc.moveDown(0.4);
    doc.text(investor.strategic_note);
  }

  /* ===============================================
     COMPLEXITY METRICS + CHART
  =============================================== */

  doc.addPage();
  sectionTitle(doc, "Complexity Metrics");

  const complexity = report.complexity_metrics;

  if (complexity) {
    metricRow(doc, "Average Complexity", complexity.average_complexity);
    metricRow(doc, "Max Complexity", complexity.max_complexity);

    const chartImage = await chartCanvas.renderToBuffer({
      type: "bar",
      data: {
        labels: ["Average", "Max"],
        datasets: [
          {
            label: "Complexity",
            data: [complexity.average_complexity, complexity.max_complexity],
            backgroundColor: ["#42a5f5", "#ef5350"],
          },
        ],
      },
      options: {
        responsive: false,
        plugins: {
          legend: { display: false },
        },
      },
    });

    doc.moveDown(0.4);
    doc.image(chartImage, {
      width: 460,
      align: "center",
    });
  }

  /* ===============================================
     RISK EXPOSURE HEAT SECTION
  =============================================== */

  doc.addPage();
  sectionTitle(doc, "Risk Exposure Heat Map");

  const risk = report.risk_exposure || report.risk_exposure_heat;

  if (risk) {
    metricRow(doc, "Complexity Risk Score", risk.complexity_risk_score);
    metricRow(doc, "Dead Code Risk Score", risk.dead_code_risk_score);
    metricRow(doc, "Layer Violation Risk Score", risk.layer_violation_risk_score);
    metricRow(
      doc,
      "Dependency Density Risk Score",
      risk.dependency_density_risk_score
    );

    const heatChart = await chartCanvas.renderToBuffer({
      type: "bar",
      data: {
        labels: [
          "Complexity",
          "Dead Code",
          "Layer Violations",
          "Dependency Density",
        ],
        datasets: [
          {
            label: "Risk Score",
            data: [
              risk.complexity_risk_score,
              risk.dead_code_risk_score,
              risk.layer_violation_risk_score,
              risk.dependency_density_risk_score,
            ],
            backgroundColor: ["#e53935", "#fb8c00", "#8e24aa", "#1e88e5"],
          },
        ],
      },
      options: {
        responsive: false,
        indexAxis: "y",
        scales: {
          x: { min: 0, max: 100 },
        },
      },
    });

    doc.moveDown(0.4);
    doc.image(heatChart, {
      width: 500,
      align: "center",
    });
  } else {
    doc.text("Risk exposure data is unavailable for this report.");
    doc.moveDown(0.6);
  }

  /* ===============================================
     RISK RANKING - TOP 5 FILES
  =============================================== */

  doc.addPage();
  sectionTitle(doc, "Top Risky Files");

  const riskyFiles = report.dependency_density?.file_density
    ?.sort((a: any, b: any) => b.density_score - a.density_score)
    .slice(0, 5);

  if (riskyFiles?.length) {
    riskyFiles.forEach((file: any, index: number) => {
      const filePath = file.path || "unknown";
      const score = file.density_score ?? 0;
      doc.text(`${index + 1}. ${filePath} - Risk Score: ${score}`);
    });
  } else {
    doc.text("No file-level dependency density data available.");
  }

  /* ===============================================
     LAYER ANALYSIS VISUALIZATION
  =============================================== */

  doc.addPage();
  sectionTitle(doc, "Layer Analysis");

  const layer = report.layer_analysis;

  if (layer) {
    metricRow(doc, "Layer Health Score", layer.layer_health_score);
    metricRow(doc, "Total Violations", layer.total_violations);

    const labels = Object.keys(layer.layer_matrix || {});
    const values = labels.map((label) =>
      Number(
        Object.values(layer.layer_matrix[label]).reduce(
          (sum: any, count: any) => Number(sum) + Number(count),
          0
        )
      )
    );

    if (labels.length > 0) {
      const layerChart = await chartCanvas.renderToBuffer({
        type: "pie",
        data: {
          labels,
          datasets: [
            {
              data: values,
              backgroundColor: ["#1e88e5", "#43a047", "#fb8c00", "#8e24aa", "#d81b60"],
            },
          ],
        },
        options: {
          responsive: false,
        },
      });

      doc.moveDown(0.4);
      doc.image(layerChart, {
        width: 360,
        align: "center",
      });
    } else {
      doc.text("Layer matrix is empty.");
    }
  }

  /* ===============================================
     FOOTER
  =============================================== */

  doc.addPage();
  doc.moveDown(1);
  doc.fontSize(10).fillColor("gray").text(
    "Generated by CodeLens AI - Confidential - Enterprise Intelligence Report",
    {
      align: "center",
    }
  );

  doc.end();
};
