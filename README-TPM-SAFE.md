# Research2Report — TPM-safe Full Coverage patch

This patch keeps browser-side full-coverage scanning, but fixes the slow/rate-limited AI stage.

Changes:
- Full-coverage compression threshold: 140k chars -> 28k chars for machine-readable files.
- Fewer/larger deterministic coverage blocks for LOG/CODE/CSV, while every line/row is still scanned.
- Large JSON/YAML also use full-coverage compression.
- AI chunk size: 220k -> 100k chars.
- Parser max output: 14k -> 4.5k tokens.
- Parallel chunk workers: 4 -> 2.
- HTTP 429 is propagated and automatically retried using Retry-After / exponential backoff.

Apply these files over the project root, then run:

```powershell
Remove-Item -Recurse -Force .next -ErrorAction SilentlyContinue
npm run build
```
