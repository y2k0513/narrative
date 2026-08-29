export function splitReportParagraphs(text: string) {
  return text
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n+/)
    .map((block) => block.trim())
    .filter(Boolean)
    .slice(0, 220)
    .map((block, index) => ({
      id: `P${String(index + 1).padStart(3, "0")}`,
      text: block,
    }));
}
