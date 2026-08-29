"use client";

import Papa from "papaparse";
import YAML from "yaml";
import JSZip from "jszip";
import mammoth from "mammoth";
import type { ParsedSegment, ParsedSource, ResearchCoverage } from "@/lib/types";

export const CODE_EXTENSIONS = [
  "py", "ipynb", "js", "jsx", "ts", "tsx",
  "java", "c", "h", "cpp", "hpp", "cc", "cxx", "cs", "cu", "cuh",
  "go", "rs", "kt", "kts", "swift", "scala",
  "rb", "php", "lua", "dart", "r", "m",
  "sh", "bash", "zsh", "ps1", "bat", "cmd",
  "sql", "html", "htm", "css", "scss", "less", "vue", "svelte",
  "xml", "toml", "ini", "cfg", "conf", "proto", "tex", "urdf", "xacro", "sdf", "usda",
] as const;

const CODE_EXTENSION_SET = new Set<string>(CODE_EXTENSIONS);

export const RESEARCH_EXTENSIONS = new Set<string>([
  "csv", "txt", "md", "log", "json", "yaml", "yml", "pdf", "ipynb", ...CODE_EXTENSIONS,
]);

export const MANUAL_FILE_EXTENSIONS = new Set<string>([...RESEARCH_EXTENSIONS, "zip"]);

export const IGNORED_PROJECT_DIRS = new Set([
  ".git", ".next", ".idea", ".vscode",
  "node_modules", "dist", "build", "coverage",
  "venv", ".venv", "env", "__pycache__", ".pytest_cache",
  "checkpoints", "checkpoint", "weights",
  "wandb", "runs", "outputs", "artifacts",
]);

const MAX_ZIP_SIZE = 80 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 400;
const MAX_ZIP_INNER_FILE_SIZE = 30 * 1024 * 1024;
const MAX_PDF_PAGES = 500;
const MAX_SEGMENT_CHARS = 14_000;

// Large machine-readable files are not keyword-filtered anymore.
// Every row/line is scanned in the browser, then represented by bounded
// coverage digests plus raw excerpts. Human-written documents stay raw.
const FULL_COVERAGE_COMPRESSION_THRESHOLD = 22_000;
// Full coverage means every row/line is scanned in the browser, not that every
// raw character is sent to the model. These targets keep a compact digest +
// representative raw evidence from every region of large machine-readable files.
const FAST_LOG_BLOCKS = 28;
const FAST_CODE_BLOCKS = 30;
const FAST_CSV_BLOCKS = 24;
const PRECISE_LOG_BLOCKS = 44;
const PRECISE_CODE_BLOCKS = 48;
const PRECISE_CSV_BLOCKS = 38;
// Fast keeps the current balanced profile. Precise roughly doubles the AI context
// and also preserves denser raw anchors inside each full-scanned machine file.
const FAST_AI_ANALYSIS_CHARS = 360_000;
const PRECISE_AI_ANALYSIS_CHARS = 680_000;

export type AnalysisDepth = "fast" | "precise";

export type PreprocessOptions = {
  depth?: AnalysisDepth;
  analysisTargetChars?: number;
};

function detailProfile(depth: AnalysisDepth) {
  return depth === "precise"
    ? {
        logBlocks: PRECISE_LOG_BLOCKS,
        codeBlocks: PRECISE_CODE_BLOCKS,
        csvBlocks: PRECISE_CSV_BLOCKS,
        logTopLines: 5,
        logTopStats: 6,
        logContext: 18,
        codeTopLines: 6,
        codeContextRadius: 2,
        codeContext: 24,
        csvTopRows: 4,
        csvPreferredColumns: 10,
        csvExtremaColumns: 4,
      }
    : {
        logBlocks: FAST_LOG_BLOCKS,
        codeBlocks: FAST_CODE_BLOCKS,
        csvBlocks: FAST_CSV_BLOCKS,
        logTopLines: 3,
        logTopStats: 4,
        logContext: 12,
        codeTopLines: 4,
        codeContextRadius: 1,
        codeContext: 16,
        csvTopRows: 2,
        csvPreferredColumns: 6,
        csvExtremaColumns: 2,
      };
}

export type PreprocessResult = {
  sources: ParsedSource[];
  warnings: string[];
  ignoredFiles: number;
  expandedFiles: number;
  inputTextChars: number;
  extractedChars: number;
  compressedFiles: number;
  analysisBudgetApplied: boolean;
  analysisBudgetChars: number;
  // Kept as an alias so older UI code/patches do not break.
  reducedFiles: number;
  coverage: ResearchCoverage;
};

export type AnalysisBatch = {
  batch_id: string;
  text: string;
  source_ids: string[];
  char_count: number;
};

type NamedBlob = {
  blob: Blob;
  name: string;
  type?: string;
};

type CoverageDelta = {
  text_lines_scanned?: number;
  log_lines_scanned?: number;
  code_lines_scanned?: number;
  csv_rows_scanned?: number;
  pdf_pages_scanned?: number;
  notebook_cells_scanned?: number;
  coverage_blocks?: number;
  raw_evidence_segments?: number;
};

type ParsedBlobResult = {
  source: ParsedSource;
  inputChars: number;
  compressed: boolean;
  coverage: CoverageDelta;
  warnings?: string[];
};

export function extensionOf(name: string) {
  const clean = name.split("?")[0].split("#")[0].toLowerCase();
  const parts = clean.split(".");
  return parts.length > 1 ? parts.at(-1)! : "";
}

export function shouldIgnoreProjectPath(name: string) {
  const parts = name.replace(/\\/g, "/").toLowerCase().split("/");
  return parts.some((part) => IGNORED_PROJECT_DIRS.has(part));
}

function normalizePath(name: string) {
  return name
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\0/g, "")
    .replace(/\/{2,}/g, "/")
    .trim();
}

function splitPreservingText(text: string, location: string, kind: ParsedSegment["kind"] = "raw"): ParsedSegment[] {
  if (!text.trim()) return [];
  if (text.length <= MAX_SEGMENT_CHARS) return [{ location, text, kind }];

  const segments: ParsedSegment[] = [];
  let part = 1;
  for (let offset = 0; offset < text.length; offset += MAX_SEGMENT_CHARS) {
    const slice = text.slice(offset, offset + MAX_SEGMENT_CHARS);
    if (!slice.trim()) continue;
    segments.push({ location: `${location}, part ${part++}`, text: slice, kind });
  }
  return segments;
}

function chunkLines(text: string, chunkSize = 35, label = "lines"): ParsedSegment[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const segments: ParsedSegment[] = [];
  for (let i = 0; i < lines.length; i += chunkSize) {
    const end = Math.min(i + chunkSize, lines.length);
    const raw = lines.slice(i, end).join("\n");
    if (!raw.trim()) continue;
    segments.push(...splitPreservingText(raw, `${label} ${i + 1}-${end}`, "raw"));
  }
  return segments;
}

function addRange(target: Set<number>, start: number, end: number, total: number) {
  const from = Math.max(0, start);
  const to = Math.min(total - 1, end);
  for (let i = from; i <= to; i++) target.add(i);
}

function segmentsFromSelectedLines(lines: string[], selected: Set<number>, maxRunLines = 32): ParsedSegment[] {
  const indexes = Array.from(selected)
    .filter((index) => index >= 0 && index < lines.length)
    .sort((a, b) => a - b);
  if (!indexes.length) return [];

  const segments: ParsedSegment[] = [];
  let runStart = indexes[0];
  let previous = indexes[0];

  const flushRun = (start: number, end: number) => {
    for (let cursor = start; cursor <= end; cursor += maxRunLines) {
      const chunkEnd = Math.min(end, cursor + maxRunLines - 1);
      const raw = lines.slice(cursor, chunkEnd + 1).join("\n");
      if (!raw.trim()) continue;
      segments.push(...splitPreservingText(raw, `lines ${cursor + 1}-${chunkEnd + 1}`, "raw"));
    }
  };

  for (let i = 1; i < indexes.length; i++) {
    const current = indexes[i];
    if (current === previous + 1) {
      previous = current;
      continue;
    }
    flushRun(runStart, previous);
    runStart = current;
    previous = current;
  }
  flushRun(runStart, previous);
  return segments;
}

function adaptiveBlockSize(total: number, targetBlocks: number, minimum: number) {
  return Math.max(minimum, Math.ceil(total / Math.max(1, targetBlocks)));
}

function nonEmptyIndexes(lines: string[], start: number, end: number) {
  const indexes: number[] = [];
  for (let i = start; i < end; i++) {
    if (lines[i]?.trim()) indexes.push(i);
  }
  return indexes;
}

function addRepresentativeIndexes(target: Set<number>, indexes: number[], total: number) {
  if (!indexes.length) return;
  const first = indexes[0];
  const last = indexes[indexes.length - 1];
  const middle = indexes[Math.floor(indexes.length / 2)];
  addRange(target, first, first + 1, total);
  addRange(target, middle - 1, middle + 1, total);
  addRange(target, last - 1, last, total);
}

function addSingleRepresentativeIndexes(target: Set<number>, indexes: number[]) {
  if (!indexes.length) return;
  target.add(indexes[0]);
  target.add(indexes[Math.floor(indexes.length / 2)]);
  target.add(indexes[indexes.length - 1]);
}

function lineSignalScore(line: string, mode: "log" | "code") {
  let score = 0;
  const strongMetric = /\b(f1|macro[-_ ]?f1|micro[-_ ]?f1|accuracy|precision|recall|auc|auroc|map|mAP|bleu|rouge|wer|cer|rmse|mae|mse)\b/i;
  const resultTerm = /\b(test|validation|valid|val|eval|evaluation|best|final|result|summary|baseline|ablation|checkpoint)\b/i;
  const issueTerm = /\b(error|warning|exception|traceback|failed|failure|nan|inf)\b/i;
  const configTerm = /\b(seed|learning.?rate|\blr\b|batch.?size|epoch|threshold|optimizer|scheduler|weight.?decay|dropout|window|hop|sample.?rate|class.?weight|criterion)\b/i;
  const routineMetric = /\b(loss|train|epoch|step|iter(?:ation)?)\b/i;
  const numericKv = /[A-Za-z][A-Za-z0-9_./ -]{1,32}\s*[:=]\s*-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/i;

  if (strongMetric.test(line)) score += 8;
  if (resultTerm.test(line)) score += 7;
  if (issueTerm.test(line)) score += 7;
  if (configTerm.test(line)) score += 5;
  if (routineMetric.test(line)) score += 2;
  if (numericKv.test(line)) score += 2;

  if (mode === "code") {
    if (/^\s*(?:export\s+)?(?:async\s+)?(?:def|class|function|interface|type|enum|struct|fn|func)\b/i.test(line)) score += 10;
    if (/^\s*(?:import|from|require\(|#include|using\s|package\s)/i.test(line)) score += 4;
    if (/\b(train|fit|evaluate|validate|test|predict|inference|forward|backward|dataloader|dataset|transform)\b/i.test(line)) score += 5;
  }
  return score;
}

function compressLogFullCoverage(text: string, depth: AnalysisDepth = "fast"): { segments: ParsedSegment[]; compressed: boolean; blocks: number; lineCount: number } {
  const profile = detailProfile(depth);
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (text.length <= FULL_COVERAGE_COMPRESSION_THRESHOLD) {
    return { segments: chunkLines(text, 30), compressed: false, blocks: 0, lineCount: lines.length };
  }

  const blockSize = adaptiveBlockSize(lines.length, profile.logBlocks, 1_200);
  const segments: ParsedSegment[] = [];
  let blockCount = 0;

  for (let start = 0; start < lines.length; start += blockSize) {
    const end = Math.min(lines.length, start + blockSize);
    const selected = new Set<number>();
    const indexes = nonEmptyIndexes(lines, start, end);
    addSingleRepresentativeIndexes(selected, indexes);

    const scored: Array<{ index: number; score: number }> = [];
    const counts = { metric: 0, result: 0, issue: 0, config: 0, routine: 0, numeric: 0 };
    const numericStats = new Map<string, NumericStat>();

    for (let index = start; index < end; index++) {
      const line = lines[index] || "";
      if (!line.trim()) continue;
      const score = lineSignalScore(line, "log");
      if (score > 0) scored.push({ index, score });
      if (/\b(f1|accuracy|precision|recall|auc|auroc|rmse|mae|mse)\b/i.test(line)) counts.metric++;
      if (/\b(test|validation|valid|val|eval|best|final|result|summary|baseline|ablation|checkpoint)\b/i.test(line)) counts.result++;
      if (/\b(error|warning|exception|traceback|failed|failure|nan|inf)\b/i.test(line)) counts.issue++;
      if (/\b(seed|learning.?rate|\blr\b|batch.?size|threshold|optimizer|scheduler|weight.?decay|dropout|window|hop|sample.?rate)\b/i.test(line)) counts.config++;
      if (/\b(loss|train|epoch|step|iter(?:ation)?)\b/i.test(line)) counts.routine++;
      const matches = line.matchAll(/([A-Za-z][A-Za-z0-9_./ -]{1,30})\s*[:=]\s*(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/gi);
      for (const match of matches) {
        counts.numeric++;
        const key = match[1].trim().replace(/\s+/g, " ").slice(0, 40);
        const value = Number(match[2]);
        if (!Number.isFinite(value)) continue;
        const current = numericStats.get(key);
        if (!current) {
          numericStats.set(key, { count: 1, sum: value, min: value, max: value, minIndex: index, maxIndex: index });
        } else {
          current.count++;
          current.sum += value;
          if (value < current.min) {
            current.min = value;
            current.minIndex = index;
          }
          if (value > current.max) {
            current.max = value;
            current.maxIndex = index;
          }
        }
      }
    }

    // Keep only a small number of exact lines per region. The full block still
    // contributes deterministic counts/statistics, so coverage is not lost.
    scored
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, profile.logTopLines)
      .forEach(({ index }) => selected.add(index));

    const topStats = Array.from(numericStats.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, profile.logTopStats);
    topStats.forEach(([, stat]) => {
      selected.add(stat.minIndex);
      selected.add(stat.maxIndex);
    });
    const numericSummary = topStats
      .map(([key, stat]) => `${key}: n=${stat.count}, min=${formatNumber(stat.min)}@L${stat.minIndex + 1}, max=${formatNumber(stat.max)}@L${stat.maxIndex + 1}, mean=${formatNumber(stat.sum / stat.count)}`)
      .join("; ");

    const digest = [
      `[FULL_SCAN] lines ${start + 1}-${end}; ${indexes.length} non-empty.`,
      `signals metric=${counts.metric}, result=${counts.result}, issue=${counts.issue}, config=${counts.config}, train/step=${counts.routine}, numeric=${counts.numeric}.`,
      numericSummary ? `stats ${numericSummary}` : "stats none detected.",
    ].join("\n");

    segments.push({ location: `lines ${start + 1}-${end} full-coverage digest`, text: digest, kind: "coverage_digest" });
    segments.push(...segmentsFromSelectedLines(lines, selected, profile.logContext));
    blockCount++;
  }

  return { segments, compressed: true, blocks: blockCount, lineCount: lines.length };
}

function compressCodeFullCoverage(text: string, depth: AnalysisDepth = "fast"): { segments: ParsedSegment[]; compressed: boolean; blocks: number; lineCount: number } {
  const profile = detailProfile(depth);
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (text.length <= FULL_COVERAGE_COMPRESSION_THRESHOLD) {
    return { segments: chunkLines(text, 40), compressed: false, blocks: 0, lineCount: lines.length };
  }

  const blockSize = adaptiveBlockSize(lines.length, profile.codeBlocks, 900);
  const segments: ParsedSegment[] = [];
  let blockCount = 0;

  for (let start = 0; start < lines.length; start += blockSize) {
    const end = Math.min(lines.length, start + blockSize);
    const selected = new Set<number>();
    const indexes = nonEmptyIndexes(lines, start, end);
    addSingleRepresentativeIndexes(selected, indexes);

    const scored: Array<{ index: number; score: number }> = [];
    const definitions: string[] = [];
    const counts = { definitions: 0, imports: 0, branches: 0, loops: 0, returns: 0, config: 0, execution: 0 };

    for (let index = start; index < end; index++) {
      const line = lines[index] || "";
      if (!line.trim()) continue;
      const score = lineSignalScore(line, "code");
      if (score > 0) scored.push({ index, score });

      if (/^\s*(?:export\s+)?(?:async\s+)?(?:def|class|function|interface|type|enum|struct|fn|func)\b/i.test(line)) {
        counts.definitions++;
        if (definitions.length < 6) definitions.push(`L${index + 1}: ${line.trim().slice(0, 120)}`);
      }
      if (/^\s*(?:import|from|require\(|#include|using\s|package\s)/i.test(line)) counts.imports++;
      if (/\b(if|else|elif|switch|case|match|when)\b/.test(line)) counts.branches++;
      if (/\b(for|while|loop)\b/.test(line)) counts.loops++;
      if (/\breturn\b/.test(line)) counts.returns++;
      if (/\b(seed|learning.?rate|\blr\b|batch.?size|epoch|threshold|optimizer|scheduler|dropout|weight.?decay|window|hop|sample.?rate|loss|criterion|metric)\b/i.test(line)) counts.config++;
      if (/\b(train|fit|evaluate|validation|validate|test|predict|inference|forward|backward|step|checkpoint|dataloader|dataset|transform)\b/i.test(line)) counts.execution++;
    }

    scored
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, profile.codeTopLines)
      .forEach(({ index }) => addRange(selected, index - profile.codeContextRadius, index + profile.codeContextRadius, lines.length));

    const digest = [
      `[FULL_SCAN] code lines ${start + 1}-${end}; ${indexes.length} non-empty.`,
      `structure def=${counts.definitions}, import=${counts.imports}, branch=${counts.branches}, loop=${counts.loops}, return=${counts.returns}, research-config=${counts.config}, train/eval/infer=${counts.execution}.`,
      definitions.length ? `defs ${definitions.join(" | ")}` : "defs none in this block.",
    ].join("\n");

    segments.push({ location: `lines ${start + 1}-${end} full-coverage digest`, text: digest, kind: "coverage_digest" });
    segments.push(...segmentsFromSelectedLines(lines, selected, profile.codeContext));
    blockCount++;
  }

  return { segments, compressed: true, blocks: blockCount, lineCount: lines.length };
}

function rowScore(row: Record<string, string>) {
  let score = 0;
  const importantKey = /\b(f1|accuracy|acc|precision|recall|auc|loss|score|metric|result|test|val|valid|eval|best|final|baseline|ablation|epoch|seed|lr|learning.?rate|batch|threshold)\b/i;
  const importantValue = /\b(test|validation|valid|val|eval|best|final|baseline|ablation|summary|result|error|failed)\b/i;

  for (const [key, rawValue] of Object.entries(row)) {
    const value = String(rawValue ?? "");
    if (importantKey.test(key)) score += 3;
    if (importantValue.test(value)) score += 5;
    if (/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value.trim())) score += 1;
  }
  return score;
}

type NumericStat = {
  count: number;
  sum: number;
  min: number;
  max: number;
  minIndex: number;
  maxIndex: number;
};

function updateNumericStats(stats: Map<string, NumericStat>, row: Record<string, string>, rowIndex: number) {
  for (const [column, raw] of Object.entries(row)) {
    const valueText = String(raw ?? "").trim();
    if (!valueText || !/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(valueText)) continue;
    const value = Number(valueText);
    if (!Number.isFinite(value)) continue;
    const current = stats.get(column);
    if (!current) {
      stats.set(column, { count: 1, sum: value, min: value, max: value, minIndex: rowIndex, maxIndex: rowIndex });
      continue;
    }
    current.count++;
    current.sum += value;
    if (value < current.min) {
      current.min = value;
      current.minIndex = rowIndex;
    }
    if (value > current.max) {
      current.max = value;
      current.maxIndex = rowIndex;
    }
  }
}

function preferredNumericColumns(columns: string[], stats: Map<string, NumericStat>, limit = 12) {
  const metricLike = /f1|accuracy|acc|precision|recall|auc|loss|score|metric|rmse|mae|mse|epoch|step|time|latency/i;
  return columns
    .filter((column) => stats.has(column))
    .sort((a, b) => {
      const aMetric = metricLike.test(a) ? 1 : 0;
      const bMetric = metricLike.test(b) ? 1 : 0;
      if (aMetric !== bMetric) return bMetric - aMetric;
      return (stats.get(b)?.count || 0) - (stats.get(a)?.count || 0);
    })
    .slice(0, limit);
}

function formatNumber(value: number) {
  if (!Number.isFinite(value)) return "n/a";
  if (Math.abs(value) >= 10000 || (Math.abs(value) > 0 && Math.abs(value) < 0.0001)) return value.toExponential(5);
  return Number(value.toPrecision(7)).toString();
}

function compressCsvFullCoverage(
  data: Record<string, string>[],
  columns: string[],
  inputChars: number,
  depth: AnalysisDepth = "fast",
): { segments: ParsedSegment[]; compressed: boolean; blocks: number; rowCount: number } {
  const profile = detailProfile(depth);
  const rowCount = data.length;
  const shouldCompress = inputChars > FULL_COVERAGE_COMPRESSION_THRESHOLD || rowCount > 250;
  if (!shouldCompress) {
    return {
      segments: [
        { location: "CSV structure", text: `columns: ${columns.join(", ")}\nrows scanned: ${rowCount}`, kind: "coverage_digest" },
        ...data.flatMap((row, index) => splitPreservingText(JSON.stringify(row), `row ${index + 2}`, "raw")),
      ],
      compressed: false,
      blocks: 1,
      rowCount,
    };
  }

  const blockSize = adaptiveBlockSize(rowCount, profile.csvBlocks, 1_200);
  const segments: ParsedSegment[] = [];
  let blockCount = 0;
  const globalStats = new Map<string, NumericStat>();

  // Full pass: every row/value participates in deterministic statistics.
  data.forEach((row, index) => updateNumericStats(globalStats, row, index));
  const preferredGlobal = preferredNumericColumns(columns, globalStats, 10);
  const globalSummary = preferredGlobal.map((column) => {
    const stat = globalStats.get(column)!;
    return `${column}: n=${stat.count}, min=${formatNumber(stat.min)}@row${stat.minIndex + 2}, max=${formatNumber(stat.max)}@row${stat.maxIndex + 2}, mean=${formatNumber(stat.sum / stat.count)}`;
  });
  segments.push({
    location: "CSV full-coverage summary",
    kind: "coverage_digest",
    text: [
      `[FULL_SCAN] CSV rows=${rowCount}; columns(${columns.length})=${columns.slice(0, 60).join(", ")}${columns.length > 60 ? ", …" : ""}.`,
      globalSummary.length ? `global stats ${globalSummary.join("; ")}` : "global stats none detected.",
    ].join("\n"),
  });

  for (let start = 0; start < rowCount; start += blockSize) {
    const end = Math.min(rowCount, start + blockSize);
    const blockStats = new Map<string, NumericStat>();
    const candidates: Array<{ index: number; score: number }> = [];

    for (let index = start; index < end; index++) {
      const row = data[index];
      updateNumericStats(blockStats, row, index);
      const score = rowScore(row);
      if (score > 0) candidates.push({ index, score });
    }

    const selected = new Set<number>();
    if (start < end) {
      selected.add(start);
      selected.add(Math.floor((start + end - 1) / 2));
      selected.add(end - 1);
    }
    candidates
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, profile.csvTopRows)
      .forEach(({ index }) => selected.add(index));

    const preferred = preferredNumericColumns(columns, blockStats, profile.csvPreferredColumns);
    preferred.slice(0, profile.csvExtremaColumns).forEach((column) => {
      const stat = blockStats.get(column);
      if (!stat) return;
      selected.add(stat.minIndex);
      selected.add(stat.maxIndex);
    });

    const statLines = preferred.map((column) => {
      const stat = blockStats.get(column)!;
      return `${column}: n=${stat.count}, min=${formatNumber(stat.min)}@row${stat.minIndex + 2}, max=${formatNumber(stat.max)}@row${stat.maxIndex + 2}, mean=${formatNumber(stat.sum / stat.count)}`;
    });
    segments.push({
      location: `rows ${start + 2}-${end + 1} full-coverage digest`,
      kind: "coverage_digest",
      text: [
        `[FULL_SCAN] CSV data rows ${start + 1}-${end} (${end - start}).`,
        statLines.length ? `stats ${statLines.join("; ")}` : "stats none detected.",
        `raw rows kept ${Array.from(selected).sort((a, b) => a - b).map((index) => index + 2).join(", ")}.`,
      ].join("\n"),
    });

    Array.from(selected)
      .sort((a, b) => a - b)
      .forEach((index) => {
        const row = data[index];
        if (row) segments.push(...splitPreservingText(JSON.stringify(row), `row ${index + 2}`, "raw"));
      });
    blockCount++;
  }

  return { segments, compressed: true, blocks: blockCount + 1, rowCount };
}

async function getPdfJs() {
  const pdfjs = await import("pdfjs-dist/build/pdf.mjs");
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;
  }
  return pdfjs;
}

async function parsePdf(blob: Blob): Promise<{ segments: ParsedSegment[]; pagesRead: number; totalPages: number; warning?: string }> {
  const pdfjs = await getPdfJs();
  const data = new Uint8Array(await blob.arrayBuffer());
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
  const pages: ParsedSegment[] = [];
  const maxPages = Math.min(doc.numPages, MAX_PDF_PAGES);

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    const items = content.items as Array<{ str?: unknown }>;
    const text = items
      .map((item) => ("str" in item ? String(item.str ?? "") : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text) pages.push(...splitPreservingText(text, `page ${pageNumber}`, "raw"));
  }

  return {
    segments: pages,
    pagesRead: maxPages,
    totalPages: doc.numPages,
    warning: doc.numPages > MAX_PDF_PAGES
      ? `PDF가 ${doc.numPages}페이지라 안전 한도 ${MAX_PDF_PAGES}페이지까지만 읽었습니다.`
      : undefined,
  };
}

async function parseResearchBlob(input: NamedBlob, sourceId: string, depth: AnalysisDepth = "fast"): Promise<ParsedBlobResult> {
  const name = normalizePath(input.name);
  const ext = extensionOf(name);
  const type = ext || input.type || "unknown";

  if (["txt", "md"].includes(ext)) {
    const text = await input.blob.text();
    const lineCount = text.replace(/\r\n/g, "\n").split("\n").length;
    return {
      source: { source_id: sourceId, name, type, segments: chunkLines(text, 30) },
      inputChars: text.length,
      compressed: false,
      coverage: { text_lines_scanned: lineCount },
    };
  }

  if (ext === "log") {
    const text = await input.blob.text();
    const result = compressLogFullCoverage(text, depth);
    return {
      source: { source_id: sourceId, name, type, segments: result.segments },
      inputChars: text.length,
      compressed: result.compressed,
      coverage: { log_lines_scanned: result.lineCount, coverage_blocks: result.blocks },
    };
  }

  if (CODE_EXTENSION_SET.has(ext) && ext !== "ipynb") {
    const text = await input.blob.text();
    const result = compressCodeFullCoverage(text, depth);
    return {
      source: { source_id: sourceId, name, type, segments: result.segments },
      inputChars: text.length,
      compressed: result.compressed,
      coverage: { code_lines_scanned: result.lineCount, coverage_blocks: result.blocks },
    };
  }

  if (ext === "ipynb") {
    const raw = await input.blob.text();
    const parsed = JSON.parse(raw) as {
      cells?: Array<{ cell_type?: string; source?: string | string[]; outputs?: unknown[] }>;
    };
    const segments: ParsedSegment[] = [];
    let compressedAny = false;
    let coverageBlocks = 0;
    let codeLines = 0;
    let textLines = 0;
    const cells = parsed.cells || [];

    cells.forEach((cell, index) => {
      const source = Array.isArray(cell.source) ? cell.source.join("") : String(cell.source || "");
      const text = source.trim();
      if (!text) return;
      const cellType = cell.cell_type === "markdown" ? "markdown" : "code";
      const lineCount = source.replace(/\r\n/g, "\n").split("\n").length;
      if (cellType === "code") {
        codeLines += lineCount;
        const compressed = compressCodeFullCoverage(source, depth);
        compressedAny ||= compressed.compressed;
        coverageBlocks += compressed.blocks;
        compressed.segments.forEach((segment) => {
          segments.push({ ...segment, location: `cell ${index + 1} (code), ${segment.location}` });
        });
      } else {
        textLines += lineCount;
        chunkLines(source, 30).forEach((segment) => {
          segments.push({ ...segment, location: `cell ${index + 1} (markdown), ${segment.location}` });
        });
      }
    });

    return {
      source: { source_id: sourceId, name, type, segments },
      inputChars: raw.length,
      compressed: compressedAny,
      coverage: {
        notebook_cells_scanned: cells.length,
        code_lines_scanned: codeLines,
        text_lines_scanned: textLines,
        coverage_blocks: coverageBlocks,
      },
    };
  }

  if (ext === "csv") {
    const raw = await input.blob.text();
    const result = Papa.parse<Record<string, string>>(raw, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: false,
    });
    if (result.errors.length) throw new Error(`${name} CSV 파싱 오류: ${result.errors[0]?.message}`);
    const rows = result.data;
    const columns = result.meta.fields || Object.keys(rows[0] || {});
    const compressed = compressCsvFullCoverage(rows, columns, raw.length, depth);
    return {
      source: { source_id: sourceId, name, type, segments: compressed.segments },
      inputChars: raw.length,
      compressed: compressed.compressed,
      coverage: { csv_rows_scanned: compressed.rowCount, coverage_blocks: compressed.blocks },
    };
  }

  if (ext === "json") {
    const raw = await input.blob.text();
    const parsed = JSON.parse(raw);
    const normalized = JSON.stringify(parsed, null, 2);
    const compact = compressLogFullCoverage(normalized, depth);
    return {
      source: { source_id: sourceId, name, type, segments: compact.segments },
      inputChars: raw.length,
      compressed: compact.compressed,
      coverage: { text_lines_scanned: compact.lineCount, coverage_blocks: compact.blocks },
    };
  }

  if (["yaml", "yml"].includes(ext)) {
    const raw = await input.blob.text();
    const parsed = YAML.parse(raw);
    const normalized = JSON.stringify(parsed, null, 2);
    const compact = compressLogFullCoverage(normalized, depth);
    return {
      source: { source_id: sourceId, name, type, segments: compact.segments },
      inputChars: raw.length,
      compressed: compact.compressed,
      coverage: { text_lines_scanned: compact.lineCount, coverage_blocks: compact.blocks },
    };
  }

  if (ext === "pdf") {
    const result = await parsePdf(input.blob);
    const inputChars = result.segments.reduce((sum, segment) => sum + segment.text.length, 0);
    return {
      source: { source_id: sourceId, name, type, segments: result.segments },
      inputChars,
      compressed: false,
      coverage: { pdf_pages_scanned: result.pagesRead },
      warnings: result.warning ? [`${name}: ${result.warning}`] : [],
    };
  }

  throw new Error(`${name}: 지원하지 않는 연구자료 형식입니다.`);
}

async function expandZip(file: File): Promise<{ entries: NamedBlob[]; warnings: string[]; ignored: number }> {
  if (file.size > MAX_ZIP_SIZE) {
    throw new Error(`${file.name}: ZIP은 브라우저 메모리 보호를 위해 최대 80MB까지 지원합니다. 큰 프로젝트는 '프로젝트 폴더 추가'를 사용하세요.`);
  }

  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const all = Object.values(zip.files).filter((entry) => !entry.dir);
  if (all.length > MAX_ZIP_ENTRIES) {
    throw new Error(`${file.name}: ZIP 내부 파일이 ${MAX_ZIP_ENTRIES}개를 초과합니다. 큰 프로젝트는 폴더 선택을 사용하세요.`);
  }

  const entries: NamedBlob[] = [];
  const warnings: string[] = [];
  let ignored = 0;

  for (const entry of all) {
    const innerName = normalizePath(entry.name);
    const ext = extensionOf(innerName);
    if (
      innerName.startsWith("__MACOSX/") ||
      innerName.endsWith(".DS_Store") ||
      shouldIgnoreProjectPath(innerName) ||
      !RESEARCH_EXTENSIONS.has(ext)
    ) {
      ignored++;
      continue;
    }

    const data = await entry.async("uint8array");
    if (data.byteLength > MAX_ZIP_INNER_FILE_SIZE) {
      warnings.push(`${file.name} > ${innerName}: 30MB를 초과해 제외했습니다.`);
      continue;
    }
    const copied = new Uint8Array(data.byteLength);
    copied.set(data);
    entries.push({
      blob: new Blob([copied.buffer], { type: "application/octet-stream" }),
      name: `${file.name} > ${innerName}`,
    });
  }

  return { entries, warnings, ignored };
}

function sourceCharCount(source: ParsedSource) {
  return source.segments.reduce((sum, segment) => sum + segment.text.length, 0);
}

function isMachineReadableSource(source: ParsedSource) {
  const type = source.type.toLowerCase();
  return type === "log" || type === "csv" || type === "json" || type === "yaml" || type === "yml" || type === "ipynb" || CODE_EXTENSION_SET.has(type);
}

function rawEvidenceSignalScore(segment: ParsedSegment) {
  const text = segment.text;
  let score = 0;
  if (/\b(f1|accuracy|precision|recall|auc|auroc|rmse|mae|mse|score|metric)\b/i.test(text)) score += 12;
  if (/\b(test|validation|valid|val|eval|best|final|result|baseline|ablation|summary)\b/i.test(text)) score += 10;
  if (/\b(error|warning|exception|traceback|failed|failure|nan|inf)\b/i.test(text)) score += 9;
  if (/\b(seed|learning.?rate|\blr\b|batch.?size|threshold|optimizer|scheduler|dropout|weight.?decay|window|hop|sample.?rate|criterion)\b/i.test(text)) score += 7;
  if (/^\s*(?:export\s+)?(?:async\s+)?(?:def|class|function|interface|type|enum|struct|fn|func)\b/im.test(text)) score += 8;
  score += Math.min(6, (text.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi) || []).length);
  return score;
}

function balanceSourcesForAiBudget(sources: ParsedSource[], targetChars: number) {
  const originalChars = sources.reduce((sum, source) => sum + sourceCharCount(source), 0);
  if (originalChars <= targetChars) {
    return { sources, applied: false, originalChars, finalChars: originalChars };
  }

  // Human-authored prose/PDF text and every deterministic coverage digest are
  // mandatory. Only machine-readable raw excerpts are candidates for balancing.
  const mandatoryChars = sources.reduce((sum, source) => {
    if (!isMachineReadableSource(source)) return sum + sourceCharCount(source);
    return sum + source.segments
      .filter((segment) => (segment.kind || "raw") === "coverage_digest")
      .reduce((inner, segment) => inner + segment.text.length, 0);
  }, 0);

  if (mandatoryChars >= targetChars) {
    // Do not truncate human-written documents or coverage digests merely to hit a
    // numeric target. The adaptive batcher will use more than three calls here.
    return { sources, applied: false, originalChars, finalChars: originalChars };
  }

  const rawBudget = targetChars - mandatoryChars;
  const machineSources = sources.filter(isMachineReadableSource);
  const totalMachineRawChars = machineSources.reduce(
    (sum, source) => sum + source.segments
      .filter((segment) => (segment.kind || "raw") === "raw")
      .reduce((inner, segment) => inner + segment.text.length, 0),
    0,
  );

  const balanced = sources.map((source) => {
    if (!isMachineReadableSource(source)) return source;
    const digests = source.segments.filter((segment) => (segment.kind || "raw") === "coverage_digest");
    const raws = source.segments.filter((segment) => (segment.kind || "raw") === "raw");
    if (!raws.length) return source;

    const sourceRawChars = raws.reduce((sum, segment) => sum + segment.text.length, 0);
    const proportionalBudget = totalMachineRawChars > 0
      ? Math.floor(rawBudget * (sourceRawChars / totalMachineRawChars))
      : 0;
    const fairMinimum = Math.min(2_500, Math.floor(rawBudget / Math.max(1, machineSources.length)));
    const sourceBudget = Math.max(fairMinimum, proportionalBudget);

    const keep = new Set<number>();
    keep.add(0);
    keep.add(Math.floor(raws.length / 2));
    keep.add(raws.length - 1);

    // Preserve evenly distributed raw anchors across the file before filling the
    // remaining budget with high-signal exact excerpts.
    const anchorCount = Math.min(12, raws.length);
    for (let i = 0; i < anchorCount; i++) {
      keep.add(Math.floor((i * (raws.length - 1)) / Math.max(1, anchorCount - 1)));
    }

    const ranked = raws
      .map((segment, index) => ({ index, score: rawEvidenceSignalScore(segment), chars: segment.text.length }))
      .sort((a, b) => b.score - a.score || a.index - b.index);

    let keptChars = Array.from(keep).reduce((sum, index) => sum + (raws[index]?.text.length || 0), 0);
    for (const candidate of ranked) {
      if (keep.has(candidate.index)) continue;
      if (keptChars + candidate.chars > sourceBudget && keptChars >= sourceBudget) continue;
      keep.add(candidate.index);
      keptChars += candidate.chars;
      if (keptChars >= sourceBudget) break;
    }

    const keptRawSegments = raws.filter((_, index) => keep.has(index));
    const keptRawSet = new Set(keptRawSegments);
    const segments = source.segments.filter((segment) =>
      (segment.kind || "raw") === "coverage_digest" || keptRawSet.has(segment),
    );
    return { ...source, segments };
  });

  const finalChars = balanced.reduce((sum, source) => sum + sourceCharCount(source), 0);
  return { sources: balanced, applied: finalChars < originalChars, originalChars, finalChars };
}

function countRawEvidenceSegments(sources: ParsedSource[]) {
  return sources.reduce(
    (sum, source) => sum + source.segments.filter((segment) => (segment.kind || "raw") === "raw").length,
    0,
  );
}

export async function preprocessResearchFiles(
  files: File[],
  resolvePath: (file: File) => string,
  options: PreprocessOptions = {},
): Promise<PreprocessResult> {
  const depth: AnalysisDepth = options.depth === "precise" ? "precise" : "fast";
  const targetAnalysisChars = Math.max(180_000, Math.min(900_000, Math.round(
    options.analysisTargetChars ?? (depth === "precise" ? PRECISE_AI_ANALYSIS_CHARS : FAST_AI_ANALYSIS_CHARS),
  )));
  const expanded: NamedBlob[] = [];
  const warnings: string[] = [];
  let ignoredFiles = 0;

  for (const file of files) {
    const path = normalizePath(resolvePath(file) || file.name);
    const ext = extensionOf(path);
    if (ext === "zip") {
      const zip = await expandZip(file);
      expanded.push(...zip.entries);
      warnings.push(...zip.warnings);
      ignoredFiles += zip.ignored;
    } else if (RESEARCH_EXTENSIONS.has(ext)) {
      expanded.push({ blob: file, name: path, type: file.type });
    } else {
      ignoredFiles++;
    }
  }

  const sources: ParsedSource[] = [];
  let inputTextChars = 0;
  let compressedFiles = 0;
  const coverage: ResearchCoverage = {
    selected_files: files.length,
    expanded_files: expanded.length,
    parsed_sources: 0,
    ignored_files: ignoredFiles,
    text_lines_scanned: 0,
    log_lines_scanned: 0,
    code_lines_scanned: 0,
    csv_rows_scanned: 0,
    pdf_pages_scanned: 0,
    notebook_cells_scanned: 0,
    coverage_blocks: 0,
    raw_evidence_segments: 0,
    input_chars: 0,
    analysis_chars: 0,
    compression_percent: 0,
    ai_batches: 0,
  };

  for (let i = 0; i < expanded.length; i++) {
    const sourceId = `SRC${String(i + 1).padStart(3, "0")}`;
    try {
      const parsed = await parseResearchBlob(expanded[i], sourceId, depth);
      inputTextChars += parsed.inputChars;
      if (parsed.compressed) compressedFiles++;
      warnings.push(...(parsed.warnings || []));
      if (parsed.source.segments.length) sources.push(parsed.source);
      else warnings.push(`${expanded[i].name}: 읽을 수 있는 텍스트를 찾지 못했습니다.`);

      coverage.text_lines_scanned += parsed.coverage.text_lines_scanned || 0;
      coverage.log_lines_scanned += parsed.coverage.log_lines_scanned || 0;
      coverage.code_lines_scanned += parsed.coverage.code_lines_scanned || 0;
      coverage.csv_rows_scanned += parsed.coverage.csv_rows_scanned || 0;
      coverage.pdf_pages_scanned += parsed.coverage.pdf_pages_scanned || 0;
      coverage.notebook_cells_scanned += parsed.coverage.notebook_cells_scanned || 0;
      coverage.coverage_blocks += parsed.coverage.coverage_blocks || 0;
    } catch (error) {
      warnings.push(`${expanded[i].name}: ${error instanceof Error ? error.message : "파싱 실패"}`);
    }
  }

  const balanced = balanceSourcesForAiBudget(sources, targetAnalysisChars);
  const analysisSources = balanced.sources;
  const extractedChars = balanced.finalChars;

  if (balanced.applied) {
    warnings.push(
      `AI 입력 안정화를 위해 Full Coverage Digest는 전부 유지하고 대형 기계형 자료의 중복 RAW_EVIDENCE excerpt만 균형 압축했습니다 (${balanced.originalChars.toLocaleString()} → ${balanced.finalChars.toLocaleString()} chars).`,
    );
  }

  coverage.parsed_sources = analysisSources.length;
  coverage.ignored_files = ignoredFiles;
  coverage.raw_evidence_segments = countRawEvidenceSegments(analysisSources);
  coverage.input_chars = inputTextChars;
  coverage.analysis_chars = extractedChars;
  coverage.compression_percent = inputTextChars > 0
    ? Math.max(0, Math.round((1 - extractedChars / inputTextChars) * 100))
    : 0;

  return {
    sources: analysisSources,
    warnings,
    ignoredFiles,
    expandedFiles: expanded.length,
    inputTextChars,
    extractedChars,
    compressedFiles,
    analysisBudgetApplied: balanced.applied,
    analysisBudgetChars: targetAnalysisChars,
    reducedFiles: compressedFiles,
    coverage,
  };
}

export function buildAnalysisBatches(sources: ParsedSource[], maxChars = 180_000): AnalysisBatch[] {
  const batches: AnalysisBatch[] = [];
  let blocks: string[] = [];
  let charCount = 0;
  let sourceIds = new Set<string>();

  const flush = () => {
    if (!blocks.length) return;
    batches.push({
      batch_id: `B${String(batches.length + 1).padStart(3, "0")}`,
      text: blocks.join("\n"),
      source_ids: Array.from(sourceIds),
      char_count: charCount,
    });
    blocks = [];
    charCount = 0;
    sourceIds = new Set<string>();
  };

  for (const source of sources) {
    for (const segment of source.segments) {
      const segmentKind = (segment.kind || "raw") === "coverage_digest" ? "COVERAGE_DIGEST" : "RAW_EVIDENCE";
      const block = `[SOURCE ${source.source_id} | ${source.name} | ${segment.location} | ${segmentKind}]\n${segment.text}\n`;
      if (blocks.length && charCount + block.length > maxChars) flush();
      blocks.push(block);
      charCount += block.length;
      sourceIds.add(source.source_id);
    }
  }
  flush();
  return batches;
}

export async function parseReportFileInBrowser(file: File): Promise<string> {
  const ext = extensionOf(file.name);
  if (["txt", "md"].includes(ext)) return (await file.text()).trim();

  if (ext === "pdf") {
    const result = await parsePdf(file);
    return result.segments
      .filter((segment) => (segment.kind || "raw") === "raw")
      .map((page) => page.text)
      .join("\n\n")
      .trim();
  }

  if (ext === "docx") {
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer });
    return result.value.trim();
  }

  throw new Error("기존 보고서는 TXT/MD/PDF/DOCX 형식을 지원합니다.");
}
