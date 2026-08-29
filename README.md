# Research2Report MVP

연구자료를 구조화하고, 원본 Evidence가 연결된 연구보고서 초안을 생성하며, 핵심 Research Concept별 관련 논문을 OpenAlex에서 탐색하는 공모전용 MVP입니다.

## 핵심 파이프라인

```text
연구자료 업로드
  → GPT-5.6 Luna: Research Parser / Concept Extractor
  → Evidence JSON
  → GPT-5.6 Sol: 근거 기반 보고서 초안
  → Claim ↔ Evidence 확인
  → OpenAlex: Concept별 Top 5 논문 검색
  → 중복 제거 + 다중 Concept 매칭 기반 재정렬
```

### AI와 일반 코드의 역할

- 일반 코드: CSV/PDF 파싱, 파일 위치 보존, OpenAlex 검색, DOI/OpenAlex ID 중복 제거, ranking 계산
- GPT-5.6 Luna: 연구자료 의미 구조화, 연구 Concept 추출
- GPT-5.6 Sol: 최종 보고서 초안 작성
- 사람: 연구 해석, 근거 적절성, 인용 논문, 최종 문서 확인

---

# 1. 준비물

- Node.js 20 이상 권장
- Git
- OpenAI API key
- OpenAlex API key (가벼운 테스트는 없어도 동작하지만 무료 key 발급 권장)
- GitHub 계정 (배포할 경우)
- Vercel 계정 (배포할 경우)

현재 OpenAI 모델 기본값:

```env
OPENAI_PARSER_MODEL=gpt-5.6-luna
OPENAI_REPORT_MODEL=gpt-5.6-sol
```

---

# 2. 로컬 실행

## 2-1. 압축을 푼 뒤 프로젝트 폴더로 이동

PowerShell:

```powershell
cd C:\원하는\경로\research2report-mvp
```

macOS/Linux:

```bash
cd /path/to/research2report-mvp
```

## 2-2. 패키지 설치

```bash
npm install
```

## 2-3. 환경변수 파일 생성

`.env.example`을 복사해서 `.env.local`을 만듭니다.

PowerShell:

```powershell
Copy-Item .env.example .env.local
```

macOS/Linux:

```bash
cp .env.example .env.local
```

`.env.local`을 열어 다음 값을 입력합니다.

```env
OPENAI_API_KEY=sk-실제키
OPENAI_PARSER_MODEL=gpt-5.6-luna
OPENAI_REPORT_MODEL=gpt-5.6-sol
OPENALEX_API_KEY=발급받은키_또는_빈칸
MAX_RESEARCH_CONCEPTS=30
PAPERS_PER_CONCEPT=5
```

주의: `.env.local`은 절대 GitHub에 커밋하지 마세요. `.gitignore`에 이미 포함되어 있습니다.

## 2-4. 개발 서버 실행

```bash
npm run dev
```

브라우저에서:

```text
http://localhost:3000
```

접속합니다.

---

# 3. 바로 테스트하는 법

`sample/` 폴더에 테스트용 연구자료가 있습니다.

```text
sample/results.csv
sample/config.json
sample/research_note.txt
```

웹에서 이 세 파일을 동시에 선택하고 `연구자료 분석`을 누릅니다.

정상 동작 순서:

1. Research Overview 생성
2. Experiments / Evidence / Concepts 개수 표시
3. `보고서 초안 생성 (Sol)` 클릭
4. 보고서 문단 아래 Claim 배지 클릭
5. 오른쪽 Evidence 패널에 원본 파일과 위치 표시
6. `관련 논문 찾기 (30×5)` 클릭
7. 최대 150 search slots를 검색하고 중복 제거한 Literature Pool 표시

---

# 4. Git 저장소로 만들기

프로젝트 폴더에서:

```bash
git init
git add .
git commit -m "Initial Research2Report MVP"
git branch -M main
```

GitHub에서 빈 repository `research2report`를 만든 뒤:

```bash
git remote add origin https://github.com/YOUR_USERNAME/research2report.git
git push -u origin main
```

GitHub CLI를 사용한다면 한 번에 할 수도 있습니다.

```bash
gh repo create research2report --public --source=. --remote=origin --push
```

---

# 5. Vercel 배포

1. https://vercel.com 에 로그인
2. `Add New → Project`
3. GitHub의 `research2report` repository Import
4. Framework는 Next.js 자동 감지
5. Environment Variables에 다음 값을 등록

```text
OPENAI_API_KEY
OPENAI_PARSER_MODEL = gpt-5.6-luna
OPENAI_REPORT_MODEL = gpt-5.6-sol
OPENALEX_API_KEY
MAX_RESEARCH_CONCEPTS = 30
PAPERS_PER_CONCEPT = 5
```

6. Deploy
7. 생성된 `https://xxxx.vercel.app` 링크를 공모전 최종 결과물 링크로 사용

API key는 Next.js의 서버 Route Handler에서만 사용되므로 브라우저 JavaScript에 노출시키지 않습니다.

---

# 6. API Route 구조

## POST `/api/analyze`

입력: multipart form-data의 연구파일들

처리:

- CSV/TXT/JSON/YAML/PDF 파싱
- 파일별 source ID와 row/page/line 위치 유지
- GPT-5.6 Luna가 Experiment / Evidence / Finding / Research Concept 구조화

출력: `ResearchAnalysis` JSON

## POST `/api/report`

입력:

```json
{
  "analysis": "ResearchAnalysis",
  "reportType": "연구 결과보고서"
}
```

처리:

- GPT-5.6 Sol이 Evidence Catalog만 사용해 보고서 초안 작성
- 주요 Claim마다 evidence ID 또는 citation 필요 여부 부여

출력: `ReportDraft` JSON

## POST `/api/papers`

입력:

```json
{
  "analysis": "ResearchAnalysis",
  "conceptLimit": 30,
  "perConcept": 5
}
```

처리:

- 중요도 상위 Concept 최대 30개
- Concept별 OpenAlex Top 5 검색
- 최대 150 raw hits
- DOI → OpenAlex ID → 제목 순으로 중복 제거
- 여러 Concept에 반복 등장한 논문을 우대해 최종 관련도 순 정렬

---

# 7. 현재 논문 Ranking 방식

MVP에서는 별도의 LLM reranking 호출을 사용하지 않습니다.

```text
Final Score
= Concept Coverage 55%
+ Concept 내 검색 Rank Quality 35%
+ Citation Boost 10%
```

여러 중요 Concept에서 동시에 검색된 논문이 위로 올라오도록 설계했습니다.

이 점수는 논문의 학술적 품질 점수가 아니라 **현재 연구 프로젝트 내부의 Retrieval 우선순위**입니다.

추후 정확도를 높일 경우 상위 20~30편만 별도의 reranker 또는 embedding으로 재평가할 수 있습니다.

---

# 8. 왜 Sol은 보고서에만 쓰는가

비용과 역할 분리를 위해:

- 자료 구조화/Concept 추출: `gpt-5.6-luna`
- 최종 자연어 보고서: `gpt-5.6-sol`
- 논문 검색: OpenAlex
- 논문 기본 재정렬: 일반 코드

로 구성했습니다.

즉 비싼 모델을 150편 논문 전체 정렬에 사용하지 않습니다.

---

# 9. MVP의 중요한 제한

1. AI가 생성한 보고서는 **초안**입니다.
2. 외부 논문 후보가 실제 문장을 완전히 뒷받침하는지는 연구자가 확인해야 합니다.
3. OpenAlex는 모든 학술논문을 100% 포함하는 데이터베이스가 아닙니다.
4. 현재 PDF는 최대 40페이지까지 텍스트를 읽습니다.
5. 매우 큰 연구자료는 비용/컨텍스트 관리를 위해 후반부가 잘릴 수 있으며 UI의 warning에 표시됩니다.
6. 현재 파일을 별도 DB에 영구 저장하지 않습니다. 새로고침하면 분석 상태가 사라지는 MVP 구조입니다.

---

# 10. 다음 구현 우선순위

Core MVP가 정상 동작한 후 아래 순서로 확장하는 것을 권장합니다.

1. Claim별 Literature Pool 자동 필터링
2. 선택 논문의 abstract를 Sol에 전달하여 인용 기반 문장 보완
3. DOCX/PPTX 지원
4. 보고서 `.docx` 내보내기
5. 프로젝트 저장 기능
6. Evidence Coverage / Unsupported Claim Health Check

먼저 `파일 → Evidence → Report → Evidence 클릭`의 세로 흐름이 정확하게 돌아가는지 검증하세요. 외부 기능을 늘리는 것보다 이 핵심이 공모전 차별점입니다.
