# Analysis Depth patch

- 빠른 분석: 기존 Balanced Full Coverage를 그대로 기본값으로 사용합니다. 목표 AI context 약 360k chars, 일반적으로 2~3 batch입니다.
- 정밀 분석: Full Coverage Scan은 동일하게 유지하면서 대형 LOG/CSV/CODE의 블록 수와 RAW_EVIDENCE 보존량을 늘리고 목표 AI context를 약 680k chars로 확장합니다. 일반적으로 4~5 batch입니다.
- 두 모드 모두 동시 2개 분석과 429 retry를 유지합니다.
- 정밀 분석은 chunk별 Evidence/방법/실험/Finding 출력 한도도 확대합니다.
- 최종 Research Overview에서 batch/chunk/coverage 같은 내부 파이프라인 용어가 연구 내용으로 새어나오지 않도록 merger 지침을 보강했습니다.
