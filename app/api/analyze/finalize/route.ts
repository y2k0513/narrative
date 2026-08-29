import { NextResponse } from "next/server";
import { createStructuredResponse } from "@/lib/openai";
import { researchFinalizeSchema } from "@/lib/schemas";
import type { ResearchFinalizeResult } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 90;

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      chunks?: unknown[];
      maxConcepts?: number;
      analysisDepth?: "fast" | "precise";
    };
    const chunks = Array.isArray(body.chunks) ? body.chunks : [];
    const precise = body.analysisDepth === "precise";
    if (!chunks.length) {
      return NextResponse.json({ error: "통합할 chunk 분석 결과가 없습니다." }, { status: 400 });
    }

    const compact = JSON.stringify(chunks);
    if (compact.length > 2_500_000) {
      return NextResponse.json(
        { error: "통합 요약이 너무 큽니다. 분석 대상 파일 수를 줄이거나 불필요한 로그를 제외해 주세요." },
        { status: 413 },
      );
    }

    const maxConcepts = Math.min(40, Math.max(5, Number(body.maxConcepts || process.env.MAX_RESEARCH_CONCEPTS || 30)));
    const parserModel = process.env.OPENAI_PARSER_MODEL || "gpt-5.6-luna";

    const result = await createStructuredResponse<ResearchFinalizeResult>({
      model: parserModel,
      schemaName: "research_finalize",
      schema: researchFinalizeSchema as unknown as Record<string, unknown>,
      reasoningEffort: "low",
      maxOutputTokens: precise ? 17000 : 14000,
      instructions: `
당신은 Research2Report의 Research Merger다.
여러 연구자료 chunk 분석 결과를 하나의 Research Overview로 통합한다.

규칙:
1. 새로운 사실, 수치, 실험을 만들지 않는다. 입력 chunk에 있는 정보만 통합한다.
2. 같은 방법/실험이 여러 chunk에 반복되면 하나로 병합한다.
3. 실험 이름이 달라도 parameter/metric/source 맥락이 같으면 중복 가능성을 고려한다. 확신이 없으면 별도 실험으로 유지한다.
4. 수치가 충돌하면 임의로 하나를 고르지 말고 warnings에 기록한다.
5. source_refs와 metric의 source_id/source_location은 입력 값을 유지한다.
6. Research Concept은 동의어를 aliases로 통합하고 문헌 검색 가치와 연구 중요도를 기준으로 정렬한다.
7. Concept은 최대 ${maxConcepts}개를 반환한다.
8. search_query는 OpenAlex에서 사용할 짧은 영어 검색어로 만든다.
9. summary는 전체 연구 흐름을 이해할 수 있게 작성하되 과장하지 않는다.
10. batch, chunk, coverage, digest, AI 분석, 압축률 등 Research2Report 내부 처리 구조를 연구 내용처럼 서술하지 않는다. "세 배치는", "이 chunk는" 같은 표현은 금지한다.
11. 서로 다른 모델·전처리·threshold·평가 단위의 결과를 비교할 때는 조건 차이를 명시하고, 직접적인 우열로 단정하지 않는다.
12. ${precise ? "정밀 분석에서는 모델 구조, 전처리, 실험 조건, threshold, aggregate/환자 수준 성능, 예외·실패 케이스를 가능한 한 구분해 더 상세히 통합한다." : "빠른 분석에서는 핵심 실험 흐름과 가장 중요한 결과를 우선해 간결하게 통합한다."}
`,
      input: JSON.stringify({ chunks, maxConcepts }, null, 2),
    });

    return NextResponse.json({
      ...result,
      concepts: result.concepts.slice(0, maxConcepts).sort((a, b) => b.importance - a.importance),
    });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "연구자료 통합 중 오류가 발생했습니다." },
      { status: 500 },
    );
  }
}
