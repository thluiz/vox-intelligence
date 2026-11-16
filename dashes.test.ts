import { describe, expect, test } from "bun:test";
import { stripDashes } from "./dashes";

describe("stripDashes", () => {
  test("spaced em dash becomes a comma", () => {
    expect(stripDashes("existir é duro — porque envolve conflito")).toBe("existir é duro, porque envolve conflito");
  });

  test("unspaced em dash too", () => {
    expect(stripDashes("trust—not control")).toBe("trust, not control");
  });

  test("a pair of dashes around an aside", () => {
    expect(stripDashes("o rio — e quem manda nele — virou disputa")).toBe("o rio, e quem manda nele, virou disputa");
  });

  test("spaced en dash used as a dash", () => {
    expect(stripDashes("o ponto – segundo ela – é outro")).toBe("o ponto, segundo ela, é outro");
  });

  test("numeric ranges with en dash are kept", () => {
    expect(stripDashes("entre 1990–2000, pp. 12–15")).toBe("entre 1990–2000, pp. 12–15");
  });

  test("no doubled punctuation", () => {
    expect(stripDashes("coisas que a performance mascara —.")).toBe("coisas que a performance mascara.");
    expect(stripDashes("fim —")).toBe("fim");
    expect(stripDashes("(— nota)")).toBe("(nota)");
  });

  test("leading dash is dropped", () => {
    expect(stripDashes("— Começa assim")).toBe("Começa assim");
  });

  test("text without dashes is untouched, hyphens included", () => {
    const t = "Bem-estar e auto-organização, sem travessão.";
    expect(stripDashes(t)).toBe(t);
  });
});

