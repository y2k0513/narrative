import { NextResponse } from "next/server";
import { expandUploadedFiles, parseUploadedFile, serializeSources } from "@/lib/file-parser";
import { createStructuredResponse } from "@/lib/openai";
import { researchAnalysisSchema } from "@/lib/schemas";
import type { ResearchAnalysis } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

type RawAnalysis = Omit<ResearchAnalysis, "evidence" | "findings" | "source_files"> & {
  evidence: Array<Omit<ResearchAnalysis["evidence"][number], "id" | "source_name"> & { temp_id: string }>;
  findings: Array<{ text: string; kind: "observed" | "inferred"; evidence_temp_ids: string[] }>;
};

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const uploadedFiles = form.getAll("files").filter((item): item is File => item instanceof File);
    const uploadedPaths = form.getAll("filePaths").map((item) => String(item));

    if (!uploadedFiles.length) {
      return NextResponse.json({ error: "연구자료 파일을 1개 이상 업로드하세요." }, { status: 400 });
    }
    if (uploadedFiles.length > 100) {
      return NextResponse.json(
        { error: "한 번에 최대 100개의 분석 대상 파일을 업로드할 수 있습니다." },
        { status: 400 },
      );
    }

    // 폴더 선택에서 받은 상대 경로를 File.name으로 복원해 Evidence 출처에 보존한다.
    const namedUploads = uploadedFiles.map((file, index) => {
      const requestedPath = (uploadedPaths[index] || file.name)
        .replace(/\\/g, "/")
        .replace(/^\/+/, "")
        .replace(/\0/g, "")
        .trim();
      const safePath = requestedPath && !requestedPath.split("/").includes("..") ? requestedPath : file.name;
      if (safePath === file.name) return file;
      return new File([file], safePath, { type: file.type, lastModified: file.lastModified });
    });

    const { files, warnings: uploadWarnings } = await expandUploadedFiles(namedUploads);
    if (!files.length) {
      return NextResponse.json(
        { error: "분석 가능한 파일이 없습니다. 연구 문서·데이터·지원 코드 파일을 포함해 주세요." },
        { status: 400 },
      );
    }
    if (files.length > 100) {
      return NextResponse.json(
        { error: "압축 해제 후 분석 대상 파일은 최대 100개까지 지원합니다." },
        { status: 400 },
      );
    }

    const sources = [];
    for (let i = 0; i < files.length; i++) {
      sources.push(await parseUploadedFile(files[i], `SRC${String(i + 1).padStart(2, "0")}`));
    }

    const serialized = serializeSources(sources);
    const parserModel = process.env.OPENAI_PARSER_MODEL || "gpt-5.6-luna";
    const maxConcepts = Number(process.env.MAX_RESEARCH_CONCEPTS || 30);

    const raw = await createStructuredResponse<RawAnalysis>({
      model: parserModel,
      schemaName: "research_analysis",
      schema: researchAnalysisSchema as unknown as Record<string, unknown>,
      reasoningEffort: "low",
      instructions: `
당신은 AI/ML 연구자료를 구조화하는 Research Parser다.
목표는 보고서를 쓰는 것이 아니라 업로드된 원본에서 확인 가능한 연구 사실을 구조화하는 것이다.

엄격한 규칙:
1. SOURCE 블록에 실제로 존재하는 정보만 추출한다.
2. 숫자, metric, parameter 값은 원문 값을 그대로 사용하고 추정하지 않는다.
3. source_id와 source_location은 입력의 SOURCE 헤더에 적힌 값을 그대로 복사한다.
4. evidence.raw_quote에는 해당 근거를 확인할 수 있는 짧은 원문을 넣는다.
5. observed finding은 자료에서 직접 확인되는 패턴만 쓴다.
6. inferred finding은 해석임을 명확히 하고 원인을 단정하지 않는다.
7. Research Concept은 단순 빈도 단어가 아니라 문헌검색에 유용한 학술 개념으로 뽑는다.
8. 동의어나 매우 가까운 표현은 하나의 concept으로 통합하고 aliases에 넣는다.
9. concept의 영어 이름(name_en)은 학술 검색에 바로 사용할 수 있는 표현이어야 한다.
10. 각 concept의 search_query에는 OpenAlex 키워드 검색에 사용할 짧은 영어 검색어를 작성한다. 연구 도메인을 포함하되 너무 많은 단어를 AND로 묶지 말고 3~7개 핵심 단어 중심으로 작성한다.
11. 최대 ${maxConcepts}개의 concept을 중요도 순으로 반환한다.
12. 코드 파일은 구현 방식, 파라미터, 데이터 흐름, 알고리즘 구조의 근거로 사용할 수 있다. 하지만 코드가 실제로 실행되었다거나 특정 성능을 냈다는 근거로 사용하면 안 된다. 실행 결과와 성능은 로그, CSV, 결과 문서 등 별도 실행 근거가 있을 때만 사실로 구조화한다.
13. Jupyter Notebook은 코드/마크다운 셀의 내용만 근거로 사용하며 output이 없다고 실행 여부를 추정하지 않는다.
14. 자료가 불완전하거나 서로 충돌하면 warnings에 기록한다.
`,
      input: `다음 연구자료를 분석하라.\n${serialized.text}`,
    });

    const tempToId = new Map<string, string>();
    const sourceNameMap = new Map(sources.map((s) => [s.source_id, s.name]));
    const evidence = raw.evidence.map((ev, index) => {
      const id = `EV${String(index + 1).padStart(3, "0")}`;
      tempToId.set(ev.temp_id, id);
      return {
        id,
        type: ev.type,
        content: ev.content,
        experiment_id: ev.experiment_id,
        source_id: ev.source_id,
        source_name: sourceNameMap.get(ev.source_id) || ev.source_id,
        source_location: ev.source_location,
        raw_quote: ev.raw_quote,
      };
    });

    const analysis: ResearchAnalysis = {
      ...raw,
      evidence,
      findings: raw.findings.map((finding) => ({
        text: finding.text,
        kind: finding.kind,
        evidence_ids: finding.evidence_temp_ids.map((id) => tempToId.get(id)).filter((id): id is string => Boolean(id)),
      })),
      concepts: raw.concepts.slice(0, maxConcepts).sort((a, b) => b.importance - a.importance),
      source_files: sources.map((s) => ({
        source_id: s.source_id,
        name: s.name,
        type: s.type,
        segment_count: s.segments.length,
      })),
      warnings: [
        ...raw.warnings,
        ...uploadWarnings,
        ...(serialized.truncated ? ["업로드 자료가 길어 AI 입력 한도 관리를 위해 일부 후반부 텍스트가 MVP 분석에서 제외되었습니다."] : []),
      ],
    };

    return NextResponse.json(analysis);
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "연구자료 분석 중 오류가 발생했습니다." },
      { status: 500 },
    );
  }
}
