import { NextResponse } from "next/server";
import { parseReportFile } from "@/lib/file-parser";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "보고서 파일이 필요합니다." }, { status: 400 });
    }

    if (file.size > 25 * 1024 * 1024) {
      return NextResponse.json({ error: "보고서 파일은 최대 25MB까지 지원합니다." }, { status: 400 });
    }

    const text = await parseReportFile(file);
    if (!text) {
      return NextResponse.json({ error: "보고서에서 읽을 수 있는 텍스트를 찾지 못했습니다." }, { status: 400 });
    }

    return NextResponse.json({ name: file.name, text: text.slice(0, 120_000) });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "보고서 파일 읽기 중 오류가 발생했습니다." },
      { status: 500 },
    );
  }
}
