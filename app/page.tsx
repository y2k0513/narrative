"use client";

import { useMemo, useState } from "react";
import type {
  Evidence,
  GroundedReport,
  PaperResult,
  ReportClaim,
  ReportDraft,
  ResearchAnalysis,
} from "@/lib/types";

type PaperPayload = {
  raw_slots: number;
  unique_papers: number;
  papers: PaperResult[];
};

type BrowserFile = File & { webkitRelativePath?: string };
type BusyMode = "analyze" | "report" | "papers" | "import-report" | "ground" | "develop" | null;
type ReportMode = "existing" | "new";

const CODE_EXTENSIONS = [
  "py", "ipynb", "js", "jsx", "ts", "tsx",
  "java", "c", "h", "cpp", "hpp", "cc", "cxx", "cs", "cu", "cuh",
  "go", "rs", "kt", "kts", "swift", "scala",
  "rb", "php", "lua", "dart", "r", "m",
  "sh", "bash", "zsh", "ps1", "bat", "cmd",
  "sql", "html", "htm", "css", "scss", "less", "vue", "svelte",
  "xml", "toml", "ini", "cfg", "conf", "proto", "tex", "urdf", "xacro", "sdf", "usda",
];
const SUPPORTED_FOLDER_EXTENSIONS = new Set([
  "csv", "txt", "md", "log", "json", "yaml", "yml", "pdf", ...CODE_EXTENSIONS,
]);
const SUPPORTED_FILE_EXTENSIONS = new Set([...SUPPORTED_FOLDER_EXTENSIONS, "zip"]);
const IGNORED_PROJECT_DIRS = new Set([
  ".git", ".next", ".idea", ".vscode",
  "node_modules", "dist", "build", "coverage",
  "venv", ".venv", "env", "__pycache__", ".pytest_cache",
  "checkpoints", "checkpoint", "weights",
]);
const MAX_SELECTED_FILES = 100;
const MAX_FOLDER_FILE_SIZE = 20 * 1024 * 1024;
const MAX_MANUAL_ZIP_SIZE = 30 * 1024 * 1024;

function extensionOf(name: string) {
  const parts = name.toLowerCase().split(".");
  return parts.length > 1 ? parts.at(-1)! : "";
}

function displayPath(file: File) {
  const relativePath = (file as BrowserFile).webkitRelativePath;
  return relativePath || file.name;
}

function fileKey(file: File) {
  return `${displayPath(file)}::${file.size}::${file.lastModified}`;
}

function isIgnoredProjectPath(file: File) {
  const path = displayPath(file).replace(/\\/g, "/").toLowerCase();
  return path.split("/").some((part) => IGNORED_PROJECT_DIRS.has(part));
}

async function readJsonOrThrow(response: Response) {
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || "요청에 실패했습니다.");
  return json;
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

  const evidenceMap = useMemo(() => {
    const map = new Map<string, Evidence>();
    analysis?.evidence.forEach((e) => map.set(e.id, e));
    return map;
  }, [analysis]);

  function addFiles(newFiles: File[], source: "files" | "folder" = "files") {
    const supported = source === "folder" ? SUPPORTED_FOLDER_EXTENSIONS : SUPPORTED_FILE_EXTENSIONS;
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
      if (oversized) messages.push(`20MB를 넘는 분석 파일 ${oversized}개는 제외했습니다.`);
    } else {
      if (accepted.length) messages.push(`파일 ${accepted.length}개를 추가했습니다.`);
      if (unsupported) messages.push(`지원하지 않는 파일 ${unsupported}개는 제외했습니다.`);
      if (oversized) messages.push(`30MB를 넘는 ZIP ${oversized}개는 제외했습니다.`);
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
    setAnalysis(null);
    setReport(null);
    setGroundedReport(null);
    setPaperPayload(null);
    setSelectedClaim(null);
    try {
      const form = new FormData();
      files.forEach((file) => {
        form.append("files", file);
        form.append("filePaths", displayPath(file));
      });
      const response = await fetch("/api/analyze", { method: "POST", body: form });
      setAnalysis((await readJsonOrThrow(response)) as ResearchAnalysis);
    } catch (e) {
      setError(e instanceof Error ? e.message : "분석 오류");
    } finally {
      setBusy(null);
    }
  }

  async function importExistingReport(file: File) {
    setBusy("import-report");
    setError("");
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/report/import", { method: "POST", body: form });
      const payload = await readJsonOrThrow(response);
      setExistingReportText(payload.text);
      setExistingReportName(payload.name);
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
          <span className="muted">문서 · 데이터 · 코드 · PDF · ZIP</span>
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
            <span>여러 번 선택해도 기존 목록에 누적됩니다. 작은 ZIP도 추가할 수 있습니다.</span>
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
            <span>소스코드는 포함하고 모델 가중치·데이터셋·빌드 산출물 등은 제외합니다.</span>
          </label>
        </div>

        <div className="upload-summary">
          <strong>{files.length ? `현재 분석 대상 ${files.length}개` : "아직 선택된 연구자료가 없습니다."}</strong>
          <span>파일/폴더를 여러 번 추가해도 기존 선택은 유지됩니다.</span>
        </div>

        {uploadNotice && <div className="upload-notice">{uploadNotice}</div>}

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

        <div className="actions">
          <button className="primary" onClick={analyze} disabled={!files.length || busy !== null}>
            {busy === "analyze" ? "분석 중..." : `연구자료 분석 (${files.length})`}
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
        기본 흐름: 기존 보고서가 있으면 원문을 먼저 Evidence와 연결하고, 필요할 때만 개선합니다. 기존 보고서가 없을 때만 새 초안을 생성합니다.
      </footer>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
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
