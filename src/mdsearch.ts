#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// mdsearch.ts v2 — recherche hybride (BM25 + embeddings) sur un dossier Markdown
// SQLite intégré à Node (node:sqlite, Node ≥ 22.18) + Ollama pour les embeddings.
// Zéro dépendance npm.
//
// Usage :
//   node mdsearch.ts index  <dossier> [--rebuild] [--no-embed]   # indexation incrémentale
//   node mdsearch.ts watch  <dossier> [--no-embed]               # réindexe à chaque sauvegarde
//   node mdsearch.ts search "<requête>" [n] [--mode hybrid|bm25|vector] [--dir <dossier>]
//   node mdsearch.ts optimize [--dir <dossier>]                  # compacte l'index FTS5
//
// Base : <dossier indexé>/.mdsearch.db (un index par dossier).
// search/optimize la retrouvent en remontant depuis --dir ou le dossier courant (comme git avec .git).
//
// Variables d'environnement :
//   MDSEARCH_DB           base SQLite imposée    (remplace .mdsearch.db)
//   OLLAMA_HOST           serveur Ollama         (défaut http://127.0.0.1:11434)
//   MDSEARCH_EMBED_MODEL  modèle d'embedding     (défaut bge-m3, multilingue)

import { DatabaseSync, type StatementSync } from "node:sqlite";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, watch as fsWatch, type Stats } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { styleText } from "node:util";
import { createHash } from "node:crypto";

// --- Réglages ---
export const DB_FILE = ".mdsearch.db"; // nom de la base, placée dans le dossier indexé
const OLLAMA_HOST = (process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434").replace(/\/$/, "");
const EMBED_MODEL = process.env.MDSEARCH_EMBED_MODEL ?? "bge-m3";
const SCHEMA_VERSION = 3; // v3 = ajout des chunks/embeddings (anciennes bases reconstruites)
const AUTO_OPTIMIZE_AT = 100; // nb de changements cumulés avant optimize FTS5 auto
const WATCH_DEBOUNCE_MS = 300; // regroupe les rafales d'événements (sauvegarde = plusieurs events)
const CHUNK_WORDS = 300; // taille cible d'un chunk (≈ 400 tokens)
const EMBED_BATCH = 32; // textes envoyés à Ollama par requête
const FILE_BATCH = 32; // fichiers écrits par transaction (si Ollama plante, le travail fait est gardé)
const CANDIDATES = 50; // résultats pris dans chaque liste avant fusion RRF
const RRF_K = 60; // constante standard du RRF

// Balises autour des termes trouvés dans Hit.snippet (caractères de contrôle :
// jamais dans du Markdown, contrairement à [ ] qui servent aux liens)
export const MARK_START = "\u0002";
export const MARK_END = "\u0003";

export type Mode = "hybrid" | "bm25" | "vector";

export interface Hit {
  // bm25 : plus négatif = mieux | vector : cosinus, plus haut = mieux | hybrid : RRF, plus haut = mieux
  score: number;
  path: string;
  snippet: string; // termes trouvés entre MARK_START et MARK_END
  ranks?: { bm25?: number; vector?: number }; // rang dans chaque liste (mode hybrid)
}

export interface IndexStats {
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  chunksEmbedded: number; // chunks envoyés au modèle d'embedding
  optimized: boolean; // optimize FTS5 lancé à la fin ?
}

interface FileRow {
  id: number;
  path: string;
  mtime: number;
  size: number;
  hash: string;
  embed_model: string | null; // modèle ayant produit les chunks de ce fichier (null = pas d'embeddings)
}

interface Chunk {
  heading: string;
  text: string;
}

// Travail à faire sur un fichier (phase 1 → phase 2)
interface Work {
  kind: "add" | "update" | "reembed";
  path: string;
  st: Stats;
  body: string;
  hash: string;
  row?: FileRow;
}

// ============================================================================
// Utilitaires
// ============================================================================

// Liste récursive des .md (chemins absolus)
function listMarkdown(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => resolve(e.parentPath, e.name));
}

// Titre = 1re ligne "# ...", sinon nom du fichier
function extractTitle(path: string, body: string): string {
  const m = body.match(/^# (.+)$/m);
  return m ? m[1].trim() : basename(path, ".md");
}

// ============================================================================
// Emplacement de la base
// ============================================================================
// Un index par dossier de notes, rangé dedans : <dossier>/.mdsearch.db.
// MDSEARCH_DB, si défini, impose un fichier précis.

// Base d'un dossier à indexer
export function dbPathFor(dir: string): string {
  return process.env.MDSEARCH_DB ? resolve(process.env.MDSEARCH_DB) : join(resolve(dir), DB_FILE);
}

// Base pour chercher : remonte depuis `from` jusqu'à trouver un .mdsearch.db
// → marche depuis le dossier indexé ou n'importe quel sous-dossier.
export function findDb(from = process.cwd()): string {
  if (process.env.MDSEARCH_DB) {
    const p = resolve(process.env.MDSEARCH_DB);
    if (!existsSync(p)) throw new Error(`Base introuvable : ${p} (MDSEARCH_DB). Lancer d'abord index <dossier>`);
    return p;
  }
  for (let d = resolve(from); ; d = dirname(d)) {
    const p = join(d, DB_FILE);
    if (existsSync(p)) return p;
    if (dirname(d) === d) break; // racine atteinte
  }
  throw new Error(
    `Aucun index ${DB_FILE} trouvé dans ${resolve(from)} ni au-dessus. ` +
      `Lancer d'abord index <dossier>, ou préciser --dir <dossier indexé>`,
  );
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

// ============================================================================
// Découpage en chunks
// ============================================================================
// 1. Coupe aux titres (#, ##, …) hors blocs de code → 1 section = 1 idée
// 2. Section trop longue → regroupe ses paragraphes jusqu'à ~CHUNK_WORDS mots
// 3. Paragraphe géant → coupe brute par mots
export function chunkMarkdown(body: string): Chunk[] {
  const sections: Chunk[] = [];
  let heading = "";
  let buf: string[] = [];
  let inCode = false;
  const flush = () => {
    const text = buf.join("\n").trim();
    if (text) sections.push({ heading, text });
    buf = [];
  };
  for (const line of body.split("\n")) {
    if (line.trimStart().startsWith("```")) inCode = !inCode;
    const m = inCode ? null : line.match(/^#{1,6}\s+(.*)$/);
    if (m) {
      flush();
      heading = m[1].trim();
    } else {
      buf.push(line);
    }
  }
  flush();

  const out: Chunk[] = [];
  for (const s of sections) {
    let cur: string[] = [];
    let n = 0;
    const push = () => {
      if (cur.length) out.push({ heading: s.heading, text: cur.join("\n\n") });
      cur = [];
      n = 0;
    };
    for (const para of s.text.split(/\n\s*\n/)) {
      const words = para.split(/\s+/).filter(Boolean);
      if (!words.length) continue;
      if (words.length > CHUNK_WORDS) {
        push();
        for (let i = 0; i < words.length; i += CHUNK_WORDS) {
          out.push({ heading: s.heading, text: words.slice(i, i + CHUNK_WORDS).join(" ") });
        }
        continue;
      }
      if (n + words.length > CHUNK_WORDS) push();
      cur.push(para.trim());
      n += words.length;
    }
    push();
  }
  return out;
}

// Texte réellement envoyé au modèle : contexte (titre > section) + contenu
// → un chunk « Installation » sait de quel document il parle
function embedText(title: string, c: Chunk): string {
  const ctx = c.heading && c.heading !== title ? `${title} > ${c.heading}` : title;
  return `${ctx}\n${c.text}`;
}

// ============================================================================
// Embeddings (Ollama)
// ============================================================================
function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v; // vecteurs normés → cosinus = simple produit scalaire
}

export async function embed(texts: string[]): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const input = texts.slice(i, i + EMBED_BATCH);
    let res: Response;
    try {
      res = await fetch(`${OLLAMA_HOST}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: EMBED_MODEL, input }),
      });
    } catch {
      throw new Error(`Ollama injoignable sur ${OLLAMA_HOST} (lancé ? sinon utiliser --no-embed)`);
    }
    if (!res.ok) {
      throw new Error(`Ollama ${res.status} : ${await res.text()} (modèle installé ? ollama pull ${EMBED_MODEL})`);
    }
    const { embeddings } = (await res.json()) as { embeddings: number[][] };
    for (const e of embeddings) out.push(normalize(Float32Array.from(e)));
  }
  return out;
}

// Float32Array ⇄ BLOB SQLite (4 octets par nombre)
const toBlob = (v: Float32Array) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
const fromBlob = (b: Uint8Array) => new Float32Array(b.slice().buffer); // slice = copie alignée

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// ============================================================================
// Base de données
// ============================================================================
function openDb(dbPath: string, rebuild: boolean): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  // WAL : on peut chercher pendant qu'un watch écrit (lecteurs non bloqués)
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  const { user_version } = db.prepare("PRAGMA user_version").get() as { user_version: number };

  // Ancien schéma ou --rebuild → on repart de zéro
  if (rebuild || user_version !== SCHEMA_VERSION) {
    db.exec(`
      DROP TABLE IF EXISTS docs; DROP TABLE IF EXISTS chunks;
      DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS meta;
    `);
  }
  db.exec(`
    -- Compteurs divers (ex : changements depuis le dernier optimize)
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);

    -- Suivi des fichiers : 1 ligne par fichier, id = rowid dans docs
    CREATE TABLE IF NOT EXISTS files (
      id          INTEGER PRIMARY KEY,
      path        TEXT UNIQUE NOT NULL,
      mtime       REAL    NOT NULL,
      size        INTEGER NOT NULL,
      hash        TEXT    NOT NULL,
      embed_model TEXT              -- null = pas encore d'embeddings
    );

    -- Index plein texte (BM25), 1 ligne par fichier
    -- unicode61 + remove_diacritics → "modeles" trouve "modèles"
    CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(
      path UNINDEXED, title, body,
      tokenize = 'unicode61 remove_diacritics 2'
    );

    -- Morceaux + leur vecteur, N lignes par fichier
    CREATE TABLE IF NOT EXISTS chunks (
      id        INTEGER PRIMARY KEY,
      file_id   INTEGER NOT NULL,
      ord       INTEGER NOT NULL,   -- position dans le fichier
      heading   TEXT    NOT NULL,
      text      TEXT    NOT NULL,
      embedding BLOB    NOT NULL    -- Float32Array normé
    );
    CREATE INDEX IF NOT EXISTS chunks_file ON chunks(file_id);

    PRAGMA user_version = ${SCHEMA_VERSION};
  `);
  return db;
}

function getMeta(db: DatabaseSync, key: string): number {
  const r = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: number } | undefined;
  return r?.value ?? 0;
}
function setMeta(db: DatabaseSync, key: string, value: number): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, value);
}

// Transaction synchrone : tout ou rien
function tx(db: DatabaseSync, fn: () => void): void {
  db.exec("BEGIN");
  try {
    fn();
    db.exec("COMMIT");
  } catch (e) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw e;
  }
}

// ============================================================================
// Indexation incrémentale
// ============================================================================
// Phase 1 (rapide, sync) : scan mtime/hash → liste du travail à faire
// Phase 2 (lente, async) : par lots de fichiers → chunks → embeddings → 1 transaction par lot
// Phase 3 (sync)         : fichiers supprimés + optimize auto
export async function index(
  dir: string,
  opts: { rebuild?: boolean; embed?: boolean; dbPath?: string } = {},
): Promise<IndexStats> {
  const withEmbed = opts.embed ?? true;
  const db = openDb(opts.dbPath ?? dbPathFor(dir), opts.rebuild ?? false);
  const root = resolve(dir);
  const stats: IndexStats = { added: 0, updated: 0, removed: 0, unchanged: 0, chunksEmbedded: 0, optimized: false };

  const q = {
    get: db.prepare("SELECT * FROM files WHERE path = ?"),
    insFile: db.prepare("INSERT INTO files (path, mtime, size, hash, embed_model) VALUES (?, ?, ?, ?, ?)"),
    updFile: db.prepare("UPDATE files SET mtime = ?, size = ?, hash = ?, embed_model = ? WHERE id = ?"),
    touch: db.prepare("UPDATE files SET mtime = ?, size = ? WHERE id = ?"),
    delFile: db.prepare("DELETE FROM files WHERE id = ?"),
    insDoc: db.prepare("INSERT INTO docs (rowid, path, title, body) VALUES (?, ?, ?, ?)"),
    delDoc: db.prepare("DELETE FROM docs WHERE rowid = ?"),
    insChunk: db.prepare("INSERT INTO chunks (file_id, ord, heading, text, embedding) VALUES (?, ?, ?, ?, ?)"),
    delChunks: db.prepare("DELETE FROM chunks WHERE file_id = ?"),
    under: db.prepare("SELECT id, path FROM files WHERE path LIKE ? ESCAPE '\\'"),
  };

  try {
    // ---------- Phase 1 : qu'est-ce qui a changé ? ----------
    const seen = new Set<string>();
    const work: Work[] = [];
    const touched: { id: number; st: Stats }[] = [];

    for (const path of listMarkdown(root)) {
      seen.add(path);
      const st = statSync(path);
      const row = q.get.get(path) as FileRow | undefined;
      // Fichier à jour côté texte, mais embeddings manquants ou d'un autre modèle ?
      const needsEmbed = withEmbed && row?.embed_model !== EMBED_MODEL;

      // Test rapide : mtime + taille identiques → on ne lit même pas le fichier
      if (row && row.mtime === st.mtimeMs && row.size === st.size && !needsEmbed) {
        stats.unchanged++;
        continue;
      }

      const body = readFileSync(path, "utf8");
      const hash = sha256(body);

      if (!row) {
        work.push({ kind: "add", path, st, body, hash });
      } else if (row.hash !== hash) {
        work.push({ kind: "update", path, st, body, hash, row });
      } else if (needsEmbed) {
        work.push({ kind: "reembed", path, st, body, hash, row }); // texte identique, vecteurs à (re)faire
      } else {
        touched.push({ id: row.id, st }); // juste « touché » (mtime changé, contenu identique)
        stats.unchanged++;
      }
    }
    if (touched.length) tx(db, () => touched.forEach((t) => q.touch.run(t.st.mtimeMs, t.st.size, t.id)));

    // ---------- Phase 2 : chunks + embeddings + écriture, par lots ----------
    for (let i = 0; i < work.length; i += FILE_BATCH) {
      const batch = work.slice(i, i + FILE_BATCH);

      // Embeddings du lot en une passe (async, hors transaction)
      const chunksPerFile = batch.map((w) => (withEmbed ? chunkMarkdown(w.body) : []));
      let vectors: Float32Array[] = [];
      if (withEmbed) {
        const texts = batch.flatMap((w, j) => {
          const title = extractTitle(w.path, w.body);
          const cs = chunksPerFile[j];
          // Fichier sans contenu hors titres → 1 chunk avec le titre seul
          if (!cs.length) cs.push({ heading: "", text: title });
          return cs.map((c) => embedText(title, c));
        });
        vectors = await embed(texts);
        stats.chunksEmbedded += texts.length;
      }

      // Écriture du lot (sync, transaction)
      let v = 0;
      tx(db, () => {
        batch.forEach((w, j) => {
          const model = withEmbed ? EMBED_MODEL : null;
          let id: number | bigint;
          if (w.kind === "add") {
            id = q.insFile.run(w.path, w.st.mtimeMs, w.st.size, w.hash, model).lastInsertRowid;
            q.insDoc.run(id, w.path, extractTitle(w.path, w.body), w.body);
            stats.added++;
          } else {
            id = w.row!.id;
            q.delChunks.run(id); // vieux chunks : périmés dans tous les cas
            q.updFile.run(w.st.mtimeMs, w.st.size, w.hash, model, id);
            if (w.kind === "update") {
              // FTS5 n'a pas d'UPDATE efficace : DELETE + INSERT
              q.delDoc.run(id);
              q.insDoc.run(id, w.path, extractTitle(w.path, w.body), w.body);
              stats.updated++;
            } else {
              stats.unchanged++; // reembed : texte inchangé
            }
          }
          chunksPerFile[j].forEach((c, ord) => q.insChunk.run(id, ord, c.heading, c.text, toBlob(vectors[v++])));
        });
      });
    }

    // ---------- Phase 3 : suppressions + optimize ----------
    // Seulement sous ce dossier (la base peut contenir d'autres dossiers)
    const prefix = (root + sep).replace(/[\\%_]/g, "\\$&") + "%";
    tx(db, () => {
      for (const r of q.under.all(prefix) as Pick<FileRow, "id" | "path">[]) {
        if (!seen.has(r.path)) {
          q.delDoc.run(r.id);
          q.delChunks.run(r.id);
          q.delFile.run(r.id);
          stats.removed++;
        }
      }
    });

    // Optimize auto : après --rebuild, ou quand assez de changements se sont accumulés
    const pending = getMeta(db, "pending_changes") + stats.added + stats.updated + stats.removed;
    if (opts.rebuild || pending >= AUTO_OPTIMIZE_AT) {
      runOptimize(db);
      stats.optimized = true;
    } else {
      setMeta(db, "pending_changes", pending);
    }
  } finally {
    db.close();
  }
  return stats;
}

// ============================================================================
// Optimize
// ============================================================================
// Chaque INSERT/DELETE FTS5 ajoute un petit « segment » à l'index inversé.
// Beaucoup de segments = recherches plus lentes + base plus grosse.
// 'optimize' les fusionne en un seul (comme défragmenter).
function runOptimize(db: DatabaseSync): void {
  db.exec("INSERT INTO docs(docs) VALUES('optimize')");
  setMeta(db, "pending_changes", 0);
}

export function optimize(dbPath = findDb()): void {
  const db = openDb(dbPath, false);
  try {
    runOptimize(db);
    db.exec("VACUUM"); // rend au disque la place libérée
  } finally {
    db.close();
  }
}

// ============================================================================
// Watch
// ============================================================================
// Indexe une fois, puis réindexe (incrémental) à chaque modif d'un .md.
// Scan complet relancé plutôt que fichier par fichier : quelques ms grâce au mtime,
// et renommages/suppressions gérés sans cas particuliers.
export async function watch(
  dir: string,
  onIndex: (s: IndexStats) => void,
  opts: { embed?: boolean; dbPath?: string } = {},
): Promise<() => void> {
  const root = resolve(dir);
  const run = () => index(root, opts).then(onIndex);
  await run();

  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let again = false; // modif arrivée pendant une indexation → on relance après
  const trigger = async () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        await run();
      } while (again);
    } catch (e) {
      console.error(`Erreur : ${(e as Error).message}`); // on continue à surveiller
    } finally {
      running = false;
    }
  };

  const watcher = fsWatch(root, { recursive: true }, (_event, name) => {
    if (!name || !String(name).endsWith(".md")) return; // ignore fichiers temporaires d'éditeur
    clearTimeout(timer);
    timer = setTimeout(trigger, WATCH_DEBOUNCE_MS);
  });

  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}

// ============================================================================
// Recherche
// ============================================================================
function bm25Search(db: DatabaseSync, query: string, limit: number): Hit[] {
  // bm25(docs, 0, 10, 1) : poids path/title/body → titre x10
  const rows = db
    .prepare(`
      SELECT bm25(docs, 0, 10, 1) AS score,
             path,
             snippet(docs, 2, ?, ?, '…', 12) AS snippet
      FROM docs
      WHERE docs MATCH ?
      ORDER BY score
      LIMIT ?
    `)
    .all(MARK_START, MARK_END, query, limit) as unknown as Hit[];
  return rows.map((r) => ({ ...r, snippet: oneLine(r.snippet) }));
}

// Balise les mots de la requête dans un extrait vectoriel (FTS5 ne l'a pas produit).
// Simple sous-chaîne, casse ignorée : « modèle » balisé dans « modèles ».
function markTerms(text: string, query: string): string {
  const words = (query.match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !/^(AND|OR|NOT|NEAR)$/.test(w));
  if (!words.length) return text;
  return text.replace(new RegExp(words.join("|"), "giu"), (m) => MARK_START + m + MARK_END);
}

// Force brute : compare la requête à TOUS les chunks.
// 10 000 chunks × 1024 dims ≈ 10 M multiplications → quelques dizaines de ms.
// Au-delà de ~100 000 chunks : passer à l'extension sqlite-vec.
async function vectorSearch(db: DatabaseSync, query: string, limit: number): Promise<Hit[]> {
  const [qv] = await embed([query]);
  const stmt: StatementSync = db.prepare(`
    SELECT f.path, c.heading, c.text, c.embedding
    FROM chunks c JOIN files f ON f.id = c.file_id
    WHERE f.embed_model = ?
  `);

  // Meilleur chunk par fichier (un fichier = un résultat)
  const best = new Map<string, Hit>();
  for (const r of stmt.iterate(EMBED_MODEL) as Iterable<{ path: string; heading: string; text: string; embedding: Uint8Array }>) {
    const v = fromBlob(r.embedding);
    if (v.length !== qv.length) throw new Error("Dimensions incompatibles : modèle changé ? relancer index --rebuild");
    const score = dot(qv, v);
    const prev = best.get(r.path);
    if (!prev || score > prev.score) {
      const words = oneLine(r.text).split(" ");
      const excerpt = words.slice(0, 25).join(" ") + (words.length > 25 ? "…" : "");
      best.set(r.path, { score, path: r.path, snippet: markTerms((r.heading ? `§ ${r.heading} — ` : "") + excerpt, query) });
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

// RRF : score = Σ 1 / (k + rang) sur chaque liste.
// Utilise les rangs, pas les scores → pas besoin de comparer BM25 et cosinus.
function rrf(bm25: Hit[], vector: Hit[], limit: number): Hit[] {
  const fused = new Map<string, Hit>();
  const add = (list: Hit[], key: "bm25" | "vector") =>
    list.forEach((h, i) => {
      const rank = i + 1;
      const cur = fused.get(h.path) ?? { score: 0, path: h.path, snippet: h.snippet, ranks: {} };
      cur.score += 1 / (RRF_K + rank);
      cur.ranks![key] = rank;
      fused.set(h.path, cur); // snippet BM25 prioritaire (mots surlignés), sinon extrait du chunk
    });
  add(bm25, "bm25");
  add(vector, "vector");
  return [...fused.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

// La requête BM25 utilise la syntaxe FTS5 (OR, "…", préfixe*).
// En hybride, une syntaxe invalide ne doit pas tout casser → on retente en mots simples.
function safeBm25(db: DatabaseSync, query: string, limit: number): Hit[] {
  try {
    return bm25Search(db, query, limit);
  } catch {
    const words = query.match(/[\p{L}\p{N}]+/gu) ?? [];
    return words.length ? bm25Search(db, words.map((w) => `"${w}"`).join(" OR "), limit) : [];
  }
}

export async function search(
  query: string,
  opts: { limit?: number; mode?: Mode; dbPath?: string } = {}, // dbPath : défaut findDb()
): Promise<{ mode: Mode; hits: Hit[] }> {
  const limit = opts.limit ?? 10;
  const db = new DatabaseSync(opts.dbPath ?? findDb(), { readOnly: true });
  try {
    const { n } = db.prepare("SELECT count(*) AS n FROM chunks WHERE file_id IN (SELECT id FROM files WHERE embed_model = ?)")
      .get(EMBED_MODEL) as { n: number };
    // Pas d'embeddings dans la base → BM25 seul, sans erreur
    let mode: Mode = opts.mode ?? (n > 0 ? "hybrid" : "bm25");
    if (mode !== "bm25" && n === 0) {
      console.error(`(aucun embedding ${EMBED_MODEL} dans la base → mode bm25)`);
      mode = "bm25";
    }

    if (mode === "bm25") return { mode, hits: bm25Search(db, query, limit) };
    if (mode === "vector") return { mode, hits: await vectorSearch(db, query, limit) };

    let vec: Hit[];
    try {
      vec = await vectorSearch(db, query, CANDIDATES);
    } catch (e) {
      console.error(`(${(e as Error).message} → mode bm25)`); // Ollama éteint : on dégrade proprement
      return { mode: "bm25", hits: bm25Search(db, query, limit) };
    }
    return { mode, hits: rrf(safeBm25(db, query, CANDIDATES), vec, limit) };
  } finally {
    db.close();
  }
}

// ============================================================================
// CLI
// ============================================================================
// Terminal : chemin cliquable (lien OSC 8) + termes surlignés.
// Tube ou fichier (agent, grep) : texte brut, termes entre [ ].
// NO_COLOR / FORCE_COLOR (https://no-color.org) forcent l'un ou l'autre.
function richOutput(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return process.env.FORCE_COLOR !== "0";
  return process.stdout.isTTY === true && process.stdout.hasColors();
}

export function formatHit(h: Hit, rich: boolean): string {
  const ranks = h.ranks
    ? ` (bm25 ${h.ranks.bm25 ? "#" + h.ranks.bm25 : "–"}, vec ${h.ranks.vector ? "#" + h.ranks.vector : "–"})`
    : "";
  const marks = new RegExp(`${MARK_START}(.*?)${MARK_END}`, "gs");
  if (!rich) return `${h.score.toFixed(4)}${ranks} | ${h.path} | ${h.snippet.replace(marks, "[$1]")}`;
  // OSC 8 : ESC ]8;;URL ESC \ texte ESC ]8;; ESC \ (texte normal si le terminal ne gère pas)
  const link = `\x1b]8;;${pathToFileURL(h.path).href}\x1b\\${h.path}\x1b]8;;\x1b\\`;
  const snippet = h.snippet.replace(marks, (_, t: string) => styleText(["bold", "yellow"], t, { validateStream: false }));
  return `${h.score.toFixed(4)}${ranks} | ${link} | ${snippet}`;
}

function parseArgs(argv: string[]) {
  const flags = new Set<string>();
  const pos: string[] = [];
  let mode: Mode | undefined;
  let dir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir") {
      dir = argv[++i];
      if (!dir) throw new Error("--dir attend un dossier");
    } else if (a === "--mode") {
      const m = argv[++i];
      if (m !== "hybrid" && m !== "bm25" && m !== "vector") throw new Error(`--mode invalide : ${m}`);
      mode = m;
    } else if (a.startsWith("--")) flags.add(a);
    else pos.push(a);
  }
  return { flags, pos, mode, dir };
}

async function main(): Promise<void> {
  const { flags, pos, mode, dir } = parseArgs(process.argv.slice(2));
  const [cmd, arg, n] = pos;
  const embedOpt = !flags.has("--no-embed");

  // `pnpm mdsearch` lance le script depuis la racine du projet ;
  // INIT_CWD = dossier où l'utilisateur a tapé la commande → chemins relatifs résolus depuis là.
  const userCwd = process.env.INIT_CWD ?? process.cwd();
  const userPath = (p: string) => resolve(userCwd, p);
  if (process.env.MDSEARCH_DB) process.env.MDSEARCH_DB = userPath(process.env.MDSEARCH_DB);
  const searchDb = () => findDb(dir ? userPath(dir) : userCwd);

  const fmt = (s: IndexStats) =>
    `+${s.added} ajoutés, ~${s.updated} modifiés, -${s.removed} supprimés, =${s.unchanged} inchangés` +
    (s.chunksEmbedded ? `, ${s.chunksEmbedded} chunks vectorisés` : "") +
    (s.optimized ? ", index optimisé" : "");

  if (cmd === "index" && arg) {
    const t0 = performance.now();
    const root = userPath(arg);
    const s = await index(root, { rebuild: flags.has("--rebuild"), embed: embedOpt });
    console.log(`${fmt(s)} (${Math.round(performance.now() - t0)} ms) → ${dbPathFor(root)}`);
  } else if (cmd === "watch" && arg) {
    const time = () => new Date().toLocaleTimeString("fr-FR");
    let first = true;
    const root = userPath(arg);
    const stop = await watch(
      root,
      (s) => {
        // N'affiche que l'index initial et les vrais changements
        if (first || s.added + s.updated + s.removed + s.chunksEmbedded > 0) console.log(`[${time()}] ${fmt(s)}`);
        first = false;
      },
      { embed: embedOpt },
    );
    console.log(`Surveillance de ${root}… (Ctrl+C pour arrêter) → ${dbPathFor(root)}`);
    process.on("SIGINT", () => {
      stop();
      process.exit(0);
    });
  } else if (cmd === "search" && arg) {
    const r = await search(arg, { limit: n ? Number(n) : 10, mode, dbPath: searchDb() });
    const rich = richOutput();
    for (const h of r.hits) console.log(formatHit(h, rich));
  } else if (cmd === "optimize") {
    const db = searchDb();
    optimize(db);
    console.log(`Index optimisé → ${db}`);
  } else {
    console.error(
      "Usage :\n" +
        "  mdsearch index <dossier> [--rebuild] [--no-embed]\n" +
        "  mdsearch watch <dossier> [--no-embed]\n" +
        '  mdsearch search "<requête>" [n] [--mode hybrid|bm25|vector] [--dir <dossier>]\n' +
        "  mdsearch optimize [--dir <dossier>]",
    );
    process.exit(1);
  }
}

// Lancé directement (pas importé) ? realpath : via `pnpm add -g link:…`, argv[1] passe par
// un lien symbolique alors que import.meta.url pointe vers le vrai fichier.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((e) => {
    console.error(`Erreur : ${(e as Error).message}`); // ex : syntaxe FTS5 invalide, Ollama absent
    process.exit(1);
  });
}
