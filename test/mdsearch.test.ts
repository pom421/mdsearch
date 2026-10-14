// Tests de bout en bout : on lance le CLI comme un utilisateur, contre un faux Ollama.
// Lancer : pnpm test
import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startMockOllama, type MockOllama } from "./helpers/mock-ollama.ts";
import { chunkMarkdown, formatHit, MARK_END, MARK_START } from "../src/mdsearch.ts";

const CLI = resolve(import.meta.dirname, "../src/mdsearch.ts");

interface RunResult {
  code: number;
  out: string;
  err: string;
}

// Exécution asynchrone obligatoire : le faux Ollama tourne dans ce même process
// env : une valeur `undefined` retire la variable (ex : MDSEARCH_DB pour tester la base par défaut)
function run(
  args: string[],
  env: Record<string, string | undefined> = {},
  cwd?: string,
): Promise<RunResult> {
  const fullEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...env }).filter(([, v]) => v !== undefined),
  ) as Record<string, string>;
  return new Promise((ok) => {
    execFile(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", CLI, ...args],
      { env: fullEnv, cwd },
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
describe("formatHit", () => {
  const hit = { score: -1.5, path: "/notes/mon bash.md", snippet: `un ${MARK_START}bash${MARK_END} [lien](x)` };

  test("texte brut : termes entre [ ], pas de code d'échappement", () => {
    assert.equal(formatHit(hit, false), "-1.5000 | /notes/mon bash.md | un [bash] [lien](x)");
  });

  test("terminal : chemin cliquable (OSC 8) et terme surligné", () => {
    const out = formatHit(hit, true);
    assert.ok(out.includes("\x1b]8;;file:///notes/mon%20bash.md\x1b\\/notes/mon bash.md\x1b]8;;\x1b\\"));
    assert.ok(out.includes("\x1b[1m\x1b[33mbash\x1b[39m\x1b[22m"));
    assert.ok(out.endsWith(" [lien](x)")); // crochets du Markdown laissés tels quels
  });

  test("terminal : pattern surligné dans le nom du fichier, pas dans les dossiers", () => {
    const out = formatHit({ score: -1, path: "/bash/bash.md", snippet: "" }, true, "bash");
    assert.ok(out.includes("\x1b\\/bash/\x1b[1m\x1b[33mbash\x1b[39m\x1b[22m.md\x1b]8;;"));
    assert.ok(out.includes("file:///bash/bash.md")); // lien intact
    assert.equal(formatHit({ score: -1, path: "/bash/bash.md", snippet: "" }, false, "bash"), "-1.0000 | /bash/bash.md | ");
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
  const cli = (args: string[], extra: Record<string, string | undefined> = {}, cwd?: string) =>
    run(args, { ...env, ...extra }, cwd);

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

  test("search : termes surlignés, [ ] hors terminal, liens avec FORCE_COLOR", async () => {
    await cli(["index", wiki]);
    let r = await cli(["search", "recette", "--mode", "bm25"]);
    assert.match(r.out, /tarte\.md \| .*Une \[recette\] simple/);
    r = await cli(["search", "recette", "1", "--mode", "vector"]); // extrait vectoriel : balisé aussi
    assert.match(r.out, /\[recette\]/);
    r = await cli(["search", "recette", "--mode", "bm25"], { FORCE_COLOR: "1" });
    assert.match(r.out, /\x1b\]8;;file:\/\/.*tarte\.md\x1b\\/);
    r = await cli(["search", "recette", "--mode", "bm25"], { FORCE_COLOR: "1", NO_COLOR: "1" });
    assert.doesNotMatch(r.out, /\x1b/);
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

  test("lancé via un lien symbolique (commande globale pnpm add -g link:…)", async () => {
    const link = join(dir, "mdsearch-lien.ts");
    symlinkSync(CLI, link);
    const r = await new Promise<RunResult>((ok) =>
      execFile(process.execPath, ["--disable-warning=ExperimentalWarning", link, "index", wiki, "--no-embed"],
        { env: { ...process.env, ...env } as Record<string, string> },
        (error, out, err) => ok({ code: error ? Number(error.code ?? 1) : 0, out, err })),
    );
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /\+3 ajoutés/); // avant le correctif : sortie vide, rien n'était exécuté
  });

  test("optimize", async () => {
    await cli(["index", wiki]);
    const r = await cli(["optimize"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Index optimisé/);
  });
  // --- Base dans le dossier indexé (sans MDSEARCH_DB) ---
  const noDb = { MDSEARCH_DB: undefined, INIT_CWD: undefined };

  test("base par défaut : <dossier>/.mdsearch.db, retrouvée depuis un sous-dossier", async () => {
    const i = await cli(["index", wiki, "--no-embed"], noDb);
    assert.equal(i.code, 0, i.err);
    assert.ok(existsSync(join(wiki, ".mdsearch.db")));
    assert.match(i.out, /wiki\/\.mdsearch\.db/);

    // Lancé depuis wiki/sub : remonte jusqu'à wiki/.mdsearch.db (comme git avec .git)
    const s = await cli(["search", "lora", "--mode", "bm25"], noDb, join(wiki, "sub"));
    assert.equal(s.code, 0, s.err);
    assert.match(s.out, /lora\.md/);
  });

  test("--dir désigne le dossier indexé", async () => {
    await cli(["index", wiki, "--no-embed"], noDb);
    const s = await cli(["search", "lora", "--dir", wiki, "--mode", "bm25"], noDb, dir);
    assert.match(s.out, /lora\.md/);
    const o = await cli(["optimize", "--dir", wiki], noDb, dir);
    assert.match(o.out, /Index optimisé → .*wiki\/\.mdsearch\.db/);
  });

  test("deux dossiers = deux index séparés", async () => {
    const other = join(dir, "notes");
    mkdirSync(other);
    writeFileSync(join(other, "x.md"), "# X\nlora\n");
    await cli(["index", wiki, "--no-embed"], noDb);
    await cli(["index", other, "--no-embed"], noDb);
    const s = await cli(["search", "lora", "--mode", "bm25"], noDb, other);
    assert.match(s.out, /notes\/x\.md/);
    assert.doesNotMatch(s.out, /wiki\/lora\.md/);
  });

  test("aucun index trouvé : erreur claire", async () => {
    const s = await cli(["search", "lora"], noDb, dir);
    assert.equal(s.code, 1);
    assert.match(s.err, /Aucun index \.mdsearch\.db trouvé/);
    assert.match(s.err, /--dir/);
  });

  test("chemins relatifs résolus depuis INIT_CWD (pnpm lance depuis la racine du projet)", async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "ailleurs-"));
    try {
      // process lancé ailleurs, comme pnpm ; l'utilisateur a tapé la commande dans `dir`
      const i = await cli(["index", "wiki", "--no-embed"], { MDSEARCH_DB: undefined, INIT_CWD: dir }, elsewhere);
      assert.equal(i.code, 0, i.err);
      assert.ok(existsSync(join(wiki, ".mdsearch.db")));
      const s = await cli(["search", "lora", "--dir", "wiki", "--mode", "bm25"], { MDSEARCH_DB: undefined, INIT_CWD: dir }, elsewhere);
      assert.match(s.out, /lora\.md/);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
