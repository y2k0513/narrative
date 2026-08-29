import { NextResponse } from "next/server";
import { createStructuredResponse } from "@/lib/openai";
import { reportGroundingSchema } from "@/lib/schemas";
import { splitReportParagraphs } from "@/lib/file-parser";
import type { GroundedReport, ReportClaim, ResearchAnalysis } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 90;

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      analysis?: ResearchAnalysis;
      reportText?: string;
      sourceName?: string;
    };

    if (!body.analysis) return NextResponse.json({ error: "analysis가 필요합니다." }, { status: 400 });
    const reportText = (body.reportText || "").trim();
    if (!reportText) return NextResponse.json({ error: "기존 보고서 내용이 필요합니다." }, { status: 400 });

    const paragraphs = splitReportParagraphs(reportText);
    if (!paragraphs.length) return NextResponse.json({ error: "분석할 보고서 문단이 없습니다." }, { status: 400 });

    const evidenceCatalog = body.analysis.evidence.map((e) => ({
      id: e.id,
      type: e.type,
      content: e.content,
      experiment_id: e.experiment_id,
      source: `${e.source_name} / ${e.source_location}`,
      raw_quote: e.raw_quote,
    }));

    const model = process.env.OPENAI_PARSER_MODEL || "gpt-5.6-luna";
    const raw = await createStructuredResponse<any>({
      model,
      schemaName: "existing_report_grounding",
      schema: reportGroundingSchema as unknown as Record<string, unknown>,
      reasoningEffort: "medium",
      maxOutputTokens: 16000,
      instructions: `
당신은 Research2Report의 Existing Report Grounder다.
목표는 기존 보고서를 새로 쓰는 것이 아니라, 사용자가 이미 작성한 보고서의 각 주장과 업로드된 연구 Evidence를 연결하는 것이다.

엄격한 규칙:
1. PARAGRAPH의 원문을 수정하거나 재작성하지 않는다. 오직 claim annotation만 반환한다.
2. 내부 연구 결과, 수치, 실험 설정, 방법에 대한 주장은 internal_fact로 분류하고 실제 evidence_id를 연결한다.
3. 연구 결과에서 해석한 문장은 interpretation으로 분류하고 가능한 내부 evidence_id를 연결한다.
4. 일반 학술 지식이나 선행연구 근거가 필요한 문장은 external_claim, citation_required=true로 표시한다.
5. 업로드된 연구자료에서 사실 근거를 찾을 수 없는 내부 주장은 unsupported로 표시한다.
6. 서론 연결문, 목적 소개처럼 별도 근거가 필요 없는 서술은 narrative로 분류할 수 있다.
7. 존재하지 않는 Evidence ID를 만들지 않는다.
8. 숫자가 비슷하다는 이유만으로 연결하지 말고 실험/맥락까지 맞는 Evidence만 연결한다.
9. claim.text는 해당 PARAGRAPH에서 검증 대상이 되는 실제 주장 부분을 간결하게 인용·요약한다.
10. 외부 문헌이 필요한 claim에는 검색에 쓸 영어 search_concepts를 1~4개 넣는다.
`,
      input: JSON.stringify({
        research_topic: body.analysis.research_topic,
        objective: body.analysis.objective,
        evidence_catalog: evidenceCatalog,
        paragraphs,
      }, null, 2),
    });

    const validEvidenceIds = new Set(body.analysis.evidence.map((e) => e.id));
    const annotationMap = new Map<string, any>(raw.annotations.map((a: any) => [a.paragraph_id, a]));
    let claimCounter = 1;

    const groundedParagraphs = paragraphs.map((paragraph) => {
      const annotation = annotationMap.get(paragraph.id);
      const claims: ReportClaim[] = (annotation?.claims || []).map((claim: any) => ({
        id: `CL${String(claimCounter++).padStart(3, "0")}`,
        text: claim.text,
        type: claim.type,
        evidence_ids: (claim.evidence_ids || []).filter((id: string) => validEvidenceIds.has(id)),
        citation_required: Boolean(claim.citation_required),
        search_concepts: claim.search_concepts || [],
        confidence: typeof claim.confidence === "number" ? claim.confidence : 0.5,
      }));
      return { ...paragraph, claims };
    });

    const allClaims = groundedParagraphs.flatMap((p) => p.claims);
    const grounded: GroundedReport = {
      title: raw.title || body.sourceName || "기존 보고서",
      source_name: body.sourceName || "직접 입력",
      original_text: reportText,
      paragraphs: groundedParagraphs,
      warnings: raw.warnings || [],
      stats: {
        total_claims: allClaims.filter((c) => c.type !== "narrative").length,
        internally_supported: allClaims.filter((c) =>
          (c.type === "internal_fact" || c.type === "interpretation") && c.evidence_ids.length > 0,
        ).length,
        citation_needed: allClaims.filter((c) => c.citation_required || c.type === "external_claim").length,
        unsupported: allClaims.filter((c) => c.type === "unsupported").length,
      },
    };

    return NextResponse.json(grounded);
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "기존 보고서 근거 연결 중 오류가 발생했습니다." },
      { status: 500 },
    );
  }
}
