export type SourceRef = {
  source_id: string;
  location: string;
};

export type Evidence = {
  id: string;
  type: "metric" | "method" | "config" | "observation" | "note" | "other";
  content: string;
  experiment_id: string | null;
  source_id: string;
  source_name: string;
  source_location: string;
  raw_quote: string;
};

export type ResearchConcept = {
  name_en: string;
  name_ko: string;
  importance: number;
  reason: string;
  search_query: string;
  aliases: string[];
};

export type ResearchCoverage = {
  selected_files: number;
  expanded_files: number;
  parsed_sources: number;
  ignored_files: number;
  text_lines_scanned: number;
  log_lines_scanned: number;
  code_lines_scanned: number;
  csv_rows_scanned: number;
  pdf_pages_scanned: number;
  notebook_cells_scanned: number;
  coverage_blocks: number;
  raw_evidence_segments: number;
  input_chars: number;
  analysis_chars: number;
  compression_percent: number;
  ai_batches: number;
};

export type ResearchAnalysis = {
  research_topic: string;
  research_topic_en: string;
  objective: string;
  summary: string;
  methods: Array<{
    name: string;
    description: string;
    source_refs: SourceRef[];
  }>;
  experiments: Array<{
    experiment_id: string;
    name: string;
    objective: string;
    parameters: Array<{ name: string; value: string }>;
    metrics: Array<{
      name: string;
      value: string;
      unit: string;
      source_id: string;
      source_location: string;
    }>;
    source_refs: SourceRef[];
  }>;
  evidence: Evidence[];
  findings: Array<{
    text: string;
    kind: "observed" | "inferred";
    evidence_ids: string[];
  }>;
  concepts: ResearchConcept[];
  source_files: Array<{
    source_id: string;
    name: string;
    type: string;
    segment_count: number;
  }>;
  warnings: string[];
  coverage?: ResearchCoverage;
};

export type ReportClaim = {
  id: string;
  text: string;
  type: "internal_fact" | "external_claim" | "interpretation" | "narrative" | "unsupported";
  evidence_ids: string[];
  citation_required: boolean;
  search_concepts: string[];
  confidence: number;
};

export type ReportDraft = {
  title: string;
  report_type: string;
  sections: Array<{
    heading: string;
    paragraphs: Array<{
      text: string;
      claims: ReportClaim[];
    }>;
  }>;
  warnings: string[];
};

export type GroundedParagraph = {
  id: string;
  text: string;
  claims: ReportClaim[];
};

export type GroundedReport = {
  title: string;
  source_name: string;
  original_text: string;
  paragraphs: GroundedParagraph[];
  warnings: string[];
  stats: {
    total_claims: number;
    internally_supported: number;
    citation_needed: number;
    unsupported: number;
  };
};

export type PaperResult = {
  id: string;
  title: string;
  year: number | null;
  authors: string[];
  doi: string | null;
  url: string;
  venue: string | null;
  cited_by_count: number;
  abstract: string | null;
  matched_concepts: Array<{
    name: string;
    importance: number;
    rank: number;
  }>;
  final_score: number;
};

export type ParsedSegment = {
  location: string;
  text: string;
  kind?: "raw" | "coverage_digest";
};

export type ParsedSource = {
  source_id: string;
  name: string;
  type: string;
  segments: ParsedSegment[];
};

export type ResearchChunkAnalysis = {
  chunk_summary: string;
  methods: ResearchAnalysis["methods"];
  experiments: ResearchAnalysis["experiments"];
  evidence: Array<{
    temp_id: string;
    type: Evidence["type"];
    content: string;
    experiment_id: string | null;
    source_id: string;
    source_location: string;
    raw_quote: string;
  }>;
  findings: Array<{
    text: string;
    kind: "observed" | "inferred";
    evidence_temp_ids: string[];
  }>;
  concepts: ResearchConcept[];
  warnings: string[];
};

export type ResearchFinalizeResult = Pick<
  ResearchAnalysis,
  "research_topic" | "research_topic_en" | "objective" | "summary" | "methods" | "experiments" | "concepts" | "warnings"
>;
