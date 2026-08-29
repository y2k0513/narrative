import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    { error: "이 버전은 대용량 파일을 서버에 직접 업로드하지 않습니다. 브라우저 전처리 + /api/analyze/chunk를 사용하세요." },
    { status: 410 },
  );
}
