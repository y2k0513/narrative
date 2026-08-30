"use client";

import { useMemo, useState } from "react";
import {
  buildAnalysisBatches,
  CODE_EXTENSIONS,
  MANUAL_FILE_EXTENSIONS,
  RESEARCH_EXTENSIONS,
  extensionOf,
  parseReportFileInBrowser,
  preprocessResearchFiles,
  shouldIgnoreProjectPath,
} from "@/lib/client-file-parser";
import type { AnalysisDepth } from "@/lib/client-file-parser";
import type {
  Evidence,
  GroundedReport,
  PaperResult,
  ReportClaim,
  ReportDraft,
  ResearchAnalysis,
  ResearchChunkAnalysis,
  ResearchFinalizeResult,
} from "@/lib/types";

type PaperPayload = {
  raw_slots: number;
  unique_papers: number;
  papers: PaperResult[];
};

type BrowserFile = File & { webkitRelativePath?: string };
type BusyMode = "analyze" | "report" | "papers" | "import-report" | "ground" | "develop" | null;
type ReportMode = "existing" | "new";
type DownloadScope = "report" | "all";

const MAX_SELECTED_FILES = 150;
const MAX_FOLDER_FILE_SIZE = 40 * 1024 * 1024;
const MAX_MANUAL_ZIP_SIZE = 80 * 1024 * 1024;
const MAX_ANALYSIS_BATCHES = 100;
const FINALIZE_GROUP_SIZE = 12;
const ANALYSIS_PROFILES: Record<AnalysisDepth, {
  label: string;
  description: string;
  targetBatches: number;
  targetChars: number;
}> = {
  fast: {
    label: "빠른 분석",
    description: "핵심 Evidence 중심 · 속도 우선",
    targetBatches: 3,
    targetChars: 360_000,
  },
  precise: {
    label: "정밀 분석",
    description: "원문 Evidence와 실험 조건을 더 많이 보존 · 상세도 우선",
    targetBatches: 5,
    targetChars: 680_000,
  },
};
const MIN_ANALYSIS_BATCH_CHARS = 110_000;
const MAX_ANALYSIS_BATCH_CHARS = 150_000;
const MAX_RATE_LIMIT_RETRIES = 6;
const ANALYSIS_CONCURRENCY = 2;

function displayPath(file: File) {
  const relativePath = (file as BrowserFile).webkitRelativePath;
  return relativePath || file.name;
}

function fileKey(file: File) {
  return `${displayPath(file)}::${file.size}::${file.lastModified}`;
}

function isIgnoredProjectPath(file: File) {
  return shouldIgnoreProjectPath(displayPath(file));
}

async function readJsonOrThrow(response: Response) {
  const text = await response.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    if (!response.ok) throw new Error(text || `HTTP ${response.status}`);
    throw new Error("서버가 JSON이 아닌 응답을 반환했습니다.");
  }
  if (!response.ok) throw new Error(json?.error || text || "요청에 실패했습니다.");
  return json;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(response: Response, bodyText: string, attempt: number) {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000) + 500;
  }
  const match = bodyText.match(/try again in\s+([0-9.]+)s/i);
  if (match) return Math.ceil(Number(match[1]) * 1000) + 500;
  return Math.min(30_000, 2_000 * 2 ** attempt) + Math.floor(Math.random() * 700);
}

async function postJsonWithRateLimitRetry(url: string, payload: unknown, onWait?: (seconds: number) => void) {
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (response.status !== 429) return readJsonOrThrow(response);

    const bodyText = await response.text();
    if (attempt === MAX_RATE_LIMIT_RETRIES) {
      throw new Error(bodyText || "OpenAI rate limit에 반복적으로 도달했습니다.");
    }
    const delay = retryDelayMs(response, bodyText, attempt);
    onWait?.(Math.ceil(delay / 1000));
    await sleep(delay);
  }
  throw new Error("OpenAI rate limit 재시도에 실패했습니다.");
}

export default function HomePage() {
  const [files, setFiles] = useState<File[]>([]);
  const [analysis, setAnalysis] = useState<ResearchAnalysis | null>(null);
  const [report, setReport] = useState<ReportDraft | null>(null);
  const [groundedReport, setGroundedReport] = useState<GroundedReport | null>(null);
  const [paperPayload, setPaperPayload] = useState<PaperPayload | null>(null);
  const [selectedClaim, setSelectedClaim] = useState<ReportClaim | null>(null);
  const [reportType, setReportType] = useState("연구 결과보고서");
  const [reportInstruction, setReportInstruction] = useState("");
  const [reportMode, setReportMode] = useState<ReportMode>("existing");
  const [lengthMode, setLengthMode] = useState("long");
  const [existingReportText, setExistingReportText] = useState("");
  const [existingReportName, setExistingReportName] = useState("직접 입력");
  const [busy, setBusy] = useState<BusyMode>(null);
  const [error, setError] = useState("");
  const [uploadNotice, setUploadNotice] = useState("");
  const [analysisProgress, setAnalysisProgress] = useState("");
  const [analysisDepth, setAnalysisDepth] = useState<AnalysisDepth>("fast");
  const [showGuide, setShowGuide] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [showDownloadMenu, setShowDownloadMenu] = useState(false);
  const [downloadScope, setDownloadScope] = useState<DownloadScope>("report");

  const evidenceMap = useMemo(() => {
    const map = new Map<string, Evidence>();
    analysis?.evidence.forEach((e) => map.set(e.id, e));
    return map;
  }, [analysis]);

  function addFiles(newFiles: File[], source: "files" | "folder" = "files") {
    const supported = source === "folder" ? RESEARCH_EXTENSIONS : MANUAL_FILE_EXTENSIONS;
    const filtered: File[] = [];
    let unsupported = 0;
    let oversized = 0;

    for (const file of newFiles) {
      const ext = extensionOf(file.name);
      if (source === "folder" && isIgnoredProjectPath(file)) {
        unsupported++;
        continue;
      }
      if (!supported.has(ext)) {
        unsupported++;
        continue;
      }
      if (source === "folder" && file.size > MAX_FOLDER_FILE_SIZE) {
        oversized++;
        continue;
      }
      if (source === "files" && ext === "zip" && file.size > MAX_MANUAL_ZIP_SIZE) {
        oversized++;
        continue;
      }
      filtered.push(file);
    }

    const seen = new Set(files.map(fileKey));
    const unique = filtered.filter((file) => {
      const key = fileKey(file);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const available = Math.max(0, MAX_SELECTED_FILES - files.length);
    const accepted = unique.slice(0, available);
    const overLimit = Math.max(0, unique.length - accepted.length);
    if (accepted.length) setFiles((current) => [...current, ...accepted]);

    const messages: string[] = [];
    if (source === "folder") {
      messages.push(`폴더 파일 ${accepted.length}개 추가`);
      if (unsupported) messages.push(`지원 형식 외 ${unsupported}개 제외`);
      if (oversized) messages.push(`40MB 초과 ${oversized}개 제외`);
    } else {
      if (accepted.length) messages.push(`파일 ${accepted.length}개 추가`);
      if (unsupported) messages.push(`지원 형식 외 ${unsupported}개 제외`);
      if (oversized) messages.push(`ZIP 80MB 초과 ${oversized}개 제외`);
    }
    if (overLimit) messages.push(`최대 ${MAX_SELECTED_FILES}개 · ${overLimit}개 제외`);
    setUploadNotice(messages.join(" "));
  }

  function removeFile(index: number) {
    setFiles((current) => current.filter((_, fileIndex) => fileIndex !== index));
  }

  function clearFiles() {
    setFiles([]);
    setUploadNotice("");
  }

  async function analyze() {
    if (!files.length) return;
    setBusy("analyze");
    setError("");
    setAnalysisProgress("브라우저 Full Coverage Scan 시작 · 모든 지원 파일을 전수 스캔하는 중...");
    setAnalysis(null);
    setReport(null);
    setGroundedReport(null);
    setPaperPayload(null);
    setSelectedClaim(null);

    try {
      const profile = ANALYSIS_PROFILES[analysisDepth];
      const preprocessed = await preprocessResearchFiles(files, displayPath, {
        depth: analysisDepth,
        analysisTargetChars: profile.targetChars,
      });
      if (!preprocessed.sources.length) {
        throw new Error("분석 가능한 텍스트를 찾지 못했습니다.");
      }

      // Keep the model-call count close to the original MVP speed while preserving
      // browser-side full coverage. The batch size adapts so a typical large project
      // lands around 2-3 Luna calls instead of dozens of small calls.
      const adaptiveBatchChars = Math.min(
        MAX_ANALYSIS_BATCH_CHARS,
        Math.max(
          MIN_ANALYSIS_BATCH_CHARS,
          Math.ceil(preprocessed.extractedChars / profile.targetBatches / 5_000) * 5_000,
        ),
      );
      const batches = buildAnalysisBatches(preprocessed.sources, adaptiveBatchChars);
      if (!batches.length) throw new Error("분석할 텍스트 배치를 만들지 못했습니다.");
      if (batches.length > MAX_ANALYSIS_BATCHES) {
        throw new Error(
          `분석 텍스트가 매우 큽니다 (${batches.length}개 배치). 현재 안전 한도는 ${MAX_ANALYSIS_BATCHES}개입니다. 대형 로그/CSV/코드 중 불필요한 파일을 제외해 주세요.`,
        );
      }

      const compressionPercent = preprocessed.coverage.compression_percent;
      const compressionLabel = preprocessed.compressedFiles
        ? `Full Coverage Compression ${preprocessed.compressedFiles} files · ${compressionPercent}% 축소${preprocessed.analysisBudgetApplied ? ` · AI context ${Math.round(preprocessed.extractedChars / 1000)}k` : ""}`
        : "원문 전체 전달";
      const coverageUnits =
        preprocessed.coverage.text_lines_scanned +
        preprocessed.coverage.log_lines_scanned +
        preprocessed.coverage.code_lines_scanned +
        preprocessed.coverage.csv_rows_scanned +
        preprocessed.coverage.pdf_pages_scanned +
        preprocessed.coverage.notebook_cells_scanned;

      setAnalysisProgress(
        `${profile.label} · Full Coverage Scan 완료 · ${coverageUnits.toLocaleString()} units scanned · ${compressionLabel} · ${batches.length}개 AI 배치 (${Math.round(adaptiveBatchChars / 1000)}k chars/batch) · ${ANALYSIS_CONCURRENCY}개 병렬 분석`,
      );

      const partials = new Array<ResearchChunkAnalysis>(batches.length);
      let nextBatchIndex = 0;
      let completedBatches = 0;

      const analyzeWorker = async () => {
        while (true) {
          const index = nextBatchIndex++;
          if (index >= batches.length) return;
          const batch = batches[index];
          partials[index] = (await postJsonWithRateLimitRetry(
            "/api/analyze/chunk",
            { batchId: batch.batch_id, text: batch.text, analysisDepth },
            (seconds) =>
              setAnalysisProgress(
                `OpenAI TPM 한도 조절 중 · ${seconds}초 대기 후 배치 ${index + 1}/${batches.length} 자동 재시도...`,
              ),
          )) as ResearchChunkAnalysis;
          completedBatches++;
          setAnalysisProgress(
            `${profile.label} · Full Coverage Scan 완료 · ${compressionLabel} · ${(preprocessed.extractedChars / 1_000_000).toFixed(2)}M analysis chars · AI 배치 ${completedBatches}/${batches.length} 완료 (${ANALYSIS_CONCURRENCY}개 병렬)`,
          );
        }
      };

      const workerCount = Math.min(ANALYSIS_CONCURRENCY, batches.length);
      await Promise.all(Array.from({ length: workerCount }, () => analyzeWorker()));

      setAnalysisProgress(`배치 ${batches.length}개 병렬 분석 완료 · Research Overview 통합 중...`);

      const digestLimits = analysisDepth === "precise"
        ? { methods: 18, experiments: 30, findings: 22, concepts: 20, warnings: 14 }
        : { methods: 12, experiments: 20, findings: 15, concepts: 15, warnings: 10 };

      const digest = partials.map((partial, index) => ({
        batch_id: batches[index]?.batch_id || `B${index + 1}`,
        chunk_summary: partial.chunk_summary,
        methods: partial.methods.slice(0, digestLimits.methods),
        experiments: partial.experiments.slice(0, digestLimits.experiments),
        findings: partial.findings.slice(0, digestLimits.findings).map((finding) => ({ text: finding.text, kind: finding.kind })),
        concepts: partial.concepts.slice(0, digestLimits.concepts),
        warnings: partial.warnings.slice(0, digestLimits.warnings),
      }));

      async function finalizeChunks(chunks: unknown[], label?: string) {
        if (label) setAnalysisProgress(label);
        const response = await fetch("/api/analyze/finalize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chunks, maxConcepts: 30, analysisDepth }),
        });
        return (await readJsonOrThrow(response)) as ResearchFinalizeResult;
      }

      let finalized: ResearchFinalizeResult;

      if (digest.length <= FINALIZE_GROUP_SIZE) {
        finalized = await finalizeChunks(
          digest,
          `배치 ${batches.length}개 분석 완료 · Research Overview 통합 중...`,
        );
      } else {
        const mergedGroups: unknown[] = [];
        const groupCount = Math.ceil(digest.length / FINALIZE_GROUP_SIZE);

        for (let start = 0; start < digest.length; start += FINALIZE_GROUP_SIZE) {
          const groupIndex = Math.floor(start / FINALIZE_GROUP_SIZE) + 1;
          const group = digest.slice(start, start + FINALIZE_GROUP_SIZE);
          const merged = await finalizeChunks(
            group,
            `1차 통합 ${groupIndex}/${groupCount} · ${group.length}개 배치 요약 중...`,
          );

          mergedGroups.push({
            batch_id: `MERGE${String(groupIndex).padStart(2, "0")}`,
            research_topic: merged.research_topic,
            research_topic_en: merged.research_topic_en,
            objective: merged.objective,
            chunk_summary: merged.summary,
            methods: merged.methods.slice(0, 24),
            experiments: merged.experiments.slice(0, 35),
            concepts: merged.concepts.slice(0, 20),
            warnings: merged.warnings.slice(0, 15),
          });
        }

        finalized = await finalizeChunks(
          mergedGroups,
          `2차 통합 · ${groupCount}개 중간 요약을 전체 Research Overview로 병합 중...`,
        );
      }

      const sourceNameMap = new Map(preprocessed.sources.map((source) => [source.source_id, source.name]));
      const evidence: Evidence[] = [];
      const tempMaps: Array<Map<string, string>> = [];
      let evidenceCounter = 1;

      partials.forEach((partial) => {
        const tempMap = new Map<string, string>();
        partial.evidence.forEach((ev) => {
          const id = `EV${String(evidenceCounter++).padStart(4, "0")}`;
          tempMap.set(ev.temp_id, id);
          evidence.push({
            id,
            type: ev.type,
            content: ev.content,
            experiment_id: ev.experiment_id,
            source_id: ev.source_id,
            source_name: sourceNameMap.get(ev.source_id) || ev.source_id,
            source_location: ev.source_location,
            raw_quote: ev.raw_quote,
          });
        });
        tempMaps.push(tempMap);
      });

      const findingMap = new Map<string, { text: string; kind: "observed" | "inferred"; evidence_ids: string[] }>();
      partials.forEach((partial, index) => {
        const tempMap = tempMaps[index];
        partial.findings.forEach((finding) => {
          const key = `${finding.kind}:${finding.text.trim().toLowerCase()}`;
          const evidenceIds = finding.evidence_temp_ids
            .map((tempId) => tempMap.get(tempId))
            .filter((id): id is string => Boolean(id));
          const current = findingMap.get(key);
          if (current) {
            current.evidence_ids = Array.from(new Set([...current.evidence_ids, ...evidenceIds]));
          } else {
            findingMap.set(key, { text: finding.text, kind: finding.kind, evidence_ids: evidenceIds });
          }
        });
      });

      const analysisResult: ResearchAnalysis = {
        ...finalized,
        evidence,
        findings: Array.from(findingMap.values()),
        source_files: preprocessed.sources.map((source) => ({
          source_id: source.source_id,
          name: source.name,
          type: source.type,
          segment_count: source.segments.length,
        })),
        coverage: { ...preprocessed.coverage, ai_batches: batches.length },
        warnings: Array.from(new Set([
          ...finalized.warnings,
          ...preprocessed.warnings,
          ...partials.flatMap((partial) => partial.warnings),
          ...(preprocessed.compressedFiles
            ? [`대형 로그/CSV/코드 ${preprocessed.compressedFiles}개는 일부만 키워드 선별한 것이 아니라 모든 line/row를 브라우저에서 전수 스캔한 뒤 Coverage Digest + 원문 Evidence로 계층 압축했습니다.`]
            : []),
          ...(preprocessed.ignoredFiles ? [`지원하지 않거나 제외 대상인 파일 ${preprocessed.ignoredFiles}개는 분석하지 않았습니다.`] : []),
        ])),
      };

      setAnalysis(analysisResult);
      setAnalysisProgress(
        `${profile.label} 완료 · ${preprocessed.sources.length} files full-scanned · ${compressionLabel} · ${batches.length} AI batches · ${evidence.length} evidence`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "분석 오류");
      setAnalysisProgress("");
    } finally {
      setBusy(null);
    }
  }

  async function importExistingReport(file: File) {
    setBusy("import-report");
    setError("");
    try {
      const text = await parseReportFileInBrowser(file);
      if (!text.trim()) throw new Error("보고서에서 읽을 수 있는 텍스트를 찾지 못했습니다.");
      setExistingReportText(text.slice(0, 180_000));
      setExistingReportName(file.name);
      setGroundedReport(null);
      setReport(null);
      setSelectedClaim(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "보고서 불러오기 오류");
    } finally {
      setBusy(null);
    }
  }

  async function groundExistingReport() {
    if (!analysis || !existingReportText.trim()) return;
    setBusy("ground");
    setError("");
    setReport(null);
    setSelectedClaim(null);
    try {
      const response = await fetch("/api/report/ground", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ analysis, reportText: existingReportText, sourceName: existingReportName }),
      });
      setGroundedReport((await readJsonOrThrow(response)) as GroundedReport);
    } catch (e) {
      setError(e instanceof Error ? e.message : "기존 보고서 근거 연결 오류");
    } finally {
      setBusy(null);
    }
  }

  async function developExistingReport() {
    if (!analysis || !groundedReport) return;
    setBusy("develop");
    setError("");
    setSelectedClaim(null);
    try {
      const response = await fetch("/api/report/develop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          analysis,
          groundedReport,
          reportType,
          userInstruction: reportInstruction,
          lengthMode,
        }),
      });
      setReport((await readJsonOrThrow(response)) as ReportDraft);
    } catch (e) {
      setError(e instanceof Error ? e.message : "보고서 개선 오류");
    } finally {
      setBusy(null);
    }
  }

  async function generateReport() {
    if (!analysis) return;
    setBusy("report");
    setError("");
    setSelectedClaim(null);
    try {
      const response = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ analysis, reportType, userInstruction: reportInstruction, lengthMode }),
      });
      setReport((await readJsonOrThrow(response)) as ReportDraft);
    } catch (e) {
      setError(e instanceof Error ? e.message : "보고서 생성 오류");
    } finally {
      setBusy(null);
    }
  }

  async function findPapers() {
    if (!analysis) return;
    setBusy("papers");
    setError("");
    try {
      const response = await fetch("/api/papers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ analysis, conceptLimit: 30, perConcept: 5 }),
      });
      setPaperPayload((await readJsonOrThrow(response)) as PaperPayload);
    } catch (e) {
      setError(e instanceof Error ? e.message : "논문 검색 오류");
    } finally {
      setBusy(null);
    }
  }

  function reportToPlainText(draft: ReportDraft) {
    const lines: string[] = [draft.title, ""]; 
    for (const section of draft.sections) {
      lines.push(`[${section.heading}]`, "");
      for (const paragraph of section.paragraphs) {
        lines.push(paragraph.text, "");
        const claims = paragraph.claims.filter((claim) => claim.type !== "narrative");
        for (const claim of claims) {
          lines.push(`- ${claim.id} / ${claim.type}: ${claim.text}`);
          if (claim.evidence_ids.length) lines.push(`  Evidence: ${claim.evidence_ids.join(", ")}`);
          if (claim.citation_required) lines.push("  Citation Needed");
        }
        if (claims.length) lines.push("");
      }
    }
    if (draft.warnings.length) lines.push("[주의사항]", ...draft.warnings.map((warning) => `- ${warning}`), "");
    return lines.join("\n");
  }

  function groundedReportToPlainText(grounded: GroundedReport) {
    const lines: string[] = [grounded.title, `원본: ${grounded.source_name}`, ""];
    lines.push(
      `Claims ${grounded.stats.total_claims} / Internal Evidence ${grounded.stats.internally_supported} / Citation Needed ${grounded.stats.citation_needed} / Unsupported ${grounded.stats.unsupported}`,
      "",
    );
    for (const paragraph of grounded.paragraphs) {
      lines.push(paragraph.text, "");
      const claims = paragraph.claims.filter((claim) => claim.type !== "narrative");
      for (const claim of claims) {
        lines.push(`- ${claim.id} / ${claim.type}: ${claim.text}`);
        if (claim.evidence_ids.length) lines.push(`  Evidence: ${claim.evidence_ids.join(", ")}`);
        if (claim.citation_required) lines.push("  Citation Needed");
      }
      if (claims.length) lines.push("");
    }
    if (grounded.warnings.length) lines.push("[주의사항]", ...grounded.warnings.map((warning) => `- ${warning}`), "");
    return lines.join("\n");
  }

  function buildArtifactText() {
    const lines: string[] = [
      "Research2Report 산출물",
      "작성자: 24100017 신현종",
      `내보낸 시각: ${new Date().toLocaleString("ko-KR")}`,
      "",
    ];

    if (files.length) {
      lines.push("========================================", "입력 자료", "========================================");
      files.forEach((file, index) => lines.push(`${index + 1}. ${displayPath(file)}`));
      lines.push("");
    }

    if (analysis) {
      lines.push("========================================", "Research Overview", "========================================");
      lines.push(`주제: ${analysis.research_topic}`);
      if (analysis.objective) lines.push(`목적: ${analysis.objective}`);
      lines.push("", analysis.summary, "");

      if (analysis.findings.length) {
        lines.push("[주요 Finding]");
        analysis.findings.forEach((finding, index) => {
          const label = finding.kind === "observed" ? "관찰" : "해석";
          const evidence = finding.evidence_ids.length ? ` / Evidence: ${finding.evidence_ids.join(", ")}` : "";
          lines.push(`${index + 1}. ${label}: ${finding.text}${evidence}`);
        });
        lines.push("");
      }

      if (analysis.evidence.length) {
        lines.push("[Evidence Map]");
        analysis.evidence.forEach((ev) => {
          lines.push(`${ev.id} / ${ev.type}`);
          lines.push(`내용: ${ev.content}`);
          lines.push(`출처: ${ev.source_name}${ev.source_location ? ` · ${ev.source_location}` : ""}`);
          if (ev.raw_quote) lines.push(`원문: ${ev.raw_quote}`);
          lines.push("");
        });
      }
    }

    if (groundedReport) {
      lines.push("========================================", "기존 보고서 Evidence 연결 결과", "========================================");
      lines.push(groundedReportToPlainText(groundedReport), "");
    }

    if (report) {
      lines.push("========================================", "생성·개선 보고서", "========================================");
      lines.push(reportToPlainText(report), "");
    }

    if (paperPayload?.papers.length) {
      lines.push("========================================", "관련 문헌 후보", "========================================");
      paperPayload.papers.forEach((paper, index) => {
        lines.push(`${index + 1}. ${paper.title}`);
        const meta = [paper.year, paper.authors.join(", "), paper.venue].filter(Boolean).join(" · ");
        if (meta) lines.push(meta);
        if (paper.matched_concepts.length) lines.push(`관련 키워드: ${paper.matched_concepts.map((concept) => concept.name).join(", ")}`);
        lines.push(`관련도 점수: ${paper.final_score}`);
        if (paper.url) lines.push(`링크: ${paper.url}`);
        lines.push("");
      });
    }

    lines.push(
      "========================================",
      "확인 사항",
      "========================================",
      "- 생성형 AI의 해석과 보고서 문장은 최종 사용 전 Evidence와 원문을 확인해야 합니다.",
      "- 관련 문헌은 검색 후보이며, 실제 인용 전 원문을 직접 검토해야 합니다.",
    );
    return lines.join("\n");
  }

  function escapeHtml(value: unknown) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function buildArtifactHtml(scope: DownloadScope = "all") {
    const sections: string[] = [];
    const reportOnly = scope === "report";
    const sourceList = !reportOnly && files.length
      ? `<section><h2>입력 자료</h2><ol>${files.map((file) => `<li>${escapeHtml(displayPath(file))}</li>`).join("")}</ol></section>`
      : "";
    if (sourceList) sections.push(sourceList);

    if (!reportOnly && analysis) {
      const findings = analysis.findings.length
        ? `<h3>주요 Finding</h3><div class="items">${analysis.findings.map((finding) => {
            const label = finding.kind === "observed" ? "관찰" : "해석";
            const ids = finding.evidence_ids.length ? `<div class="meta">Evidence · ${escapeHtml(finding.evidence_ids.join(", "))}</div>` : "";
            return `<article class="item"><div class="badge">${label}</div><div>${escapeHtml(finding.text)}</div>${ids}</article>`;
          }).join("")}</div>`
        : "";
      const evidence = analysis.evidence.length
        ? `<h3>Evidence Map</h3><div class="items">${analysis.evidence.map((ev) => `<article class="item evidence"><div class="evidence-head"><strong>${escapeHtml(ev.id)}</strong><span>${escapeHtml(ev.type)}</span></div><div>${escapeHtml(ev.content)}</div><div class="meta">${escapeHtml(ev.source_name)}${ev.source_location ? ` · ${escapeHtml(ev.source_location)}` : ""}</div>${ev.raw_quote ? `<blockquote>${escapeHtml(ev.raw_quote)}</blockquote>` : ""}</article>`).join("")}</div>`
        : "";
      sections.push(`<section><h2>Research Overview</h2><div class="topic">${escapeHtml(analysis.research_topic)}</div>${analysis.objective ? `<div class="objective">${escapeHtml(analysis.objective)}</div>` : ""}<p>${escapeHtml(analysis.summary)}</p>${findings}${evidence}</section>`);
    }

    if (!reportOnly && groundedReport) {
      const paragraphs = groundedReport.paragraphs.map((paragraph) => {
        const claims = paragraph.claims.filter((claim) => claim.type !== "narrative");
        const claimHtml = claims.length
          ? `<div class="claims">${claims.map((claim) => `<div class="claim"><span class="claim-type">${escapeHtml(claim.type)}</span><span>${escapeHtml(claim.text)}</span>${claim.evidence_ids.length ? `<div class="meta">Evidence · ${escapeHtml(claim.evidence_ids.join(", "))}</div>` : ""}${claim.citation_required ? `<div class="citation">Citation Needed</div>` : ""}</div>`).join("")}</div>`
          : "";
        return `<article class="report-paragraph"><p>${escapeHtml(paragraph.text)}</p>${claimHtml}</article>`;
      }).join("");
      sections.push(`<section><h2>기존 보고서 Evidence 연결 결과</h2><div class="stats"><span>Claims ${groundedReport.stats.total_claims}</span><span>Internal ${groundedReport.stats.internally_supported}</span><span>Citation Needed ${groundedReport.stats.citation_needed}</span><span>Unsupported ${groundedReport.stats.unsupported}</span></div>${paragraphs}</section>`);
    }

    if (report) {
      const reportSections = report.sections.map((section) => `<div class="report-section"><h3>${escapeHtml(section.heading)}</h3>${section.paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph.text)}</p>`).join("")}</div>`).join("");
      sections.push(`<section><h2>${reportOnly ? "보고서" : "생성·개선 보고서"}</h2><div class="topic">${escapeHtml(report.title)}</div>${reportSections}</section>`);
    } else if (reportOnly && groundedReport) {
      const paragraphs = groundedReport.paragraphs.map((paragraph) => `<div class="report-section"><p>${escapeHtml(paragraph.text)}</p></div>`).join("");
      sections.push(`<section><h2>보고서</h2><div class="topic">${escapeHtml(groundedReport.title)}</div>${paragraphs}</section>`);
    }

    if (!reportOnly && paperPayload?.papers.length) {
      const papers = paperPayload.papers.map((paper, index) => {
        const meta = [paper.year, paper.authors.join(", "), paper.venue].filter(Boolean).map(escapeHtml).join(" · ");
        const concepts = paper.matched_concepts.map((concept) => concept.name).join(", ");
        return `<article class="paper"><div class="paper-rank">${index + 1}</div><div><strong>${escapeHtml(paper.title)}</strong>${meta ? `<div class="meta">${meta}</div>` : ""}${concepts ? `<div class="meta">관련 키워드 · ${escapeHtml(concepts)}</div>` : ""}<div class="meta">관련도 점수 · ${escapeHtml(paper.final_score)}</div>${paper.url ? `<a href="${escapeHtml(paper.url)}">${escapeHtml(paper.url)}</a>` : ""}</div></article>`;
      }).join("");
      sections.push(`<section><h2>관련 문헌 후보</h2><p class="section-note">검색된 문헌은 관련성 후보이며 실제 인용 전 원문 검토가 필요합니다.</p>${papers}</section>`);
    }

    return `<div class="export-document">
      <style>
        .export-document { width: 760px; box-sizing: border-box; padding: 34px 42px 52px; background: #fff; color: #172033; font-family: Arial, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif; font-size: 13px; line-height: 1.65; }
        .export-document * { box-sizing: border-box; }
        .export-header { border-bottom: 3px solid #183b66; padding-bottom: 18px; margin-bottom: 24px; }
        .export-kicker { color: #268a91; font-size: 11px; font-weight: 800; letter-spacing: .08em; }
        .export-header h1 { margin: 4px 0 8px; color: #15375f; font-size: 28px; line-height: 1.2; }
        .export-header .meta { margin: 2px 0; }
        section { margin: 0 0 26px; padding-top: 4px; }
        h2 { margin: 0 0 13px; padding-bottom: 7px; border-bottom: 1px solid #dfe5ec; color: #15375f; font-size: 18px; }
        h3 { margin: 18px 0 9px; color: #15375f; font-size: 14px; }
        p { margin: 7px 0 11px; white-space: pre-wrap; }
        ol { margin: 0; padding-left: 20px; }
        li { margin-bottom: 4px; word-break: break-all; }
        .topic { margin-bottom: 8px; color: #15375f; font-size: 17px; font-weight: 800; }
        .objective, .section-note { color: #5f6b7b; }
        .items { display: grid; gap: 8px; }
        .item, .report-paragraph, .paper { break-inside: avoid; page-break-inside: avoid; border: 1px solid #e2e7ed; border-radius: 7px; padding: 10px 12px; background: #fbfcfe; }
        .badge, .claim-type { display: inline-block; margin-bottom: 5px; border-radius: 999px; padding: 2px 7px; background: #eaf3f4; color: #24747b; font-size: 10px; font-weight: 800; }
        .meta { color: #687587; font-size: 10px; word-break: break-all; }
        .evidence-head { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 5px; color: #15375f; }
        blockquote { margin: 7px 0 0; padding: 7px 9px; border-left: 3px solid #9dc7ca; background: #fff; color: #4e5a69; white-space: pre-wrap; }
        .stats { display: flex; gap: 7px; flex-wrap: wrap; margin-bottom: 12px; }
        .stats span { border-radius: 999px; padding: 4px 8px; background: #f0f3f7; font-size: 10px; font-weight: 700; }
        .claims { display: grid; gap: 6px; margin-top: 8px; }
        .claim { border-top: 1px solid #e7ebf0; padding-top: 7px; }
        .citation { display: inline-block; margin-top: 4px; border-radius: 4px; padding: 2px 6px; background: #fff4df; color: #9a5a00; font-size: 10px; font-weight: 800; }
        .report-section { break-inside: auto; page-break-inside: auto; }
        .paper { display: grid; grid-template-columns: 28px 1fr; gap: 9px; margin-bottom: 7px; }
        .paper-rank { color: #268a91; font-size: 16px; font-weight: 900; }
        a { color: #175e9c; text-decoration: underline; word-break: break-all; }
        .export-footer { margin-top: 28px; padding-top: 14px; border-top: 1px solid #dfe5ec; color: #687587; font-size: 10px; }
      </style>
      <header class="export-header"><div class="export-kicker">RESEARCH2REPORT EXPORT</div><h1>${reportOnly ? "Research2Report 보고서" : "Research2Report 산출물"}</h1><div class="meta">작성자 · 24100017 신현종</div><div class="meta">내보낸 시각 · ${escapeHtml(new Date().toLocaleString("ko-KR"))}</div></header>
      ${sections.join("")}
      <footer class="export-footer">${reportOnly ? "생성형 AI로 작성된 문장은 최종 제출 전 원자료와 근거를 확인해 주세요." : "생성형 AI 결과는 최종 사용 전 Evidence와 원문을 확인해야 합니다. 관련 문헌은 검색 후보이며 실제 인용 전 원문 검토가 필요합니다."}</footer>
    </div>`;
  }

  async function downloadWordArtifacts(scope: DownloadScope) {
    if (scope === "report" && !report && !groundedReport) return;
    if (scope === "all" && !analysis && !groundedReport && !report && !paperPayload) return;
    setDownloading(true);
    setError("");
    try {
      const reportOnly = scope === "report";
      const {
        AlignmentType,
        BorderStyle,
        Document,
        HeadingLevel,
        Packer,
        Paragraph,
        Table,
        TableCell,
        TableRow,
        TextRun,
        WidthType,
      } = await import("docx");

      const children: any[] = [];
      const heading = (text: string, level: typeof HeadingLevel[keyof typeof HeadingLevel] = HeadingLevel.HEADING_1) =>
        new Paragraph({ text, heading: level, spacing: { before: 260, after: 120 } });
      const body = (text: string, bold = false) =>
        new Paragraph({ children: [new TextRun({ text, bold, size: 21 })], spacing: { after: 110 }, alignment: AlignmentType.LEFT });
      const muted = (text: string) =>
        new Paragraph({ children: [new TextRun({ text, color: "667085", size: 18 })], spacing: { after: 80 } });
      const bullet = (text: string) =>
        new Paragraph({ children: [new TextRun({ text, size: 20 })], bullet: { level: 0 }, spacing: { after: 60 } });

      children.push(
        new Paragraph({
          children: [new TextRun({ text: reportOnly ? "Research2Report 보고서" : "Research2Report 분석 산출물", bold: true, size: 38, color: "173F76" })],
          spacing: { after: 120 },
        }),
        muted("작성자 · 24100017 신현종"),
        muted(`내보낸 시각 · ${new Date().toLocaleString("ko-KR")}`),
      );

      if (!reportOnly && analysis) {
        children.push(heading("1. Research Overview"));
        children.push(body(analysis.research_topic, true));
        if (analysis.objective) children.push(muted(`목적 · ${analysis.objective}`));
        children.push(body(analysis.summary));

        if (analysis.concepts.length) {
          children.push(heading("Research Concepts", HeadingLevel.HEADING_2));
          const rows = [
            new TableRow({
              children: ["순위", "Concept", "설명", "Score"].map((text) => new TableCell({
                children: [new Paragraph({ children: [new TextRun({ text, bold: true, size: 18 })] })],
                shading: { fill: "EEF4FB" },
              })),
              tableHeader: true,
            }),
            ...analysis.concepts.slice(0, 30).map((concept, index) => new TableRow({
              children: [
                String(index + 1),
                concept.name_en,
                concept.name_ko,
                String(Math.round(concept.importance * 100)),
              ].map((text) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text, size: 17 })] })] })),
            })),
          ];
          children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows }));
        }

        if (analysis.findings.length) {
          children.push(heading("주요 Finding", HeadingLevel.HEADING_2));
          analysis.findings.forEach((finding) => {
            const label = finding.kind === "observed" ? "관찰" : "해석";
            children.push(body(`[${label}] ${finding.text}`));
            if (finding.evidence_ids.length) children.push(muted(`Evidence · ${finding.evidence_ids.join(", ")}`));
          });
        }

        if (analysis.evidence.length) {
          children.push(heading("2. Evidence Map"));
          analysis.evidence.forEach((ev) => {
            children.push(body(`${ev.id} · ${ev.type}`, true));
            children.push(body(ev.content));
            children.push(muted(`${ev.source_name}${ev.source_location ? ` · ${ev.source_location}` : ""}`));
            if (ev.raw_quote) children.push(muted(`원문 · ${ev.raw_quote}`));
          });
        }
      }

      if (!reportOnly && groundedReport) {
        children.push(heading("3. 기존 보고서 Evidence 연결"));
        children.push(body(groundedReport.title, true));
        children.push(muted(`Claims ${groundedReport.stats.total_claims} · Internal ${groundedReport.stats.internally_supported} · Citation Needed ${groundedReport.stats.citation_needed} · Unsupported ${groundedReport.stats.unsupported}`));
        groundedReport.paragraphs.forEach((paragraph) => {
          children.push(body(paragraph.text));
          paragraph.claims.filter((claim) => claim.type !== "narrative").forEach((claim) => {
            children.push(muted(`${claim.type} · ${claim.text}${claim.evidence_ids.length ? ` · Evidence ${claim.evidence_ids.join(", ")}` : ""}${claim.citation_required ? " · Citation Needed" : ""}`));
          });
        });
      }

      if (report) {
        children.push(heading(reportOnly ? "보고서" : (groundedReport ? "4. 근거 기반 개선 보고서" : "3. 근거 기반 보고서")));
        children.push(body(report.title, true));
        report.sections.forEach((section) => {
          children.push(heading(section.heading, HeadingLevel.HEADING_2));
          section.paragraphs.forEach((paragraph) => children.push(body(paragraph.text)));
        });
      } else if (reportOnly && groundedReport) {
        children.push(heading("보고서"));
        children.push(body(groundedReport.title, true));
        groundedReport.paragraphs.forEach((paragraph) => children.push(body(paragraph.text)));
      }

      if (!reportOnly && paperPayload?.papers.length) {
        children.push(heading("관련 문헌 후보"));
        children.push(muted("관련도 기반 검색 후보이며 실제 인용 전 원문 검토가 필요합니다."));
        paperPayload.papers.slice(0, 50).forEach((paper, index) => {
          children.push(body(`${index + 1}. ${paper.title}`, true));
          children.push(muted([paper.year, paper.authors.join(", "), paper.venue].filter(Boolean).join(" · ")));
          if (paper.matched_concepts.length) children.push(muted(`관련 키워드 · ${paper.matched_concepts.map((concept) => concept.name).join(", ")}`));
          children.push(muted(`관련도 점수 · ${paper.final_score.toFixed(1)}`));
          if (paper.url) children.push(body(paper.url));
        });
      }

      children.push(heading("확인 사항"));
      children.push(bullet("생성형 AI의 해석과 보고서 문장은 최종 사용 전 Evidence와 원문을 확인해야 합니다."));
      if (!reportOnly) children.push(bullet("관련 문헌은 검색 후보이며, 실제 인용 전 원문을 직접 검토해야 합니다."));

      const doc = new Document({
        styles: {
          default: {
            document: { run: { font: "Malgun Gothic", size: 21 }, paragraph: { spacing: { line: 300 } } },
          },
        },
        sections: [{
          properties: { page: { margin: { top: 900, right: 900, bottom: 900, left: 900 } } },
          children,
        }],
      });

      const blob = await Packer.toBlob(doc);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `Research2Report_${reportOnly ? "report" : "full"}_${new Date().toISOString().slice(0, 10)}.docx`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setShowDownloadMenu(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Word 다운로드 오류");
    } finally {
      setDownloading(false);
    }
  }

  function downloadPdfArtifacts(scope: DownloadScope) {
    if (scope === "report" && !report && !groundedReport) return;
    if (scope === "all" && !analysis && !groundedReport && !report && !paperPayload) return;
    setDownloading(true);
    setError("");
    try {
      const printWindow = window.open("", "Research2ReportPrint", "width=1040,height=900");
      if (!printWindow) throw new Error("PDF 출력을 위해 팝업을 허용해 주세요.");

      const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${scope === "report" ? "Research2Report 보고서" : "Research2Report 산출물"}</title><style>
        @page { size: A4; margin: 12mm 11mm 14mm; }
        html, body { margin: 0; padding: 0; background: #fff; }
        body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        .export-document { width: auto !important; min-height: 0 !important; padding: 0 !important; }
        @media print { a { color: #175e9c !important; } }
      </style></head><body>${buildArtifactHtml(scope)}<script>
        window.addEventListener('load', async () => {
          try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch (e) {}
          setTimeout(() => { window.focus(); window.print(); }, 250);
        });
        window.addEventListener('afterprint', () => window.close());
      <\/script></body></html>`;
      printWindow.document.open();
      printWindow.document.write(html);
      printWindow.document.close();
      setShowDownloadMenu(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "PDF 출력 오류");
    } finally {
      setDownloading(false);
    }
  }

  async function downloadPngArtifacts(scope: DownloadScope) {
    if (scope === "report" && !report && !groundedReport) return;
    const pageTarget = document.querySelector(".page-shell") as HTMLElement | null;
    if (scope === "all" && !pageTarget) return;
    let tempTarget: HTMLElement | null = null;
    let target: HTMLElement | null = pageTarget;
    setDownloading(true);
    setError("");
    try {
      setShowDownloadMenu(false);
      const module = await import("html2canvas");
      const html2canvas = (module.default || module) as typeof import("html2canvas").default;
      if (document.fonts?.ready) await document.fonts.ready;

      if (scope === "report") {
        tempTarget = document.createElement("div");
        tempTarget.className = "report-export-capture";
        tempTarget.style.position = "fixed";
        tempTarget.style.left = "-10000px";
        tempTarget.style.top = "0";
        tempTarget.style.zIndex = "-1";
        tempTarget.innerHTML = buildArtifactHtml("report");
        document.body.appendChild(tempTarget);
        target = tempTarget.querySelector(".export-document") as HTMLElement | null;
      }
      if (!target) throw new Error("PNG로 저장할 내용을 찾지 못했습니다.");

      if (scope === "all") target.classList.add("capture-mode");
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      const maxCanvasHeight = 30000;
      const baseScale = 1.35;
      const safeScale = Math.max(0.65, Math.min(baseScale, maxCanvasHeight / Math.max(target.scrollHeight, 1)));
      const canvas = await html2canvas(target, {
        scale: safeScale,
        useCORS: true,
        backgroundColor: "#f5f7fb",
        logging: false,
        windowWidth: Math.max(1180, target.scrollWidth),
        windowHeight: target.scrollHeight,
        scrollX: 0,
        scrollY: -window.scrollY,
      });

      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png", 1));
      if (!blob) throw new Error("PNG 생성에 실패했습니다.");
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `Research2Report_${scope === "report" ? "report" : "screen"}_${new Date().toISOString().slice(0, 10)}.png`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "PNG 다운로드 오류");
    } finally {
      if (pageTarget) pageTarget.classList.remove("capture-mode");
      if (tempTarget?.parentNode) tempTarget.parentNode.removeChild(tempTarget);
      setDownloading(false);
    }
  }

  const hasDownloadableArtifacts = Boolean(analysis || groundedReport || report || paperPayload);
  const hasReportArtifact = Boolean(report || groundedReport);
  const activeDownloadScope: DownloadScope = downloadScope === "report" && hasReportArtifact ? "report" : "all";

  const selectedEvidence = selectedClaim?.evidence_ids
    .map((id) => evidenceMap.get(id))
    .filter(Boolean) as Evidence[] | undefined;

  return (
    <main className="page-shell">
      <header className="hero">
        <div>
          <div className="eyebrow">SEOULTECH AI NARRATIVE</div>
          <h1>Research2Report</h1>
          <p>
            파일·폴더에서 Evidence를 만들고, 기존 보고서의 주장과 연결하거나 Evidence 기반 새 보고서를 작성합니다.
            필요하면 관련 문헌 후보까지 함께 탐색합니다.
          </p>
        </div>
        <div className="hero-side">
          <div className="author-line">24100017 신현종</div>
          <div className="hero-actions">
            <button type="button" className={showGuide ? "utility-button active" : "utility-button"} onClick={() => setShowGuide((value) => !value)}>
              사용법
            </button>
            <div className="download-menu-wrap">
              <button
                type="button"
                className={showDownloadMenu ? "utility-button download-button active" : "utility-button download-button"}
                onClick={() => setShowDownloadMenu((value) => !value)}
                disabled={!hasDownloadableArtifacts || downloading}
              >
                {downloading ? "생성 중..." : "산출물 다운로드"}
              </button>
              {showDownloadMenu && !downloading && (
                <div className="download-menu">
                  <div className="download-menu-label">다운로드 범위</div>
                  <div className="download-scope-options">
                    <button
                      type="button"
                      className={activeDownloadScope === "report" ? "scope-option active" : "scope-option"}
                      onClick={() => setDownloadScope("report")}
                      disabled={!hasReportArtifact}
                    >
                      <strong>보고서만</strong>
                      <span>{hasReportArtifact ? "생성·개선된 보고서 본문만" : "보고서 생성 후 선택 가능"}</span>
                    </button>
                    <button
                      type="button"
                      className={activeDownloadScope === "all" ? "scope-option active" : "scope-option"}
                      onClick={() => setDownloadScope("all")}
                    >
                      <strong>전체 산출물</strong>
                      <span>Overview · Evidence · 보고서 · 문헌 포함</span>
                    </button>
                  </div>
                  <div className="download-menu-divider" />
                  <div className="download-menu-label">파일 형식</div>
                  <button type="button" onClick={() => downloadPdfArtifacts(activeDownloadScope)}><strong>PDF</strong><span>선택한 범위를 인쇄용 문서로 저장</span></button>
                  <button type="button" onClick={() => downloadWordArtifacts(activeDownloadScope)}><strong>Word (.docx)</strong><span>선택한 범위를 수정 가능한 문서로 저장</span></button>
                  <button type="button" onClick={() => downloadPngArtifacts(activeDownloadScope)}><strong>PNG</strong><span>{activeDownloadScope === "report" ? "보고서 문서를 이미지로 저장" : "현재 전체 화면을 이미지로 저장"}</span></button>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      {showGuide && (
        <section className="guide-panel">
          <div className="guide-head">
            <div>
              <span className="eyebrow">QUICK GUIDE</span>
              <h2>사용법</h2>
            </div>
            <button type="button" className="guide-close" onClick={() => setShowGuide(false)}>닫기</button>
          </div>
          <div className="guide-grid">
            <div className="guide-card"><strong>1. 자료 입력</strong><span>파일 또는 프로젝트 폴더를 선택합니다.</span></div>
            <div className="guide-card"><strong>2. Evidence 분석</strong><span>빠른/정밀 분석으로 핵심 결과와 원자료 위치를 구조화합니다.</span></div>
            <div className="guide-card"><strong>3. 보고서 작업</strong><span>기존 보고서에 Evidence를 연결하거나 새 보고서를 생성합니다.</span></div>
            <div className="guide-card"><strong>4. 문헌·다운로드</strong><span>관련 문헌 후보를 확인하고 현재 산출물을 PDF·Word·PNG로 저장합니다.</span></div>
          </div>
          <div className="guide-note">관련 문헌은 후보 목록이며 실제 인용 전 원문 확인이 필요합니다. 생성형 AI 결과도 최종 제출 전 Evidence와 원문을 확인하세요.</div>
        </section>
      )}

      {error && <div className="error-box">{error}</div>}

      <section className="panel">
        <div className="section-heading">
          <div><span className="step">01</span><h2>연구 근거자료 업로드</h2></div>
          <span className="muted">최대 150개</span>
        </div>
        <div className="upload-grid">
          <label className="drop-zone">
            <input
              type="file"
              multiple
              accept=".csv,.txt,.md,.log,.json,.yaml,.yml,.pdf,.zip,.py,.ipynb,.js,.jsx,.ts,.tsx,.java,.c,.h,.cpp,.hpp,.cc,.cxx,.cs,.cu,.cuh,.go,.rs,.kt,.kts,.swift,.scala,.rb,.php,.lua,.dart,.r,.m,.sh,.bash,.zsh,.ps1,.bat,.cmd,.sql,.html,.htm,.css,.scss,.less,.vue,.svelte,.xml,.toml,.ini,.cfg,.conf,.proto,.tex,.urdf,.xacro,.sdf,.usda"
              onChange={(e) => {
                addFiles(Array.from(e.target.files || []), "files");
                e.currentTarget.value = "";
              }}
            />
            <strong>파일 추가</strong>
            <span>PDF · CSV · JSON/YAML · LOG · TXT/MD · ZIP · 주요 코드 / ZIP ≤ 80MB</span>
          </label>

          <label className="drop-zone folder-zone">
            <input
              type="file"
              multiple
              {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
              onChange={(e) => {
                addFiles(Array.from(e.target.files || []), "folder");
                e.currentTarget.value = "";
              }}
            />
            <strong>프로젝트 폴더 추가</strong>
            <span>지원 형식 자동 선별 · 개별 파일 ≤ 40MB</span>
          </label>
        </div>

        <div className="upload-summary">
          <strong>{files.length ? `분석 대상 ${files.length}개` : "선택된 자료 없음"}</strong>
          <span>지원 형식: 문서 · 데이터 · 로그 · 코드</span>
        </div>

        {uploadNotice && <div className="upload-notice">{uploadNotice}</div>}
        {analysisProgress && <div className="upload-notice progress-notice">{analysisProgress}</div>}

        {files.length > 0 && (
          <div className="selected-files">
            <div className="selected-files-head">
              <strong>분석할 자료 · {files.length}개</strong>
              <button type="button" className="file-clear" onClick={clearFiles}>전체 삭제</button>
            </div>
            <div className="selected-file-list">
              {files.map((file, index) => (
                <div className="selected-file" key={fileKey(file)}>
                  <div>
                    <strong>{displayPath(file)}</strong>
                    <span>{(file.size / 1024 / 1024).toFixed(file.size >= 1024 * 1024 ? 2 : 3)} MB</span>
                  </div>
                  <button type="button" onClick={() => removeFile(index)}>×</button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="analysis-depth-block">
          <div className="analysis-depth-head">
            <strong>분석 깊이</strong>
            <span>{ANALYSIS_PROFILES[analysisDepth].description}</span>
          </div>
          <div className="mode-switch analysis-depth-switch">
            <button
              type="button"
              className={analysisDepth === "fast" ? "mode-button active" : "mode-button"}
              onClick={() => setAnalysisDepth("fast")}
              disabled={busy !== null}
            >
              <strong>빠른 분석</strong>
              <small>핵심 Evidence 중심</small>
            </button>
            <button
              type="button"
              className={analysisDepth === "precise" ? "mode-button active" : "mode-button"}
              onClick={() => setAnalysisDepth("precise")}
              disabled={busy !== null}
            >
              <strong>정밀 분석</strong>
              <small>세부 Evidence·조건 보존</small>
            </button>
          </div>
        </div>

        <div className="actions">
          <button className="primary" onClick={analyze} disabled={!files.length || busy !== null}>
            {busy === "analyze" ? `${ANALYSIS_PROFILES[analysisDepth].label} 진행 중...` : `${ANALYSIS_PROFILES[analysisDepth].label} 시작 (${files.length})`}
          </button>
        </div>
      </section>

      {analysis && (
        <>
          <section className="panel">
            <div className="section-heading">
              <div><span className="step">02</span><h2>Research Overview</h2></div>
              <span className="muted">보고서 검증에 사용할 Evidence Catalog</span>
            </div>

            <div className="metrics-grid">
              <Metric label="Files" value={analysis.source_files.length} />
              <Metric label="Experiments" value={analysis.experiments.length} />
              <Metric label="Evidence" value={analysis.evidence.length} />
              <Metric label="Concepts" value={analysis.concepts.length} />
            </div>

            {analysis.coverage && (
              <div className="subpanel">
                <h3>Full Coverage Scan</h3>
                <p className="muted">
                  대형 LOG·CSV·코드는 일부 키워드만 고르는 대신 모든 line/row를 브라우저에서 전수 스캔하고,
                  블록별 Coverage Digest와 원문 Evidence를 만든 뒤 AI에 전달합니다.
                </p>
                <div className="coverage-grid">
                  <Metric label="Sources Scanned" value={`${analysis.coverage.parsed_sources}/${analysis.coverage.expanded_files}`} />
                  <Metric label="LOG Lines" value={analysis.coverage.log_lines_scanned.toLocaleString()} />
                  <Metric label="Code Lines" value={analysis.coverage.code_lines_scanned.toLocaleString()} />
                  <Metric label="CSV Rows" value={analysis.coverage.csv_rows_scanned.toLocaleString()} />
                  <Metric label="Text Lines" value={analysis.coverage.text_lines_scanned.toLocaleString()} />
                  <Metric label="PDF Pages" value={analysis.coverage.pdf_pages_scanned.toLocaleString()} />
                  <Metric label="Coverage Blocks" value={analysis.coverage.coverage_blocks.toLocaleString()} />
                  <Metric label="Compression" value={`${analysis.coverage.compression_percent}%`} />
                  <Metric label="AI Batches" value={analysis.coverage.ai_batches} />
                </div>
                <small className="muted">
                  Coverage Digest는 전체 구간의 구조·통계를 전달하는 문맥이며, Claim 근거는 RAW_EVIDENCE 원문 위치를 우선 사용합니다.
                </small>
              </div>
            )}

            <div className="overview-grid">
              <div className="subpanel">
                <h3>연구 주제</h3>
                <p className="lead">{analysis.research_topic}</p>
                <p>{analysis.summary}</p>
                <div className="divider" />
                <h3>주요 Finding</h3>
                <div className="stack">
                  {analysis.findings.slice(0, 8).map((finding, index) => (
                    <div className="finding" key={index}>
                      <span className={`pill ${finding.kind}`}>{finding.kind === "observed" ? "관찰" : "해석"}</span>
                      <div>
                        <div>{finding.text}</div>
                        <small>Evidence: {finding.evidence_ids.join(", ") || "없음"}</small>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="subpanel">
                <h3>Research Concepts</h3>
                <p className="muted">논문 Retrieval에 사용할 핵심 연구 개념입니다.</p>
                <div className="concept-list">
                  {analysis.concepts.slice(0, 30).map((concept, index) => (
                    <div className="concept" key={`${concept.name_en}-${index}`}>
                      <span className="rank">{index + 1}</span>
                      <div className="concept-main">
                        <strong>{concept.name_en}</strong>
                        <small>{concept.name_ko}</small>
                      </div>
                      <span>{Math.round(concept.importance * 100)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {analysis.warnings.length > 0 && (
              <div className="warning-box">
                <strong>분석 경고</strong>
                {analysis.warnings.map((warning, index) => <div key={index}>• {warning}</div>)}
              </div>
            )}
          </section>

          <section className="panel">
            <div className="section-heading">
              <div><span className="step">03</span><h2>보고서 작업</h2></div>
              <span className="muted">기존 보고서가 있으면 근거 연결이 우선입니다.</span>
            </div>

            <div className="mode-switch">
              <button className={reportMode === "existing" ? "mode-button active" : "mode-button"} onClick={() => setReportMode("existing")}>기존 보고서 연결·개선</button>
              <button className={reportMode === "new" ? "mode-button active" : "mode-button"} onClick={() => setReportMode("new")}>보고서가 없음 · 새로 작성</button>
            </div>

            {reportMode === "existing" ? (
              <div className="existing-report-box">
                <div className="existing-report-tools">
                  <label className="report-file-button">
                    <input
                      type="file"
                      accept=".txt,.md,.pdf,.docx"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) importExistingReport(file);
                        e.currentTarget.value = "";
                      }}
                    />
                    {busy === "import-report" ? "불러오는 중..." : "기존 보고서 파일 불러오기"}
                  </label>
                  <span>TXT · MD · PDF · DOCX</span>
                </div>

                <label className="instruction-field">
                  <div className="instruction-head">
                    <strong>기존 보고서 원문</strong>
                    <span>{existingReportText.length.toLocaleString()}자 · {existingReportName}</span>
                  </div>
                  <textarea
                    className="report-source-textarea"
                    value={existingReportText}
                    onChange={(e) => {
                      setExistingReportText(e.target.value);
                      setExistingReportName("직접 입력");
                      setGroundedReport(null);
                    }}
                    placeholder="이미 작성한 보고서를 붙여넣거나 위 버튼으로 파일을 불러오세요. 이 원문은 근거 연결 단계에서 재작성하지 않습니다."
                  />
                  <small>첫 단계에서는 원문을 바꾸지 않고 Claim ↔ Evidence만 연결합니다.</small>
                </label>

                <div className="toolbar">
                  <button className="primary" disabled={!existingReportText.trim() || busy !== null} onClick={groundExistingReport}>
                    {busy === "ground" ? "근거 연결 중..." : "기존 보고서에 근거 연결"}
                  </button>
                  <button className="secondary" disabled={busy !== null} onClick={findPapers}>
                    {busy === "papers" ? "OpenAlex 검색 중..." : "관련 논문 찾기 (30×5)"}
                  </button>
                </div>

                {groundedReport && (
                  <div className="develop-controls">
                    <div className="coverage-grid">
                      <Metric label="Claims" value={groundedReport.stats.total_claims} />
                      <Metric label="Internal Evidence" value={groundedReport.stats.internally_supported} />
                      <Metric label="Citation Needed" value={groundedReport.stats.citation_needed} />
                      <Metric label="Unsupported" value={groundedReport.stats.unsupported} />
                    </div>

                    <label className="instruction-field">
                      <div className="instruction-head">
                        <strong>개선 지시</strong>
                        <span>{reportInstruction.length}/4000</span>
                      </div>
                      <textarea
                        value={reportInstruction}
                        onChange={(e) => setReportInstruction(e.target.value)}
                        maxLength={4000}
                        placeholder="예: 기존 문체와 목차는 유지하고, 최고 성능 실험을 중심으로 결과 분석을 더 자세히 보강해줘. 근거 없는 문장은 삭제하지 말고 경고가 드러나게 완화해줘."
                      />
                    </label>

                    <div className="toolbar">
                      <select value={reportType} onChange={(e) => setReportType(e.target.value)}>
                        <option>연구 결과보고서</option>
                        <option>월간 연구 활동보고서</option>
                        <option>논문 초안</option>
                      </select>
                      <select value={lengthMode} onChange={(e) => setLengthMode(e.target.value)}>
                        <option value="preserve">기존 분량 유지</option>
                        <option value="medium">조금 더 자세히 · 5~7천자</option>
                        <option value="long">길게 · 8천~1.2만자</option>
                        <option value="very_long">매우 길게 · 1.2~1.6만자</option>
                      </select>
                      <button className="primary" disabled={busy !== null} onClick={developExistingReport}>
                        {busy === "develop" ? "Sol이 개선 중..." : "근거 기반 개선본 생성"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="new-report-box">
                <label className="instruction-field">
                  <div className="instruction-head">
                    <strong>새 보고서 작성 지시</strong>
                    <span>{reportInstruction.length}/4000</span>
                  </div>
                  <textarea
                    value={reportInstruction}
                    onChange={(e) => setReportInstruction(e.target.value)}
                    maxLength={4000}
                    placeholder="예: 성능이 가장 높은 실험을 중심으로 작성하고, 다른 실험은 비교용으로 언급해줘. 결과 분석과 한계점을 자세히 작성해줘."
                  />
                </label>
                <div className="toolbar">
                  <select value={reportType} onChange={(e) => setReportType(e.target.value)}>
                    <option>연구 결과보고서</option>
                    <option>월간 연구 활동보고서</option>
                    <option>논문 초안</option>
                  </select>
                  <select value={lengthMode} onChange={(e) => setLengthMode(e.target.value)}>
                    <option value="short">짧게 · 2.5~4천자</option>
                    <option value="medium">보통 · 5~7천자</option>
                    <option value="long">길게 · 8천~1.2만자</option>
                    <option value="very_long">매우 길게 · 1.2~1.6만자</option>
                  </select>
                  <button className="primary" disabled={busy !== null} onClick={generateReport}>
                    {busy === "report" ? "Sol이 작성 중..." : "Evidence 기반 새 보고서 생성"}
                  </button>
                  <button className="secondary" disabled={busy !== null} onClick={findPapers}>
                    {busy === "papers" ? "OpenAlex 검색 중..." : "관련 논문 찾기 (30×5)"}
                  </button>
                </div>
              </div>
            )}
          </section>
        </>
      )}

      {groundedReport && reportMode === "existing" && (
        <section className="panel">
          <div className="section-heading">
            <div><span className="step">04</span><h2>기존 보고서 Evidence 연결</h2></div>
            <span className="muted">원문은 유지하고 Claim에만 근거를 연결했습니다.</span>
          </div>
          <div className="report-layout">
            <article className="document">
              <h2>{groundedReport.title}</h2>
              {groundedReport.paragraphs.map((paragraph) => (
                <div className="doc-paragraph grounded-paragraph" key={paragraph.id}>
                  <p>{paragraph.text}</p>
                  <div className="claim-row">
                    {paragraph.claims.filter((c) => c.type !== "narrative").map((claim) => (
                      <ClaimButton key={claim.id} claim={claim} selectedClaim={selectedClaim} onSelect={setSelectedClaim} />
                    ))}
                  </div>
                </div>
              ))}
            </article>
            <EvidencePanel selectedClaim={selectedClaim} selectedEvidence={selectedEvidence} />
          </div>
          {groundedReport.warnings.length > 0 && (
            <div className="warning-box">{groundedReport.warnings.map((w, i) => <div key={i}>• {w}</div>)}</div>
          )}
        </section>
      )}

      {report && (
        <section className="panel">
          <div className="section-heading">
            <div><span className="step">{groundedReport && reportMode === "existing" ? "05" : "04"}</span><h2>{groundedReport && reportMode === "existing" ? "근거 기반 개선본" : "근거 기반 새 보고서"}</h2></div>
            <span className="muted">기존 보고서 모드에서는 원문과 별도로 개선본을 생성합니다.</span>
          </div>
          <div className="report-layout">
            <article className="document">
              <h2>{report.title}</h2>
              {report.sections.map((section, sectionIndex) => (
                <section className="doc-section" key={sectionIndex}>
                  <h3>{section.heading}</h3>
                  {section.paragraphs.map((paragraph, paragraphIndex) => (
                    <div className="doc-paragraph" key={paragraphIndex}>
                      <p>{paragraph.text}</p>
                      <div className="claim-row">
                        {paragraph.claims.filter((c) => c.type !== "narrative").map((claim) => (
                          <ClaimButton key={claim.id} claim={claim} selectedClaim={selectedClaim} onSelect={setSelectedClaim} />
                        ))}
                      </div>
                    </div>
                  ))}
                </section>
              ))}
            </article>
            <EvidencePanel selectedClaim={selectedClaim} selectedEvidence={selectedEvidence} />
          </div>
        </section>
      )}

      {paperPayload && (
        <section className="panel">
          <div className="section-heading">
            <div><span className="step">06</span><h2>Literature Pool</h2></div>
            <span className="muted">{paperPayload.raw_slots} search slots → {paperPayload.unique_papers} unique papers</span>
          </div>
          <p className="muted">같은 논문이 여러 핵심 Concept에서 반복 검색되면 최종 검색 우선순위에 반영됩니다.</p>
          <div className="paper-list">
            {paperPayload.papers.slice(0, 50).map((paper, index) => (
              <article className="paper-card" key={paper.id}>
                <div className="paper-rank">#{index + 1}</div>
                <div className="paper-body">
                  <a href={paper.url} target="_blank" rel="noreferrer"><h3>{paper.title}</h3></a>
                  <p className="meta">{paper.year || "연도 미상"} · {paper.venue || "출처 미상"} · cited by {paper.cited_by_count}</p>
                  <p className="authors">{paper.authors.join(", ")}</p>
                  <div className="tag-row">
                    {paper.matched_concepts.slice(0, 6).map((concept) => (
                      <span className="tag" key={`${paper.id}-${concept.name}`}>{concept.name}</span>
                    ))}
                  </div>
                  {paper.abstract && <details><summary>초록 보기</summary><p>{paper.abstract}</p></details>}
                </div>
                <div className="score">{paper.final_score.toFixed(1)}</div>
              </article>
            ))}
          </div>
        </section>
      )}

      <footer>
        Research2Report · 24100017 신현종 · Evidence 기반 보고서 검증·작성
      </footer>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong></div>;
}

function ClaimButton({
  claim,
  selectedClaim,
  onSelect,
}: {
  claim: ReportClaim;
  selectedClaim: ReportClaim | null;
  onSelect: (claim: ReportClaim) => void;
}) {
  return (
    <button
      className={`claim-chip ${claim.type} ${selectedClaim?.id === claim.id ? "active" : ""}`}
      onClick={() => onSelect(claim)}
      title={claim.text}
    >
      {claim.id} · {claim.type === "internal_fact" ? "내부 근거" : claim.type === "external_claim" ? "인용 필요" : claim.type === "unsupported" ? "근거 부족" : "해석"}
    </button>
  );
}

function EvidencePanel({
  selectedClaim,
  selectedEvidence,
}: {
  selectedClaim: ReportClaim | null;
  selectedEvidence: Evidence[] | undefined;
}) {
  return (
    <aside className="evidence-panel">
      {!selectedClaim ? (
        <div className="empty-state">보고서의 Claim 배지를 클릭하세요.</div>
      ) : (
        <>
          <div className="pill-row">
            <span className={`pill ${selectedClaim.type}`}>{selectedClaim.type}</span>
            {selectedClaim.citation_required && <span className="pill citation">Citation Needed</span>}
          </div>
          <h3>{selectedClaim.text}</h3>
          {selectedEvidence?.length ? (
            <div className="stack">
              {selectedEvidence.map((ev) => (
                <div className="evidence-card" key={ev.id}>
                  <strong>{ev.id} · {ev.source_name}</strong>
                  <span>{ev.source_location}</span>
                  <p>{ev.content}</p>
                  {ev.raw_quote && <blockquote>{ev.raw_quote}</blockquote>}
                </div>
              ))}
            </div>
          ) : (
            <div className="warning-box">
              {selectedClaim.citation_required
                ? `외부 문헌이 필요합니다. 검색 개념: ${selectedClaim.search_concepts.join(", ") || "미지정"}`
                : "연결된 내부 Evidence가 없습니다. 제출 전 반드시 확인하세요."}
            </div>
          )}
        </>
      )}
    </aside>
  );
}
