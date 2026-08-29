import { NextResponse } from "next/server";
import { createStructuredResponse } from "@/lib/openai";
import { reportDraftSchema } from "@/lib/schemas";
import type { GroundedReport, ReportDraft, ResearchAnalysis } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 120;

const LENGTH_GUIDE: Record<string, string> = {
  preserve: "기존 보고서와 비슷한 분량을 유지한다.",
  medium: "필요한 근거와 설명을 보강해 약 5,000~7,000자 수준을 목표로 한다.",
  long: "근거가 충분한 부분을 상세히 전개해 약 8,000~12,000자 수준을 목표로 한다.",
  very_long: "근거가 충분한 부분을 세부적으로 전개해 약 12,000~16,000자 수준을 목표로 한다. 의미 없는 반복으로 분량을 채우지 않는다.",
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      analysis?: ResearchAnalysis;
      groundedReport?: GroundedReport;
      userInstruction?: string;
      lengthMode?: string;
      reportType?: string;
    };

    if (!body.analysis || !body.groundedReport) {
      return NextResponse.json({ error: "analysis와 groundedReport가 필요합니다." }, { status: 400 });
    }

    const userInstruction = (body.userInstruction || "").trim().slice(0, 4000);
    const reportType = body.reportType || "연구 결과보고서";
    const lengthGuide = LENGTH_GUIDE[body.lengthMode || "preserve"] || LENGTH_GUIDE.preserve;
    const reportModel = process.env.OPENAI_REPORT_MODEL || "gpt-5.6-sol";

    const evidenceCatalog = body.analysis.evidence.map((e) => ({
      id: e.id,
      type: e.type,
      content: e.content,
      experiment_id: e.experiment_id,
      source: `${e.source_name} / ${e.source_location}`,
      raw_quote: e.raw_quote,
    }));

    const originalParagraphs = body.groundedReport.paragraphs.map((p) => ({
      id: p.id,
      text: p.text,
      claims: p.claims,
    }));

    const draft = await createStructuredResponse<any>({
      model: reportModel,
      schemaName: "developed_research_report",
      schema: reportDraftSchema as unknown as Record<string, unknown>,
      reasoningEffort: "medium",
      maxOutputTokens: 24000,
      instructions: `
당신은 Research2Report의 Report Developer다.
사용자가 이미 작성한 보고서를 바탕으로 근거 연결을 강화하고 필요한 부분만 발전시킨 개선본을 작성한다.

가장 중요한 원칙:
1. 이것은 새 보고서를 처음부터 다시 쓰는 작업이 아니다. 기존 보고서의 핵심 구조, 논지, 이미 잘 작성된 표현을 최대한 보존한다.
2. 기존 문장에서 업로드된 Evidence로 확인되는 내용은 유지하고 evidence_id를 연결한다.
3. 근거가 약하거나 잘못된 내부 주장은 사실처럼 강화하지 않는다. unsupported로 표시하거나 근거에 맞게 완화한다.
4. 사용자가 요청한 강조점, 비교 방식, 문체, 분량은 반영하되 Evidence 규칙보다 우선할 수 없다.
5. 기존 보고서에 없는 내용을 추가할 때는 업로드된 Evidence나 명시적 해석으로만 확장한다.
6. 일반 학술 주장에는 external_claim/citation_required를 사용하고 가짜 인용을 만들지 않는다.
7. 수치와 실험 설정은 evidence_catalog와 정확히 일치해야 한다.
8. 단순 표현 교체를 위해 모든 문장을 재작성하지 않는다. 수정 이유가 없는 문장은 의미와 표현을 최대한 유지한다.
9. ${lengthGuide}
10. 문단을 늘릴 때 같은 내용을 반복하지 말고, 방법·실험조건·결과 비교·한계·해석 등 실제 근거가 있는 내용을 확장한다.
`,
      input: JSON.stringify({
        report_type: reportType,
        original_report: originalParagraphs,
        research_topic: body.analysis.research_topic,
        objective: body.analysis.objective,
        methods: body.analysis.methods,
        experiments: body.analysis.experiments,
        findings: body.analysis.findings,
        evidence_catalog: evidenceCatalog,
        user_instruction: userInstruction || null,
      }, null, 2),
    });

    const validEvidenceIds = new Set(body.analysis.evidence.map((e) => e.id));
    let claimCounter = 1;
    const normalized: ReportDraft = {
      title: draft.title,
      report_type: draft.report_type,
      warnings: draft.warnings,
      sections: draft.sections.map((section: any) => ({
        heading: section.heading,
        paragraphs: section.paragraphs.map((paragraph: any) => ({
          text: paragraph.text,
          claims: paragraph.claims.map((claim: any) => ({
            id: `CL${String(claimCounter++).padStart(3, "0")}`,
            text: claim.text,
            type: claim.type,
            evidence_ids: claim.evidence_ids.filter((id: string) => validEvidenceIds.has(id)),
            citation_required: claim.citation_required,
            search_concepts: claim.search_concepts,
            confidence: claim.confidence,
          })),
        })),
      })),
    };

    return NextResponse.json(normalized);
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "보고서 개선 중 오류가 발생했습니다." },
      { status: 500 },
    );
  }
}
