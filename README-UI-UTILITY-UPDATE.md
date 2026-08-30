# Research2Report UI / Utility Update

## 변경사항
- 헤더 우측 작성자 `24100017 신현종` 표시
- 업로드 안내 문구 간소화
  - 파일: PDF / CSV / JSON/YAML / LOG / TXT/MD / ZIP / 주요 코드, ZIP 80MB 이하
  - 폴더: 지원 형식 자동 선별, 개별 파일 40MB 이하
- 상단 `사용법` 버튼 추가
  - 자료 입력 → Evidence 분석 → 보고서 작업 → 문헌/다운로드 흐름을 접이식 패널로 안내
- 상단 `산출물 다운로드` 버튼 추가
  - 현재 생성된 산출물을 ZIP으로 브라우저에서 즉시 내보냄
  - 가능한 경우 Research Overview, Evidence CSV, 분석 JSON, 기존 보고서 원문, Claim-Evidence 연결 결과, 생성/개선 보고서, 문헌 후보 CSV/JSON 포함
- 분석 깊이 안내 문구에서 내부 배치 수 표현 제거
- Footer 간소화

## 적용
패치 ZIP을 프로젝트 루트에 덮어쓴 뒤:

```powershell
Remove-Item -Recurse -Force .next -ErrorAction SilentlyContinue
npm install
npm run build
```

## 참고
산출물 다운로드는 기존 `jszip` dependency를 사용하므로 별도 패키지 추가가 필요하지 않습니다.
