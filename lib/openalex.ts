import type { ResearchAnalysis, ResearchConcept, PaperResult } from "./types";

type OpenAlexWork = {
  id: string;
  doi?: string | null;
  title?: string | null;
  publication_year?: number | null;
  cited_by_count?: number | null;
  relevance_score?: number | null;
  authorships?: Array<{ author?: { display_name?: string | null } }>;
  primary_location?: { source?: { display_name?: string | null } | null } | null;
  abstract_inverted_index?: Record<string, number[]> | null;
};

function reconstructAbstract(index?: Record<string, number[]> | null): string | null {
  if (!index) return null;
  let max = -1;
  for (const positions of Object.values(index)) {
    for (const pos of positions) max = Math.max(max, pos);
  }
  if (max < 0) return null;
  const words = new Array<string>(max + 1).fill("");
  for (const [word, positions] of Object.entries(index)) {
    for (const pos of positions) words[pos] = word;
  }
  return words.join(" ").replace(/\s+/g, " ").trim() || null;
}

function normalizeTitle(title: string) {
  return title.toLowerCase().replace(/[^a-z0-9가-힣]+/g, " ").trim();
}

function keyForWork(work: OpenAlexWork) {
  if (work.doi) return `doi:${work.doi.toLowerCase()}`;
  if (work.id) return `oa:${work.id.toLowerCase()}`;
  return `title:${normalizeTitle(work.title || "untitled")}`;
}

async function searchOneConcept(
  concept: ResearchConcept,
  topicEn: string,
  perPage: number,
): Promise<Array<{ work: OpenAlexWork; rank: number; concept: ResearchConcept }>> {
  const params = new URLSearchParams({
    search: (concept.search_query || `${concept.name_en} ${topicEn}`).trim(),
    sort: "relevance_score:desc",
    per_page: String(perPage),
  });
  const key = process.env.OPENALEX_API_KEY;
  if (key) params.set("api_key", key);

  const response = await fetch(`https://api.openalex.org/works?${params.toString()}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`OpenAlex ${response.status}: ${await response.text()}`);
  }
  const json = (await response.json()) as { results?: OpenAlexWork[] };
  return (json.results || []).map((work, index) => ({ work, rank: index + 1, concept }));
}

async function concurrentMap<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;

  async function run() {
    while (true) {
      const current = cursor++;
      if (current >= items.length) return;
      out[current] = await worker(items[current]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()));
  return out;
}

export async function retrievePapers(analysis: ResearchAnalysis, conceptLimit = 30, perConcept = 5): Promise<PaperResult[]> {
  const concepts = [...analysis.concepts]
    .sort((a, b) => b.importance - a.importance)
    .slice(0, conceptLimit);

  const searched = await concurrentMap(concepts, 4, (concept) =>
    searchOneConcept(concept, analysis.research_topic_en || analysis.research_topic, perConcept),
  );

  const hits = searched.flat();
  const totalImportance = Math.max(0.0001, concepts.reduce((sum, c) => sum + c.importance, 0));
  const map = new Map<
    string,
    {
      work: OpenAlexWork;
      matches: Array<{ name: string; importance: number; rank: number }>;
    }
  >();

  for (const hit of hits) {
    const key = keyForWork(hit.work);
    const existing = map.get(key);
    const match = { name: hit.concept.name_en, importance: hit.concept.importance, rank: hit.rank };
    if (existing) existing.matches.push(match);
    else map.set(key, { work: hit.work, matches: [match] });
  }

  const maxCitations = Math.max(1, ...Array.from(map.values()).map((v) => v.work.cited_by_count || 0));

  const papers: PaperResult[] = Array.from(map.values()).map(({ work, matches }) => {
    const coverage = Math.min(1, matches.reduce((sum, m) => sum + m.importance, 0) / totalImportance * 4);
    const rankQuality =
      matches.reduce((sum, m) => sum + m.importance * (1 - (m.rank - 1) / Math.max(1, perConcept)), 0) /
      Math.max(0.0001, matches.reduce((sum, m) => sum + m.importance, 0));
    const citations = work.cited_by_count || 0;
    const citationBoost = Math.log1p(citations) / Math.log1p(maxCitations);
    const final = 0.55 * coverage + 0.35 * rankQuality + 0.1 * citationBoost;
    const doi = work.doi || null;

    return {
      id: work.id,
      title: work.title || "Untitled",
      year: work.publication_year ?? null,
      authors: (work.authorships || [])
        .map((a) => a.author?.display_name)
        .filter((name): name is string => Boolean(name))
        .slice(0, 8),
      doi,
      url: doi || work.id,
      venue: work.primary_location?.source?.display_name || null,
      cited_by_count: citations,
      abstract: reconstructAbstract(work.abstract_inverted_index),
      matched_concepts: matches.sort((a, b) => b.importance - a.importance),
      final_score: Math.round(final * 1000) / 10,
    };
  });

  return papers.sort((a, b) => b.final_score - a.final_score);
}
