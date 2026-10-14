// Tests de bout en bout : on lance le CLI comme un utilisateur, contre un faux Ollama.
// Lancer : npm test
import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startMockOllama, type MockOllama } from "./helpers/mock-ollama.ts";
import { chunkMarkdown } from "../src/mdsearch.ts";

const CLI = resolve(import.meta.dirname, "../src/mdsearch.ts");

interface RunResult {
  code: number;
  out: string;
  err: string;
}

// Exécution asynchrone obligatoire : le faux Ollama tourne dans ce même process
function run(args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((ok) => {
    execFile(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", CLI, ...args],
      { env: { ...process.env, ...env } },
      (error, out, err) => ok({ code: error ? Number(error.code ?? 1) : 0, out, err }),
    );
  });
}

// ---------------------------------------------------------------------------
describe("chunkMarkdown", () => {
  test("coupe aux titres", () => {
    const c = chunkMarkdown("# Doc\nintro\n\n## A\ntexte a\n\n## B\ntexte b\n");
    assert.deepEqual(
      c.map((x) => [x.heading, x.text]),
      [["Doc", "intro"], ["A", "texte a"], ["B", "texte b"]],
    );
  });

  test("ignore les # dans les blocs de code", () => {
    const c = chunkMarkdown("## Bash\n```\n# commentaire\necho hi\n```\n");
    assert.equal(c.length, 1);
    assert.equal(c[0].heading, "Bash");
    assert.match(c[0].text, /# commentaire/);
  });

  test("découpe une section trop longue", () => {
    const para = Array.from({ length: 200 }, (_, i) => `mot${i}`).join(" ");
    const c = chunkMarkdown(`## Long\n${para}\n\n${para}\n\n${para}\n`);
    assert.equal(c.length, 3); // 3 × 200 mots > 300 → un chunk par paragraphe
    assert.ok(c.every((x) => x.heading === "Long"));
  });

  test("coupe un paragraphe géant par mots", () => {
    const giant = Array.from({ length: 700 }, (_, i) => `m${i}`).join(" ");
    assert.equal(chunkMarkdown(giant).length, 3); // 300 + 300 + 100
  });
});

// ---------------------------------------------------------------------------
describe("CLI", () => {
  let ollama: MockOllama;
  let dir: string; // dossier de travail du test
  let wiki: string; // dossier Markdown indexé
  let env: Record<string, string>;

  const write = (name: string, content: string) => {
    const p = join(wiki, name);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  };
  const cli = (args: string[], extra: Record<string, string> = {}) => run(args, { ...env, ...extra });

  before(async () => {
    ollama = await startMockOllama();
  });
  after(async () => {
    await ollama.close();
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mdsearch-"));
    wiki = join(dir, "wiki");
    env = { MDSEARCH_DB: join(dir, "test.db"), OLLAMA_HOST: ollama.url, MDSEARCH_EMBED_MODEL: "bge-m3" };
    write("voiture.md", "# Voitures électriques\n\n## Autonomie\nLa voiture électrique roule 400 km.\n\n## Recharge\nBorne rapide.\n");
    write("lora.md", "# LoRA\nLoRA fine-tuning léger des modèles.\n");
    write("sub/tarte.md", "# Tarte aux pommes\nUne recette simple avec des pommes.\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("index puis réindex : rien à revectoriser", async () => {
    const before = ollama.calls();
    let r = await cli(["index", wiki]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /\+3 ajoutés/);
    assert.match(r.out, /4 chunks vectorisés/);
    assert.equal(ollama.calls() - before, 4);

    r = await cli(["index", wiki]);
    assert.match(r.out, /\+0 ajoutés, ~0 modifiés, -0 supprimés, =3 inchangés/);
    assert.equal(ollama.calls() - before, 4); // aucun nouvel appel
  });

  test("modif / ajout / suppression : seul le nécessaire est revectorisé", async () => {
    await cli(["index", wiki]);
    const before = ollama.calls();
    write("lora.md", "# LoRA\nLoRA et QLoRA.\n");
    write("neuf.md", "# Neuf\nqlora\n");
    rmSync(join(wiki, "sub/tarte.md"));
    const r = await cli(["index", wiki]);
    assert.match(r.out, /\+1 ajoutés, ~1 modifiés, -1 supprimés, =1 inchangés, 2 chunks vectorisés/);
    assert.equal(ollama.calls() - before, 2);

    const s = await cli(["search", "tarte", "--mode", "bm25"]);
    assert.equal(s.out.trim(), ""); // fichier supprimé bien retiré
  });

  test("BM25 rate le synonyme, le vectoriel le trouve", async () => {
    await cli(["index", wiki]);
    const bm25 = await cli(["search", "automobile", "--mode", "bm25"]);
    assert.equal(bm25.out.trim(), "");
    const vec = await cli(["search", "automobile", "1", "--mode", "vector"]);
    assert.match(vec.out, /voiture\.md \| § Autonomie/);
  });

  test("hybride : fusion RRF avec les rangs", async () => {
    await cli(["index", wiki]);
    const r = await cli(["search", "lora", "1"]);
    assert.match(r.out, /\(bm25 #1, vec #1\) \| .*lora\.md/);
  });

  test("hybride : syntaxe FTS5 invalide → retente en mots simples", async () => {
    await cli(["index", wiki]);
    const r = await cli(["search", '"lora', "1"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /lora\.md/);
  });

  test("--no-embed puis index normal : ajoute juste les vecteurs", async () => {
    let r = await cli(["index", wiki, "--no-embed"]);
    assert.doesNotMatch(r.out, /vectorisés/);
    r = await cli(["search", "lora"]); // pas d'embeddings → bm25 auto
    assert.match(r.out, /^-\d/); // score BM25 négatif
    r = await cli(["index", wiki]);
    assert.match(r.out, /=3 inchangés, 4 chunks vectorisés/);
  });

  test("changement de modèle : revectorise tout, le BM25 ne bouge pas", async () => {
    await cli(["index", wiki]);
    const r = await cli(["index", wiki], { MDSEARCH_EMBED_MODEL: "autre-modele" });
    assert.match(r.out, /\+0 ajoutés, ~0 modifiés, -0 supprimés, =3 inchangés, 4 chunks vectorisés/);
    const s = await cli(["search", "automobile", "1", "--mode", "vector"], { MDSEARCH_EMBED_MODEL: "autre-modele" });
    assert.match(s.out, /voiture\.md/);
  });

  test("modèle absent d'Ollama : erreur claire", async () => {
    const r = await cli(["index", wiki], { MDSEARCH_EMBED_MODEL: "inconnu" });
    assert.equal(r.code, 1);
    assert.match(r.err, /ollama pull inconnu/);
  });

  test("Ollama éteint : la recherche dégrade en BM25, l'index échoue proprement", async () => {
    await cli(["index", wiki]);
    const down = { OLLAMA_HOST: "http://127.0.0.1:9" }; // port fermé
    const s = await cli(["search", "lora", "1"], down);
    assert.equal(s.code, 0);
    assert.match(s.err, /mode bm25/);
    assert.match(s.out, /lora\.md/);

    write("autre.md", "# Autre\n");
    const i = await cli(["index", wiki], down);
    assert.equal(i.code, 1);
    assert.match(i.err, /Ollama injoignable/);
  });

  test("plusieurs dossiers dans la même base", async () => {
    const other = join(dir, "notes");
    mkdirSync(other);
    writeFileSync(join(other, "x.md"), "# X\nlora\n");
    await cli(["index", wiki]);
    await cli(["index", other]);
    const r = await cli(["index", wiki]); // ne doit pas supprimer notes/x.md
    assert.match(r.out, /-0 supprimés/);
    const s = await cli(["search", "lora", "--mode", "bm25"]);
    assert.match(s.out, /notes\/x\.md/);
  });

  test("optimize", async () => {
    await cli(["index", wiki]);
    const r = await cli(["optimize"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Index optimisé/);
  });
});
