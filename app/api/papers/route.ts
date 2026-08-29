import { NextResponse } from "next/server";
import { retrievePapers } from "@/lib/openalex";
import type { ResearchAnalysis } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      analysis?: ResearchAnalysis;
      conceptLimit?: number;
      perConcept?: number;
    };
    if (!body.analysis) return NextResponse.json({ error: "analysis가 필요합니다." }, { status: 400 });

    const envConceptLimit = Number(process.env.MAX_RESEARCH_CONCEPTS || 30);
    const envPerConcept = Number(process.env.PAPERS_PER_CONCEPT || 5);
    const conceptLimit = Math.max(1, Math.min(body.conceptLimit || envConceptLimit, 30));
    const perConcept = Math.max(1, Math.min(body.perConcept || envPerConcept, 10));

    const papers = await retrievePapers(body.analysis, conceptLimit, perConcept);
    return NextResponse.json({
      raw_slots: conceptLimit * perConcept,
      unique_papers: papers.length,
      papers,
    });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "논문 검색 중 오류가 발생했습니다." },
      { status: 500 },
    );
  }
}
