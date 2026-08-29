import { NextResponse } from "next/server";
import { createStructuredResponse } from "@/lib/openai";
import { researchChunkSchema } from "@/lib/schemas";
import type { ResearchChunkAnalysis } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 90;

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { batchId?: string; text?: string };
    const batchId = String(body.batchId || "batch");
    const text = String(body.text || "");

    if (!text.trim()) {
      return NextResponse.json({ error: "분석할 텍스트가 없습니다." }, { status: 400 });
    }
    if (text.length > 120_000) {
      return NextResponse.json({ error: "분석 배치가 너무 큽니다. 브라우저에서 더 작게 분할해 주세요." }, { status: 413 });
    }

    const parserModel = process.env.OPENAI_PARSER_MODEL || "gpt-5.6-luna";
    const result = await createStructuredResponse<ResearchChunkAnalysis>({
      model: parserModel,
      schemaName: "research_chunk_analysis",
      schema: researchChunkSchema as unknown as Record<string, unknown>,
      reasoningEffort: "low",
      maxOutputTokens: 4500,
      instructions: `
당신은 Research2Report의 Chunk Research Parser다.
브라우저에서 미리 텍스트로 변환된 연구자료 일부를 분석한다. 보고서를 쓰지 말고, 이 배치에서 실제로 확인 가능한 연구 사실만 구조화한다.

엄격한 규칙:
1. SOURCE 헤더와 본문에 실제로 존재하는 정보만 사용한다.
2. 숫자, metric, parameter는 원문 값을 바꾸거나 추정하지 않는다.
3. SOURCE 헤더 끝의 RAW_EVIDENCE / COVERAGE_DIGEST 표시를 구분한다.
4. RAW_EVIDENCE는 실제 원문이므로 Evidence의 직접 근거로 사용할 수 있다. source_id와 source_location은 SOURCE 헤더 값을 정확히 복사하고 evidence.raw_quote에는 해당 RAW_EVIDENCE의 짧은 원문을 넣는다.
5. COVERAGE_DIGEST는 브라우저가 해당 line/row 블록 전체를 전수 스캔해 만든 결정론적 구조/통계 요약이다. 전체 연구 맥락, 방법, 실험 흐름, 누락 탐지에는 활용하되 COVERAGE_DIGEST 자체를 raw_quote나 직접 Evidence로 인용하지 않는다.
6. 실행 결과와 성능은 CSV/로그/결과 문서의 RAW_EVIDENCE 등 실행 근거가 있을 때만 사실 Evidence로 추출한다.
7. 코드 파일은 구현 방식/파라미터/알고리즘 구조의 근거가 될 수 있지만, 실행 여부나 성능의 근거로 사용하지 않는다.
8. observed finding은 직접 확인되는 패턴, inferred finding은 해석으로 구분한다.
9. temp_id는 이 배치 안에서 T001, T002처럼 유일하게 만든다.
10. 문헌 검색에 유용한 Research Concept만 추출한다. 일반 단어는 제외한다.
11. 같은 사실을 중복 Evidence로 과도하게 만들지 않는다. 이 배치에서 보고서 검증에 유용한 핵심 Evidence를 우선하며 대략 40개 이하를 목표로 한다.
12. 방법은 대략 12개, 실험은 20개, Finding은 15개, Concept은 15개 이하를 우선한다.
13. 자료가 불완전하거나 서로 충돌하면 warnings에 기록한다.
14. chunk_summary는 RAW_EVIDENCE와 COVERAGE_DIGEST를 함께 이용해 이 배치가 전체 연구에서 어떤 내용을 담는지 3~8문장으로 압축한다.
`,
      input: `[BATCH ${batchId}]\n${text}`,
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error(error);
    const err = error as { status?: number; headers?: Headers | Record<string, string>; message?: string };
    const status = err?.status === 429 ? 429 : 500;
    const headers = new Headers();
    if (status === 429) {
      const sourceHeaders = err?.headers;
      let retryAfter: string | null = null;
      if (sourceHeaders instanceof Headers) retryAfter = sourceHeaders.get("retry-after");
      else if (sourceHeaders && typeof sourceHeaders === "object") {
        retryAfter = sourceHeaders["retry-after"] || sourceHeaders["Retry-After"] || null;
      }
      if (retryAfter) headers.set("Retry-After", retryAfter);
    }
    return NextResponse.json(
      { error: err?.message || "연구자료 배치 분석 중 오류가 발생했습니다." },
      { status, headers },
    );
  }
}
