# PDF / TXT direct export update

- Removed the ZIP/JSON artifact export from the header utility.
- `산출물 다운로드` now opens a small format menu:
  - PDF: formatted A4-style export generated in the browser.
  - TXT: complete human-readable text export.
- The export includes only the outputs available at the current stage:
  - selected source list
  - Research Overview / Findings / Evidence Map
  - grounded existing-report claim/evidence result
  - generated or improved report
  - literature candidates with URLs
- JSON files are no longer exposed as user downloads.
- PDF is generated client-side with `html2pdf.js` so Korean browser fonts are rendered into the PDF without exposing API keys.

After applying the patch, run:

```powershell
npm install
Remove-Item -Recurse -Force .next -ErrorAction SilentlyContinue
npm run build
```
