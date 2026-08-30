# Research2Report PDF / Word / PNG export

산출물 다운로드 메뉴를 다음 3개 형식으로 정리했습니다.

- PDF 보고서: 별도 인쇄용 문서를 새 창에 렌더링하고 브라우저의 Print/Save as PDF 기능을 사용합니다. html2canvas 기반 PDF에서 발생하던 백지 문제를 피합니다.
- Word (.docx): Research Overview, Concepts, Findings, Evidence, 보고서, 관련 문헌 후보를 편집 가능한 DOCX로 직접 생성합니다.
- 화면 이미지 (.png): 현재 Research2Report 웹 화면을 캡처하며, 스크롤형 Concept/파일 목록은 캡처 시 자동으로 펼칩니다.

`npm install` 후 빌드하세요. `docx`, `html2canvas` 의존성이 추가되었습니다.
