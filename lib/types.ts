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
