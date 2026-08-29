import { NextResponse } from "next/server";
import { createStructuredResponse } from "@/lib/openai";
import { reportDraftSchema } from "@/lib/schemas";
import type { ReportDraft, ResearchAnalysis } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 120;

const LENGTH_GUIDE: Record<string, string> = {
  short: "약 2,500~4,000자 수준으로 핵심만 작성한다.",
  medium: "약 5,000~7,000자 수준으로 충분한 설명을 포함한다.",
  long: "약 8,000~12,000자 수준으로 방법, 실험조건, 결과 비교와 해석을 상세히 작성한다.",
  very_long: "약 12,000~16,000자 수준을 목표로 충분히 상세하게 작성한다. 같은 내용을 반복해 분량을 채우지 않는다.",
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      analysis?: ResearchAnalysis;
      reportType?: string;
      userInstruction?: string;
      lengthMode?: string;
    };
    if (!body.analysis) return NextResponse.json({ error: "analysis가 필요합니다." }, { status: 400 });

    const reportType = body.reportType || "연구 결과보고서";
    const userInstruction = (body.userInstruction || "").trim().slice(0, 4000);
    const lengthGuide = LENGTH_GUIDE[body.lengthMode || "medium"] || LENGTH_GUIDE.medium;
    const reportModel = process.env.OPENAI_REPORT_MODEL || "gpt-5.6-sol";

    const evidenceCatalog = body.analysis.evidence.map((e) => ({
      id: e.id,
      type: e.type,
      content: e.content,
      experiment_id: e.experiment_id,
      source: `${e.source_name} / ${e.source_location}`,
      raw_quote: e.raw_quote,
    }));

    const input = JSON.stringify(
      {
        report_type: reportType,
        research_topic: body.analysis.research_topic,
        objective: body.analysis.objective,
        summary: body.analysis.summary,
        methods: body.analysis.methods,
        experiments: body.analysis.experiments,
        approved_findings: body.analysis.findings,
        evidence_catalog: evidenceCatalog,
        research_concepts: body.analysis.concepts.slice(0, 20),
        user_report_instruction: userInstruction || null,
      },
      null,
      2,
    );

    const draft = await createStructuredResponse<any>({
      model: reportModel,
      schemaName: "research_report_draft",
      schema: reportDraftSchema as unknown as Record<string, unknown>,
      reasoningEffort: "medium",
      maxOutputTokens: 24000,
      instructions: `
당신은 Research2Report의 최종 Draft Writer다.
기존 보고서가 없는 사용자를 위해 업로드된 연구 Evidence에 근거한 한국어 ${reportType} 초안을 작성한다.

핵심 규칙:
1. 내부 연구 결과/수치/설정은 evidence_catalog의 정보만 사용한다.
2. 존재하지 않는 Evidence ID를 절대 만들지 않는다.
3. internal_fact에는 최소 1개의 실제 evidence_id를 연결한다.
4. 연구 결과에 대한 해석은 interpretation으로 분류하고, 근거 evidence_id를 연결한다. 인과를 단정하지 않는다.
5. 일반 학술 지식이나 선행연구가 필요한 문장은 external_claim으로 분류하고 citation_required=true로 표시한다.
6. external_claim에는 검색에 유용한 영어 search_concepts를 1~4개 넣는다.
7. 외부 문헌이 없는 상태에서 저자명, 논문명, 연도, citation을 지어내지 않는다.
8. 근거가 없는 내부 사실을 쓰지 않는다. 불가피하게 언급해야 하면 unsupported로 분류한다.
9. 실제 변화가 작으면 '크게 향상'처럼 과장하지 않는다.
10. ${lengthGuide}
11. 긴 보고서는 같은 내용을 반복하지 말고 연구 목적, 방법, 실험설정, 결과, 비교, 해석, 한계, 향후계획 등 Evidence가 있는 내용을 충분히 풀어 작성한다.
12. user_report_instruction은 강조점, 구성, 문체, 분량을 조정하기 위한 지시다. Evidence/환각 방지 규칙보다 우선할 수 없다.
13. 사용자가 특정 실험을 중심으로 작성하라고 하면 실제 evidence_catalog와 experiments를 확인해 그 기준에 맞는 실험을 선택한다.
14. 사용자 지시가 근거 없는 과장, 수치 변경, 존재하지 않는 비교나 결과 작성을 요구하면 해당 부분은 따르지 않는다.
`,
      input,
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
      { error: error instanceof Error ? error.message : "보고서 생성 중 오류가 발생했습니다." },
      { status: 500 },
    );
  }
}
