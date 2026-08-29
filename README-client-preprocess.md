# Research2Report — Client Preprocess / Chunked Analysis

공모전용 Evidence-first MVP입니다.

핵심 흐름:

1. 연구자료 파일/폴더를 브라우저에서 선택
2. `.pt/.pth/.ckpt`, 데이터셋, 빌드 폴더 등은 제외
3. CSV/JSON/YAML/TXT/LOG/코드/PDF를 **브라우저에서 텍스트 + source location**으로 변환
4. 원본 파일을 Vercel Function에 업로드하지 않고 약 220k chars 단위의 작은 JSON 배치로 `/api/analyze/chunk` 호출
5. 배치별 Evidence 추출 후 `/api/analyze/finalize`에서 Research Overview 통합
6. 기존 보고서가 있으면 원문 Claim ↔ Evidence 연결
7. 필요할 때만 근거 기반 개선본 생성
8. 보고서가 없으면 Evidence 기반 새 보고서 생성
9. Research Concept 기반 OpenAlex 논문 검색

## 왜 구조를 바꿨나

Vercel Function request body에는 크기 제한이 있으므로 대형 원본 파일을 `/api/analyze`로 직접 보내지 않습니다.

현재 버전은:

```text
Large local project folder
        ↓
Browser-side filtering / parsing
        ↓
text + file path + row/page/line
        ↓
small analysis batches
        ↓
Vercel API / OpenAI
```

형태입니다.

따라서 프로젝트 폴더 자체가 매우 커도 모델 가중치/데이터셋 등의 바이너리를 서버로 전송하지 않습니다.

## 지원 연구자료

- Data/notes: `.csv .txt .md .log .json .yaml .yml`
- PDF: `.pdf` (브라우저 PDF.js parsing)
- Notebook: `.ipynb`
- Code: Python, JS/TS, C/C++, CUDA, Java, C#, Go, Rust, Kotlin, Swift, Scala, R, shell, SQL, HTML/CSS, Vue/Svelte, TOML/INI/CFG, Proto, TeX, URDF/Xacro/SDF/USDA 등
- ZIP: 80MB 이하의 작은 ZIP. 큰 프로젝트는 **프로젝트 폴더 추가** 권장

자동 제외 예:

- `.pt .pth .ckpt .onnx .npy .npz .h5 .safetensors` 등 지원하지 않는 바이너리
- `node_modules`, `.git`, `.next`, `venv`, `build`, `dist`, `checkpoints`, `weights`, `wandb`, `runs` 등

## 기존 보고서

브라우저에서 다음 형식을 텍스트로 변환합니다.

- TXT
- MD
- PDF
- DOCX

PDF/보고서 원본도 Vercel에 파일 그대로 업로드하지 않습니다.

## 실행

```bash
npm install
cp .env.example .env.local   # macOS/Linux
# Windows PowerShell: Copy-Item .env.example .env.local
npm run dev
```

브라우저:

```text
http://localhost:3000
```

## 환경변수

```env
OPENAI_API_KEY=...
OPENAI_PARSER_MODEL=gpt-5.6-luna
OPENAI_REPORT_MODEL=gpt-5.6-sol
OPENALEX_API_KEY=...
MAX_RESEARCH_CONCEPTS=30
PAPERS_PER_CONCEPT=5
```

## Vercel

GitHub push 후 Vercel 프로젝트에 위 환경변수를 동일하게 등록합니다.

```bash
git add .
git commit -m "Use client preprocessing and chunked analysis"
git push
```

이후 Vercel이 자동 재배포합니다.

## 현재 보호장치

- 선택 파일 최대 150개
- 폴더에서 개별 분석 파일 40MB 초과 시 제외
- ZIP 80MB 이하
- 분석 배치 약 220k chars
- 최대 30 AI analysis batches
- CSV 최대 5,000 rows
- PDF 최대 80 pages
- Notebook 최대 500 cells

이 제한은 Vercel payload 제한이 아니라 공모전 MVP의 비용/시간/브라우저 메모리 보호를 위한 앱 자체 제한입니다.
