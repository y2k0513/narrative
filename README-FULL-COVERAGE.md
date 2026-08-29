# Research2Report — Full Coverage Hierarchical Analysis

This version replaces keyword-first Smart Reduction with a full-coverage browser scan for large machine-readable research files.

## Pipeline

1. Browser parses every supported source file.
2. Human-written text/PDF/Markdown is preserved as raw text.
3. Large LOG files: every line is scanned. Each adaptive block produces deterministic counts/numeric statistics plus representative/high-signal raw excerpts.
4. Large CODE files: every line is scanned. Each block produces structure counts/definitions plus raw excerpts from every region and research-relevant implementation context.
5. CSV files: every parsed row is scanned. Global/block numeric statistics are computed, and representative/high-signal/extreme rows are retained as raw evidence.
6. `COVERAGE_DIGEST` segments are context only. The AI prompt explicitly forbids citing them as raw evidence.
7. `RAW_EVIDENCE` segments preserve file + row/line/page provenance and are used for claim evidence.
8. Compressed text is analyzed with 4 concurrent chunk workers, then hierarchically merged into the Research Overview.

## UI coverage audit

Research Overview now shows scanned source count, LOG/code/text lines, CSV rows, PDF pages, coverage blocks, compression percentage, and AI batch count.

## Safety limits

- Selected files: 150 (UI)
- Folder file: 40 MB (UI)
- Manual ZIP: 80 MB
- ZIP entries: 400
- ZIP inner file: 30 MB
- PDF pages: up to 500; larger PDFs emit a warning instead of silently claiming full coverage
- AI analysis batches: 100
- Parallel chunk requests: 4

Unsupported binaries/model weights remain excluded. Code can support implementation claims, not performance claims.
