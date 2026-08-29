# Research2Report — Balanced Full Coverage

This patch keeps the browser-side full-coverage scan but reduces the number of OpenAI parser calls toward 2–3 for large research projects.

## What changed

- Every supported row/line/page is still scanned in the browser.
- Large LOG/CODE/CSV files use fewer, larger deterministic coverage regions.
- Each region keeps compact statistics/structure plus a smaller set of exact RAW_EVIDENCE excerpts.
- Analysis batch size is adaptive (110k–150k chars) with a target of about 3 parser batches.
- Parser concurrency stays at 2 to remain safer under a 200k TPM limit.
- Final merge reasoning is reduced from medium to low for faster completion.
- 429 retry and structured JSON safeguards from the previous version are preserved.

## Important distinction

`FULL_SCAN` / `COVERAGE_DIGEST` proves that the region was scanned and provides deterministic context. It is not directly citable. `RAW_EVIDENCE` is the exact source excerpt used for claim-level evidence.

## Apply

Overwrite the project files with the patch, then run:

```powershell
Remove-Item -Recurse -Force .next -ErrorAction SilentlyContinue
npm run build
```

Then deploy:

```powershell
git add .
git commit -m "Balance full coverage for 2-3 AI batches"
git push
```
