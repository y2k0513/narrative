import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    { error: "기존 보고서 파일은 이제 브라우저에서 직접 텍스트로 변환합니다." },
    { status: 410 },
  );
}
