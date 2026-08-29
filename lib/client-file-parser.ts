"use client";

import Papa from "papaparse";
import YAML from "yaml";
import JSZip from "jszip";
import mammoth from "mammoth";
import type { ParsedSegment, ParsedSource } from "@/lib/types";

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
const MAX_PDF_PAGES = 80;
const MAX_CSV_ROWS = 5000;
const MAX_NOTEBOOK_CELLS = 500;
const MAX_SEGMENT_CHARS = 14_000;

export type PreprocessResult = {
  sources: ParsedSource[];
  warnings: string[];
  ignoredFiles: number;
  expandedFiles: number;
  extractedChars: number;
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

function safeSlice(text: string, max = MAX_SEGMENT_CHARS) {
  return text.length <= max ? text : `${text.slice(0, max)}\n…[segment truncated]`;
}

function chunkLines(text: string, chunkSize = 35, label = "lines"): ParsedSegment[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const segments: ParsedSegment[] = [];
  for (let i = 0; i < lines.length; i += chunkSize) {
    const raw = lines.slice(i, i + chunkSize).join("\n").trim();
    if (!raw) continue;
    segments.push({
      location: `${label} ${i + 1}-${Math.min(i + chunkSize, lines.length)}`,
      text: safeSlice(raw),
    });
  }
  return segments;
}

async function getPdfJs() {
  const pdfjs = await import("pdfjs-dist/build/pdf.mjs");
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;
  }
  return pdfjs;
}

async function parsePdf(blob: Blob): Promise<ParsedSegment[]> {
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
    if (text) pages.push({ location: `page ${pageNumber}`, text: safeSlice(text) });
  }
  return pages;
}

async function parseResearchBlob(input: NamedBlob, sourceId: string): Promise<ParsedSource> {
  const name = normalizePath(input.name);
  const ext = extensionOf(name);
  const type = ext || input.type || "unknown";

  if (["txt", "md", "log"].includes(ext) || CODE_EXTENSION_SET.has(ext)) {
    const text = await input.blob.text();
    return {
      source_id: sourceId,
      name,
      type,
      segments: chunkLines(text, CODE_EXTENSION_SET.has(ext) ? 40 : 30),
    };
  }

  if (ext === "ipynb") {
    const parsed = JSON.parse(await input.blob.text()) as {
      cells?: Array<{ cell_type?: string; source?: string | string[]; outputs?: unknown[] }>;
    };
    const segments: ParsedSegment[] = [];
    (parsed.cells || []).slice(0, MAX_NOTEBOOK_CELLS).forEach((cell, index) => {
      const source = Array.isArray(cell.source) ? cell.source.join("") : String(cell.source || "");
      const text = source.trim();
      if (!text) return;
      const cellType = cell.cell_type === "markdown" ? "markdown" : "code";
      segments.push({ location: `cell ${index + 1} (${cellType})`, text: safeSlice(text) });
    });
    return { source_id: sourceId, name, type, segments };
  }

  if (ext === "csv") {
    const raw = await input.blob.text();
    const result = Papa.parse<Record<string, string>>(raw, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: false,
    });
    if (result.errors.length) throw new Error(`${name} CSV 파싱 오류: ${result.errors[0]?.message}`);
    const segments = result.data.slice(0, MAX_CSV_ROWS).map((row, index) => ({
      location: `row ${index + 2}`,
      text: safeSlice(JSON.stringify(row)),
    }));
    return { source_id: sourceId, name, type, segments };
  }

  if (ext === "json") {
    const parsed = JSON.parse(await input.blob.text());
    return {
      source_id: sourceId,
      name,
      type,
      segments: chunkLines(JSON.stringify(parsed, null, 2), 35),
    };
  }

  if (["yaml", "yml"].includes(ext)) {
    const parsed = YAML.parse(await input.blob.text());
    return {
      source_id: sourceId,
      name,
      type,
      segments: chunkLines(JSON.stringify(parsed, null, 2), 35),
    };
  }

  if (ext === "pdf") {
    return { source_id: sourceId, name, type, segments: await parsePdf(input.blob) };
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

export async function preprocessResearchFiles(
  files: File[],
  resolvePath: (file: File) => string,
): Promise<PreprocessResult> {
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
  for (let i = 0; i < expanded.length; i++) {
    const sourceId = `SRC${String(i + 1).padStart(3, "0")}`;
    try {
      const source = await parseResearchBlob(expanded[i], sourceId);
      if (source.segments.length) sources.push(source);
      else warnings.push(`${expanded[i].name}: 읽을 수 있는 텍스트를 찾지 못했습니다.`);
    } catch (error) {
      warnings.push(`${expanded[i].name}: ${error instanceof Error ? error.message : "파싱 실패"}`);
    }
  }

  const extractedChars = sources.reduce(
    (sum, source) => sum + source.segments.reduce((inner, segment) => inner + segment.text.length, 0),
    0,
  );

  return {
    sources,
    warnings,
    ignoredFiles,
    expandedFiles: expanded.length,
    extractedChars,
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
      const block = `[SOURCE ${source.source_id} | ${source.name} | ${segment.location}]\n${segment.text}\n`;
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
    const pages = await parsePdf(file);
    return pages.map((page) => page.text).join("\n\n").trim();
  }

  if (ext === "docx") {
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer });
    return result.value.trim();
  }

  throw new Error("기존 보고서는 TXT/MD/PDF/DOCX 형식을 지원합니다.");
}
