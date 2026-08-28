// Carrega server/.env quando voce esta desenvolvendo na sua maquina.
//
// Em producao (Render) as variaveis ja vem do ambiente do servico, e nada aqui
// sobrescreve o que ja esta definido — o .env e so uma conveniencia local.
// Sem dependencia externa de proposito: o backend inteiro roda com um pacote so.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), ".env");

let loaded = 0;
try {
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Aceita aspas: o secret do LiveKit tem caracteres que assustam shell
    if (/^".*"$/s.test(value) || /^'.*'$/s.test(value)) value = value.slice(1, -1);
    if (process.env[key] === undefined) { process.env[key] = value; loaded++; }
  }
  if (loaded) console.log(`.env carregado (${loaded} variaveis)`);
} catch (e) {
  // Arquivo nao existe: normal em producao e em quem nao usa VoIP local.
}
