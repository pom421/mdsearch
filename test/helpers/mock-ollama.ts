// Faux serveur Ollama pour les tests : implémente POST /api/embed.
// Vecteurs « jouets » = sac de mots haché, avec quelques synonymes ramenés au même mot
// → permet de vérifier que la recherche vectorielle trouve « automobile » → « voiture ».
import http from "node:http";
import type { AddressInfo } from "node:net";

const SYNONYMS: Record<string, string> = {
  automobile: "voiture",
  auto: "voiture",
  vehicule: "voiture",
  bagnole: "voiture",
  cuisiner: "recette",
  plat: "recette",
};

// Modèles connus → dimension des vecteurs
const MODELS: Record<string, number> = { "bge-m3": 64, "autre-modele": 32 };

function toyVector(text: string, dims: number): number[] {
  const v = new Array<number>(dims).fill(0);
  const words = text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").match(/\p{L}+/gu) ?? [];
  for (const raw of words) {
    const w = SYNONYMS[raw] ?? raw;
    let h = 0;
    for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    v[h % dims] += 1;
  }
  return v;
}

export interface MockOllama {
  url: string;
  calls: () => number; // nb de textes vectorisés depuis le démarrage
  close: () => Promise<void>;
}

export function startMockOllama(): Promise<MockOllama> {
  let calls = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method !== "POST" || req.url !== "/api/embed") {
        res.writeHead(404).end();
        return;
      }
      const { model, input } = JSON.parse(body) as { model: string; input: string | string[] };
      const dims = MODELS[model];
      if (!dims) {
        res.writeHead(404).end(JSON.stringify({ error: `model '${model}' not found` }));
        return;
      }
      const inputs = Array.isArray(input) ? input : [input];
      calls += inputs.length;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ model, embeddings: inputs.map((t) => toyVector(t, dims)) }));
    });
  });

  return new Promise((ok) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      ok({
        url: `http://127.0.0.1:${port}`,
        calls: () => calls,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
