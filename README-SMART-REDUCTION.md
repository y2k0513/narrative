# Research2Report — Smart Reduction + Parallel Analysis Patch

기존 `research2report-client-preprocess-large-project` 버전에 덮어쓰는 패치입니다.

## 변경 사항

- AI 배치 분석을 순차 처리에서 **동시 4개 병렬 처리**로 변경
- 대형 `.log` 파일은 metric/result/error/config 중심의 중요 라인 + 앞/뒤/주기 샘플만 유지
- 대형 `.csv`는 첫/마지막/주기 샘플 + 중요 metric/result 행 + metric extrema 행을 유지
- 대형 코드 파일은 import, class/function 정의, 연구 설정값, train/eval/inference 관련 구간 중심으로 유지
- 원래 `source_id`, 파일 경로, `line/row/page` provenance는 유지
- UI에 Smart Reduction 적용 파일 수와 문자 감소율 표시
- 최종 warnings에 Smart Reduction이 적용됐음을 명시

## 적용

프로젝트 루트에 이 패치 내용을 덮어쓴 뒤:

```powershell
Remove-Item -Recurse -Force .next -ErrorAction SilentlyContinue
npm run build
```

성공하면:

```powershell
git add .
git commit -m "Add smart reduction and parallel analysis"
git push
```

## 참고

병렬도는 `app/page.tsx`의 `ANALYSIS_CONCURRENCY = 4`입니다. 너무 높이면 OpenAI API rate limit에 걸릴 수 있으므로 기본값 4를 권장합니다.
