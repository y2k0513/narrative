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
    description: "전체 자료를 전수 스캔한 뒤 핵심 Evidence 중심으로 압축 · 약 2~3 AI 배치",
    targetBatches: 3,
    targetChars: 360_000,
  },
  precise: {
    label: "정밀 분석",
    description: "원문 Evidence와 실험 조건을 약 2배 더 보존 · 약 4~5 AI 배치",
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
      messages.push(`폴더에서 분석 가능한 파일 ${accepted.length}개를 추가했습니다.`);
      if (unsupported) messages.push(`모델/바이너리/빌드 산출물 등 ${unsupported}개는 제외했습니다.`);
      if (oversized) messages.push(`40MB를 넘는 분석 파일 ${oversized}개는 제외했습니다.`);
    } else {
      if (accepted.length) messages.push(`파일 ${accepted.length}개를 추가했습니다.`);
      if (unsupported) messages.push(`지원하지 않는 파일 ${unsupported}개는 제외했습니다.`);
      if (oversized) messages.push(`80MB를 넘는 ZIP ${oversized}개는 제외했습니다. 큰 프로젝트는 폴더 선택을 사용하세요.`);
    }
    if (overLimit) messages.push(`분석 대상은 최대 ${MAX_SELECTED_FILES}개라 ${overLimit}개를 추가하지 않았습니다.`);
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

  const selectedEvidence = selectedClaim?.evidence_ids
    .map((id) => evidenceMap.get(id))
    .filter(Boolean) as Evidence[] | undefined;

  return (
    <main className="page-shell">
      <header className="hero">
        <div>
          <div className="eyebrow">SEOULTECH AI NARRATIVE MVP</div>
          <h1>Research2Report</h1>
          <p>
            이미 작성한 보고서가 있다면 <strong>원문을 유지한 채 연구자료 근거와 연결</strong>하고,
            보고서가 없다면 Evidence 기반 초안을 생성합니다.
          </p>
        </div>
        <div className="hero-badge">Report ↔ Evidence · Draft when needed</div>
      </header>

      {error && <div className="error-box">{error}</div>}

      <section className="panel">
        <div className="section-heading">
          <div><span className="step">01</span><h2>연구 근거자료 업로드</h2></div>
          <span className="muted">브라우저 전처리 · 원본 대용량 업로드 없음</span>
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
            <span>여러 번 선택해도 누적됩니다. ZIP은 80MB 이하, 큰 프로젝트는 폴더 선택을 권장합니다.</span>
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
            <span>소스코드/문서만 브라우저에서 읽고 .pt/.pth/ckpt·데이터셋·빌드 산출물은 전송하지 않습니다.</span>
          </label>
        </div>

        <div className="upload-summary">
          <strong>{files.length ? `현재 분석 대상 ${files.length}개` : "아직 선택된 연구자료가 없습니다."}</strong>
          <span>원본 파일은 Vercel API로 보내지 않고 브라우저에서 텍스트/구조 데이터로 변환한 뒤 작은 배치만 전송합니다.</span>
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
              <small>현재 기본 · 약 2~3 배치</small>
            </button>
            <button
              type="button"
              className={analysisDepth === "precise" ? "mode-button active" : "mode-button"}
              onClick={() => setAnalysisDepth("precise")}
              disabled={busy !== null}
            >
              <strong>정밀 분석</strong>
              <small>Evidence 약 2배 보존 · 약 4~5 배치</small>
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
        기본 흐름: 연구자료 전체를 브라우저에서 Full Coverage Scan → 계층 압축 → 병렬 AI 해석합니다. 기존 보고서가 있으면 원문을 Evidence와 연결하고, 없을 때만 새 초안을 생성합니다.
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
