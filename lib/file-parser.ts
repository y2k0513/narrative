import Papa from "papaparse";
import YAML from "yaml";
import JSZip from "jszip";
import * as mammoth from "mammoth";

// pdfjs-dist tries to load pdf.worker.mjs lazily in Node.
// Next.js/Turbopack can lose that runtime-relative worker file when bundling server routes,
// so import/register the worker before pdf.mjs is loaded.
// @ts-ignore
import * as pdfjsWorker from "pdfjs-dist/legacy/build/pdf.worker.mjs";
(globalThis as typeof globalThis & { pdfjsWorker?: typeof pdfjsWorker }).pdfjsWorker = pdfjsWorker;

export type ParsedSegment = {
  location: string;
  text: string;
};

export type ParsedSource = {
  source_id: string;
  name: string;
  type: string;
  segments: ParsedSegment[];
};

function extensionOf(name: string) {
  const parts = name.toLowerCase().split(".");
  return parts.length > 1 ? parts.at(-1)! : "";
}

const TEXT_CODE_EXTENSIONS = new Set([
  "py", "js", "jsx", "ts", "tsx",
  "java", "c", "h", "cpp", "hpp", "cc", "cxx", "cs", "cu", "cuh",
  "go", "rs", "kt", "kts", "swift", "scala",
  "rb", "php", "lua", "dart", "r", "m",
  "sh", "bash", "zsh", "ps1", "bat", "cmd",
  "sql", "html", "htm", "css", "scss", "less", "vue", "svelte",
  "xml", "toml", "ini", "cfg", "conf", "proto", "tex", "urdf", "xacro", "sdf", "usda",
]);

const SUPPORTED_EXTENSIONS = new Set([
  "csv",
  "txt",
  "md",
  "log",
  "json",
  "yaml",
  "yml",
  "pdf",
  "ipynb",
  ...TEXT_CODE_EXTENSIONS,
]);

const IGNORED_PROJECT_DIRS = new Set([
  ".git", ".next", ".idea", ".vscode",
  "node_modules", "dist", "build", "coverage",
  "venv", ".venv", "env", "__pycache__", ".pytest_cache",
  "checkpoints", "checkpoint", "weights",
]);

function shouldIgnoreProjectPath(name: string) {
  const parts = name.replace(/\\/g, "/").toLowerCase().split("/");
  return parts.some((part) => IGNORED_PROJECT_DIRS.has(part));
}

const MAX_ZIP_SIZE = 30 * 1024 * 1024;
const MAX_EXTRACTED_SIZE = 50 * 1024 * 1024;
const MAX_INNER_FILE_SIZE = 10 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 100;

export async function expandUploadedFiles(uploadedFiles: File[]) {
  const expandedFiles: File[] = [];
  const warnings: string[] = [];

  for (const uploadedFile of uploadedFiles) {
    const ext = extensionOf(uploadedFile.name);
    if (ext !== "zip") {
      expandedFiles.push(uploadedFile);
      continue;
    }

    if (uploadedFile.size > MAX_ZIP_SIZE) {
      throw new Error(`${uploadedFile.name}: ZIP 파일은 최대 30MB까지 지원합니다.`);
    }

    const zip = await JSZip.loadAsync(await uploadedFile.arrayBuffer());
    const entries = Object.values(zip.files).filter(
      (entry) =>
        !entry.dir &&
        !entry.name.startsWith("__MACOSX/") &&
        !entry.name.endsWith(".DS_Store"),
    );

    if (entries.length > MAX_ZIP_ENTRIES) {
      throw new Error(`${uploadedFile.name}: ZIP 내부 파일은 최대 ${MAX_ZIP_ENTRIES}개까지 지원합니다.`);
    }

    let extractedSize = 0;
    let ignoredCount = 0;

    for (const entry of entries) {
      const innerExt = extensionOf(entry.name);
      if (
        innerExt === "zip" ||
        !SUPPORTED_EXTENSIONS.has(innerExt) ||
        shouldIgnoreProjectPath(entry.name)
      ) {
        ignoredCount++;
        continue;
      }

      const data = await entry.async("uint8array");
      if (data.byteLength > MAX_INNER_FILE_SIZE) {
        warnings.push(`${uploadedFile.name} > ${entry.name}: 10MB를 초과하여 제외되었습니다.`);
        continue;
      }

      extractedSize += data.byteLength;
      if (extractedSize > MAX_EXTRACTED_SIZE) {
        throw new Error(`${uploadedFile.name}: 압축 해제된 분석 대상 파일의 총 용량이 50MB를 초과합니다.`);
      }

      const virtualName = `${uploadedFile.name} > ${entry.name}`;
      expandedFiles.push(new File([data], virtualName, { type: "application/octet-stream" }));
    }

    if (ignoredCount > 0) {
      warnings.push(`${uploadedFile.name}: 지원하지 않는 형식 또는 중첩 ZIP ${ignoredCount}개를 분석에서 제외했습니다.`);
    }
  }

  return { files: expandedFiles, warnings };
}

function chunkLines(text: string, chunkSize = 25): ParsedSegment[] {
  const lines = text.split(/\r?\n/);
  const segments: ParsedSegment[] = [];
  for (let i = 0; i < lines.length; i += chunkSize) {
    const chunk = lines.slice(i, i + chunkSize).join("\n").trim();
    if (!chunk) continue;
    segments.push({
      location: `lines ${i + 1}-${Math.min(i + chunkSize, lines.length)}`,
      text: chunk,
    });
  }
  return segments;
}

async function parsePdf(file: File): Promise<ParsedSegment[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(await file.arrayBuffer());
  const document = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
  const pages: ParsedSegment[] = [];

  const maxPages = Math.min(document.numPages, 60);
  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ("str" in item ? String(item.str) : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text) pages.push({ location: `page ${pageNumber}`, text });
  }
  return pages;
}

export async function parseUploadedFile(file: File, sourceId: string): Promise<ParsedSource> {
  const ext = extensionOf(file.name);
  const type = ext || file.type || "unknown";

  if (["txt", "md", "log"].includes(ext) || TEXT_CODE_EXTENSIONS.has(ext)) {
    return {
      source_id: sourceId,
      name: file.name,
      type,
      segments: chunkLines(await file.text(), TEXT_CODE_EXTENSIONS.has(ext) ? 40 : 25),
    };
  }

  if (ext === "ipynb") {
    const raw = await file.text();
    const notebook = JSON.parse(raw) as {
      cells?: Array<{ cell_type?: string; source?: string | string[] }>;
    };
    const segments: ParsedSegment[] = [];
    (notebook.cells || []).slice(0, 300).forEach((cell, index) => {
      const source = Array.isArray(cell.source) ? cell.source.join("") : String(cell.source || "");
      const text = source.trim();
      if (!text) return;
      const cellType = cell.cell_type === "markdown" ? "markdown" : "code";
      segments.push({ location: `cell ${index + 1} (${cellType})`, text });
    });
    return { source_id: sourceId, name: file.name, type, segments };
  }

  if (ext === "csv") {
    const raw = await file.text();
    const result = Papa.parse<Record<string, string>>(raw, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: false,
    });

    if (result.errors.length) {
      throw new Error(`${file.name} CSV 파싱 오류: ${result.errors[0]?.message}`);
    }

    const segments = result.data.slice(0, 500).map((row, index) => ({
      location: `row ${index + 2}`,
      text: JSON.stringify(row),
    }));
    return { source_id: sourceId, name: file.name, type, segments };
  }

  if (ext === "json") {
    const raw = await file.text();
    const parsed = JSON.parse(raw);
    return {
      source_id: sourceId,
      name: file.name,
      type,
      segments: chunkLines(JSON.stringify(parsed, null, 2), 35),
    };
  }

  if (["yaml", "yml"].includes(ext)) {
    const raw = await file.text();
    const parsed = YAML.parse(raw);
    return {
      source_id: sourceId,
      name: file.name,
      type,
      segments: chunkLines(JSON.stringify(parsed, null, 2), 35),
    };
  }

  if (ext === "pdf") {
    return { source_id: sourceId, name: file.name, type, segments: await parsePdf(file) };
  }

  throw new Error(`${file.name}: 아직 지원하지 않는 형식입니다. 연구 문서/데이터 또는 지원 코드 파일을 사용하세요.`);
}

export async function parseReportFile(file: File): Promise<string> {
  const ext = extensionOf(file.name);

  if (["txt", "md"].includes(ext)) return (await file.text()).trim();

  if (ext === "pdf") {
    const pages = await parsePdf(file);
    return pages.map((page) => page.text).join("\n\n").trim();
  }

  if (ext === "docx") {
    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await mammoth.extractRawText({ buffer });
    return result.value.trim();
  }

  throw new Error("기존 보고서는 TXT/MD/PDF/DOCX 형식을 지원합니다.");
}

export function splitReportParagraphs(text: string) {
  return text
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n+/)
    .map((block) => block.trim())
    .filter(Boolean)
    .slice(0, 180)
    .map((block, index) => ({
      id: `P${String(index + 1).padStart(3, "0")}`,
      text: block,
    }));
}

export function serializeSources(sources: ParsedSource[], maxChars = 180_000) {
  let total = 0;
  let truncated = false;
  const blocks: string[] = [];

  outer: for (const source of sources) {
    for (const segment of source.segments) {
      const block = `\n[SOURCE ${source.source_id} | ${source.name} | ${segment.location}]\n${segment.text}\n`;
      if (total + block.length > maxChars) {
        truncated = true;
        break outer;
      }
      blocks.push(block);
      total += block.length;
    }
  }

  return { text: blocks.join("\n"), truncated };
}
