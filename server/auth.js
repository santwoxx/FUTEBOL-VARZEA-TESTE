// Identidade do jogador (login Google/Firebase) + allowlist da beta fechada.
//
// O multiplayer esta em teste: so entra quem esta logado com o Google E tem o
// e-mail liberado. A lista mora num lugar so: a funcao betaEmails() do
// firestore.rules, na raiz do repositorio.
//
//   · no cliente, essa lista trava a leitura de betaAccess/{uid} — e o que faz
//     o jogo mostrar o lobby ou a tela de "beta fechada". Vitrine: quem abre o
//     DevTools passa por cima;
//   · aqui, o mesmo arquivo e lido no boot e vira a trava de verdade, conferida
//     antes de qualquer sala ser criada ou entrada.
//
// Convidar alguem = por o e-mail no firestore.rules, dar push (o servidor
// recarrega no deploy) e publicar as regras no console do Firebase. Sem
// segunda lista para esquecer de atualizar.
//
// MP_ALLOWED_EMAILS continua existindo como atalho: se estiver definida, ela
// manda no lugar do arquivo — util para liberar alguem no painel do Render sem
// esperar deploy. E MP_OPEN=1 abre o multiplayer para qualquer um logado, que
// e como se testa duas abas na mesma maquina (duas abas = mesma conta Google =
// mesmo uid, e a sala derruba o duplicado).
//
// A conferencia do token e feita contra as chaves publicas do Google, sem
// firebase-admin: o backend continua rodando com um pacote so (ws).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Mesmo projectId do firebaseConfig em frontend/index.html.
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "creative-footbal";
const ISSUER = `https://securetoken.google.com/${PROJECT_ID}`;

// Certificados x509 que assinam os ID tokens do Firebase Auth.
const CERTS_URL =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";

// Relogio do Render nao e o relogio do jogador: 5 min de folga evita recusar
// token bom por alguns segundos de diferenca.
const CLOCK_SKEW = 300;

const RULES_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)), "..", "firestore.rules"
);

// Le os e-mails de dentro da funcao betaEmails() do firestore.rules. Regex em
// vez de parser: o trecho e um literal de lista de strings, e o arquivo e
// nosso — se um dia ele mudar de forma, o log do boot denuncia (0 e-mails).
function emailsFromRules() {
  let src;
  try {
    src = fs.readFileSync(RULES_FILE, "utf8");
  } catch (e) {
    return { list: [], found: false };
  }
  const block = /function\s+betaEmails\s*\(\s*\)\s*\{[^{}]*?return\s*\[([^\]]*)\]/.exec(src);
  if (!block) return { list: [], found: false };
  // Fora os comentarios: a lista vem com exemplos comentados ao lado.
  const corpo = block[1].replace(/\/\/[^\n]*/g, "");
  const list = [...corpo.matchAll(/"([^"]*)"|'([^']*)'/g)]
    .map(m => (m[1] || m[2] || "").trim().toLowerCase())
    .filter(e => e.includes("@") && !e.startsWith("coloque-"));
  return { list, found: true };
}

// MP_OPEN=1 abre o online para qualquer conta Google valida. Serve para testar
// duas abas na mesma maquina (duas abas = mesma conta = mesmo uid). Em producao
// fica desligado, e ai vale a lista.
const OPEN = process.env.MP_OPEN === "1";

// A lista sai do firestore.rules — o MESMO arquivo que o navegador usa. Assim
// convidar alguem e uma edicao so, e nao ha como as duas pontas divergirem.
// MP_ALLOWED_EMAILS continua como atalho para liberar alguem pelo painel do
// Render sem esperar deploy; se estiver preenchida, manda no lugar do arquivo.
const fromEnv = (process.env.MP_ALLOWED_EMAILS || "")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
const fromRules = fromEnv.length ? { list: [], found: false } : emailsFromRules();

const ALLOWED = new Set(fromEnv.length ? fromEnv : fromRules.list);
const SOURCE = fromEnv.length
  ? "MP_ALLOWED_EMAILS (painel do Render)"
  : (fromRules.found ? "firestore.rules" : "NENHUMA lista encontrada");

export function accessConfig() {
  return {
    enforced: !OPEN,
    allowed: ALLOWED.size,
    source: OPEN ? "MP_OPEN=1 (online aberto a qualquer conta)" : SOURCE,
    projectId: PROJECT_ID
  };
}

// ─────────────────────── chaves publicas do Google ───────────────────────

let certs = null;
let certsExpire = 0;
let certsInflight = null;

async function googleCerts() {
  if (certs && Date.now() < certsExpire) return certs;
  if (certsInflight) return certsInflight;

  certsInflight = (async () => {
    const res = await fetch(CERTS_URL);
    if (!res.ok) throw new Error(`certificados do Google: HTTP ${res.status}`);
    const json = await res.json();
    // O Google rotaciona as chaves; o max-age da resposta diz por quanto tempo
    // vale o cache. Sem ele, 1h e conservador o bastante.
    const m = /max-age=(\d+)/.exec(res.headers.get("cache-control") || "");
    certs = json;
    certsExpire = Date.now() + (m ? Number(m[1]) * 1000 : 3600) * 1000;
    return certs;
  })();

  try { return await certsInflight; }
  finally { certsInflight = null; }
}

// ───────────────────────── verificacao do ID token ─────────────────────────

function segment(part) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

// Devolve as claims quando o token e valido; joga erro quando nao e. NUNCA
// confie no payload sem passar por aqui: as tres partes do JWT sao so base64,
// qualquer um monta um "token" dizendo ser quem quiser.
export async function verifyIdToken(token) {
  if (typeof token !== "string" || !token || token.length > 8192) {
    throw new Error("token ausente");
  }
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("token malformado");

  const header = segment(parts[0]);
  const payload = segment(parts[1]);
  if (header.alg !== "RS256") throw new Error("algoritmo inesperado");
  if (!header.kid) throw new Error("token sem kid");

  const pem = (await googleCerts())[header.kid];
  if (!pem) throw new Error("kid desconhecido");

  const ok = crypto.createVerify("RSA-SHA256")
    .update(`${parts[0]}.${parts[1]}`)
    .verify(new crypto.X509Certificate(pem).publicKey, Buffer.from(parts[2], "base64url"));
  if (!ok) throw new Error("assinatura invalida");

  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== PROJECT_ID) throw new Error("token de outro projeto");
  if (payload.iss !== ISSUER) throw new Error("emissor invalido");
  if (!payload.sub) throw new Error("token sem dono");
  if (!(payload.exp > now - CLOCK_SKEW)) throw new Error("token expirado");
  if (!(payload.iat < now + CLOCK_SKEW)) throw new Error("token do futuro");

  return {
    uid: String(payload.sub),
    email: String(payload.email || "").toLowerCase(),
    emailVerified: payload.email_verified !== false,
    name: String(payload.name || "")
  };
}

// ────────────────────────── porta do multiplayer ──────────────────────────

// reason serve para o cliente escolher a tela certa:
//   "login" -> nao esta logado (ou o token nao cola)
//   "beta"  -> logado, mas fora da lista
export async function checkMultiplayerAccess(idToken) {
  // Sem token, token forjado ou token vencido: nao entra. O `catch` NAO pode
  // liberar — foi exatamente assim que a trava tinha sido anulada, e com ela o
  // uid deixava de ser verificado (o servidor passava a confiar no que vinha no
  // JSON do cliente).
  let claims;
  try {
    claims = await verifyIdToken(idToken);
  } catch (e) {
    return { ok: false, reason: "login", email: "", uid: "", detail: e.message };
  }

  // Conta Google sem e-mail confirmado nao vale: a lista e por e-mail, e um
  // e-mail nao verificado pode ser de outra pessoa.
  if (!claims.emailVerified || !claims.email) {
    return { ok: false, reason: "login", email: claims.email, uid: claims.uid };
  }

  if (OPEN) return { ok: true, reason: "open", email: claims.email, uid: claims.uid };
  if (ALLOWED.has(claims.email)) {
    return { ok: true, reason: "allowed", email: claims.email, uid: claims.uid };
  }
  return { ok: false, reason: "beta", email: claims.email, uid: claims.uid };
}
