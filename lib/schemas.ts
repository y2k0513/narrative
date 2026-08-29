export const researchAnalysisSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    research_topic: { type: "string" },
    research_topic_en: { type: "string" },
    objective: { type: "string" },
    summary: { type: "string" },
    methods: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          source_refs: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                source_id: { type: "string" },
                location: { type: "string" }
              },
              required: ["source_id", "location"]
            }
          }
        },
        required: ["name", "description", "source_refs"]
      }
    },
    experiments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          experiment_id: { type: "string" },
          name: { type: "string" },
          objective: { type: "string" },
          parameters: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                name: { type: "string" },
                value: { type: "string" }
              },
              required: ["name", "value"]
            }
          },
          metrics: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                name: { type: "string" },
                value: { type: "string" },
                unit: { type: "string" },
                source_id: { type: "string" },
                source_location: { type: "string" }
              },
              required: ["name", "value", "unit", "source_id", "source_location"]
            }
          },
          source_refs: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                source_id: { type: "string" },
                location: { type: "string" }
              },
              required: ["source_id", "location"]
            }
          }
        },
        required: ["experiment_id", "name", "objective", "parameters", "metrics", "source_refs"]
      }
    },
    evidence: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          temp_id: { type: "string" },
          type: { type: "string", enum: ["metric", "method", "config", "observation", "note", "other"] },
          content: { type: "string" },
          experiment_id: { type: ["string", "null"] },
          source_id: { type: "string" },
          source_location: { type: "string" },
          raw_quote: { type: "string" }
        },
        required: ["temp_id", "type", "content", "experiment_id", "source_id", "source_location", "raw_quote"]
      }
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string" },
          kind: { type: "string", enum: ["observed", "inferred"] },
          evidence_temp_ids: { type: "array", items: { type: "string" } }
        },
        required: ["text", "kind", "evidence_temp_ids"]
      }
    },
    concepts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name_en: { type: "string" },
          name_ko: { type: "string" },
          importance: { type: "number", minimum: 0, maximum: 1 },
          reason: { type: "string" },
          search_query: { type: "string" },
          aliases: { type: "array", items: { type: "string" } }
        },
        required: ["name_en", "name_ko", "importance", "reason", "search_query", "aliases"]
      }
    },
    warnings: { type: "array", items: { type: "string" } }
  },
  required: [
    "research_topic",
    "research_topic_en",
    "objective",
    "summary",
    "methods",
    "experiments",
    "evidence",
    "findings",
    "concepts",
    "warnings"
  ]
} as const;

export const reportDraftSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    report_type: { type: "string" },
    sections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          heading: { type: "string" },
          paragraphs: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                text: { type: "string" },
                claims: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      claim_id: { type: "string" },
                      text: { type: "string" },
                      type: {
                        type: "string",
                        enum: ["internal_fact", "external_claim", "interpretation", "narrative", "unsupported"]
                      },
                      evidence_ids: { type: "array", items: { type: "string" } },
                      citation_required: { type: "boolean" },
                      search_concepts: { type: "array", items: { type: "string" } },
                      confidence: { type: "number", minimum: 0, maximum: 1 }
                    },
                    required: [
                      "claim_id",
                      "text",
                      "type",
                      "evidence_ids",
                      "citation_required",
                      "search_concepts",
                      "confidence"
                    ]
                  }
                }
              },
              required: ["text", "claims"]
            }
          }
        },
        required: ["heading", "paragraphs"]
      }
    },
    warnings: { type: "array", items: { type: "string" } }
  },
  required: ["title", "report_type", "sections", "warnings"]
} as const;

export const reportGroundingSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    annotations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          paragraph_id: { type: "string" },
          claims: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                claim_id: { type: "string" },
                text: { type: "string" },
                type: {
                  type: "string",
                  enum: ["internal_fact", "external_claim", "interpretation", "narrative", "unsupported"]
                },
                evidence_ids: { type: "array", items: { type: "string" } },
                citation_required: { type: "boolean" },
                search_concepts: { type: "array", items: { type: "string" } },
                confidence: { type: "number", minimum: 0, maximum: 1 }
              },
              required: [
                "claim_id",
                "text",
                "type",
                "evidence_ids",
                "citation_required",
                "search_concepts",
                "confidence"
              ]
            }
          }
        },
        required: ["paragraph_id", "claims"]
      }
    },
    warnings: { type: "array", items: { type: "string" } }
  },
  required: ["title", "annotations", "warnings"]
} as const;
