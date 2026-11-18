// Unit tests for the deterministic parts of the quote-note preset (no LLM).
//   bun test templates/scholion/quote-note.test.ts
// The live regression (calls the model) is templates/scholion/run-quote-fixtures.ts.

import { describe, expect, test } from "bun:test";
import {
  buildSearchQuery,
  buildUserPrompt,
  detectBook,
  enforceProvenance,
  isSocialUrl,
  parseFields,
  socialSourceTitle,
  urlKey,
} from "./quote-note";

const BERKOPEC_URL = "https://x.com/nateberkopec/status/1248643404361355265";
const UNCLEBOB_URL = "https://x.com/unclebobmartin/status/1143592822974636033";

const berkopecReq = {
  quote:
    '"Programmer as craftsman" is a toxic ideology, prioritizing aesthetics and programmer desires over serving customers. I get paid for the things my software does, not how it does it.',
  presumedAuthor: "Nate Berkopec",
  sourceUrl: BERKOPEC_URL,
  context: `Tweet de Nate Berkopec (@nateberkopec) em 2020-04-10 (${BERKOPEC_URL}). Texto original do tweet: "Programmer as craftsman" is a toxic ideology...`,
};

const noBook = { bookMode: false, bookUrl: null };

function fields(over: Record<string, unknown>) {
  return parseFields(
    JSON.stringify({
      slug: "x",
      title: "frase",
      summary: "resumo",
      tags: ["autor"],
      has_commentary: false,
      sources: [{ title: "s", kind: "web" }],
      body: "corpo",
      authorship: { verified: true, notes: "" },
      ...over,
    }),
  );
}

describe("detectBook", () => {
  test("a tweet context is not book mode (regression: context used to switch it on)", () => {
    expect(detectBook(berkopecReq).bookMode).toBe(false);
  });

  test("fromBook or a book link switch it on", () => {
    expect(detectBook({ quote: "q", fromBook: true }).bookMode).toBe(true);
    const r = detectBook({ quote: "q", sourceUrl: "https://a.co/d/abc123" });
    expect(r.bookMode).toBe(true);
    expect(r.bookUrl).toBe("https://a.co/d/abc123");
  });
});

describe("urls", () => {
  test("twitter.com and x.com, www, trailing slash and query compare equal", () => {
    expect(urlKey("https://twitter.com/nateberkopec/status/1248643404361355265?s=20")).toBe(
      urlKey(BERKOPEC_URL + "/"),
    );
    expect(urlKey("http://www.goodreads.com/work/quotes/42872911")).toBe(
      urlKey("https://goodreads.com/work/quotes/42872911"),
    );
  });

  test("social detection and tweet title", () => {
    expect(isSocialUrl(BERKOPEC_URL)).toBe(true);
    expect(isSocialUrl("https://www.goodreads.com/x")).toBe(false);
    expect(socialSourceTitle(UNCLEBOB_URL)).toBe("Tweet de @unclebobmartin");
  });
});

describe("prompt and search", () => {
  test("the origin URL is in the user prompt", () => {
    const p = buildUserPrompt(berkopecReq, "(pesquisa)", noBook);
    expect(p).toContain("URL DE ORIGEM INFORMADA");
    expect(p).toContain(BERKOPEC_URL);
    expect(p).not.toContain("MODO LIVRO");
  });

  test("a tweet context does not ask for 'bibliographic details of the work' (regression)", () => {
    const q = buildSearchQuery(berkopecReq);
    expect(q).not.toContain("BIBLIOGRAPHIC");
    expect(q).not.toContain("already established by the requester");
    expect(q).toContain(BERKOPEC_URL);
  });
});

describe("parseFields", () => {
  test("rejects a body that puts words in the requester's mouth (Berkopec regression)", () => {
    expect(() =>
      fields({
        body: "Passagem situada pelo solicitante como extraída do livro Software Craftsmanship, de Pete McBreen (2001).",
      }),
    ).toThrow(/solicitante/);
  });
});

describe("enforceProvenance", () => {
  test("Berkopec: fabricated book attribution, tweet omitted → tweet added, verified=false", () => {
    const f = fields({
      sources: [{ title: "Software Craftsmanship: The New Imperative", author: "Pete McBreen", year: 2001, kind: "book" }],
      body: "Passagem do livro Software Craftsmanship, de Pete McBreen (2001).",
      authorship: { verified: true, notes: "" },
    });
    const { fields: out, warnings } = enforceProvenance(f, berkopecReq, "(no results)", noBook);

    expect(out.sources[0]).toEqual({ title: "Tweet de @nateberkopec", url: BERKOPEC_URL, kind: "web" });
    expect(out.authorship.verified).toBe(false);
    expect(out.authorship.notes).toContain("Software Craftsmanship");
    expect(warnings.join(" ")).toContain("URL de origem ausente");
    expect(warnings.join(" ")).toContain("obra sem fonte consultada");
  });

  test("Uncle Bob: 'Clean Code (2008)' with no consulted URL → verified=false", () => {
    const req = { quote: "Not only does bad code slow you down NOW...", presumedAuthor: "Robert C. Martin", sourceUrl: UNCLEBOB_URL };
    const f = fields({
      sources: [
        { title: "Clean Code", author: "Robert C. Martin", year: 2008, kind: "book" },
        { title: "Tweet de @unclebobmartin", url: UNCLEBOB_URL, kind: "web" },
      ],
    });
    const { fields: out } = enforceProvenance(f, req, "Search found nothing earlier than the tweet.", noBook);
    expect(out.authorship.verified).toBe(false);
    expect(out.sources.filter((s) => s.url && urlKey(s.url) === urlKey(UNCLEBOB_URL))).toHaveLength(1);
  });

  test("own tweet as the only source stays verified", () => {
    const f = fields({
      sources: [{ title: "Tweet de @nateberkopec, 10 abr. 2020", author: "Nate Berkopec", url: BERKOPEC_URL, kind: "web" }],
    });
    const { fields: out, warnings } = enforceProvenance(f, berkopecReq, "", noBook);
    expect(out.authorship.verified).toBe(true);
    expect(warnings).toEqual([]);
  });

  test("a work found by the search (URL in the search context) is kept", () => {
    const tweet = "https://x.com/justsitthere/status/1152416088484958210";
    const goodreads = "https://www.goodreads.com/work/quotes/42872911";
    const req = { quote: "Integrity: Choosing courage over comfort...", presumedAuthor: "Brené Brown", sourceUrl: tweet };
    const f = fields({
      sources: [
        { title: "Rising Strong Quotes by Brené Brown", url: goodreads, kind: "web" },
        { title: "Tweet de @justsitthere", url: tweet, kind: "web" },
      ],
    });
    const search = `Goodreads lists it under Rising Strong.\n\nFONTES CONSULTADAS PELA PESQUISA:\n[1] ${goodreads}`;
    const { fields: out, warnings } = enforceProvenance(f, req, search, noBook);
    expect(out.sources.map((s) => s.url)).toEqual([goodreads, tweet]);
    expect(out.authorship.verified).toBe(true);
    expect(warnings).toEqual([]);
  });

  test("a URL that appears nowhere in input or search is dropped", () => {
    const f = fields({
      sources: [
        { title: "Tweet", url: BERKOPEC_URL, kind: "web" },
        { title: "Inventado", url: "https://example.com/made-up", kind: "article" },
      ],
    });
    const { fields: out, warnings } = enforceProvenance(f, berkopecReq, "", noBook);
    expect(out.sources[1].url).toBeUndefined();
    expect(out.authorship.verified).toBe(false);
    expect(warnings.join(" ")).toContain("url não consultada removida");
  });

  test("book mode: the requester's book needs no URL", () => {
    const req = { quote: "q", presumedAuthor: "A", fromBook: true, context: "Do livro X, cap. 3" };
    const f = fields({ sources: [{ title: "X", author: "A", kind: "book" }] });
    const { fields: out } = enforceProvenance(f, req, "", detectBook(req));
    expect(out.authorship.verified).toBe(true);
  });
});
