/* ═══════════════════════════════════════════════════════════════════════════
   CREATIVE FOOTBALL — configuração de ambiente

   Este é o ÚNICO arquivo que sabe onde o backend mora. O jogo (index.html)
   não tem nenhuma URL de servidor escrita nele.

   Carregado como script clássico ANTES do módulo do jogo, então
   window.CF_CONFIG já existe quando o jogo inicializa.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  // Backend em produção (Render). Se o serviço mudar de endereço, troque AQUI.
  const PROD = "https://futebol-varzea-teste.onrender.com";

  // Backend quando você está desenvolvendo na sua máquina.
  const DEV = "http://localhost:8080";

  function isLocal() {
    const h = location.hostname;
    return !h                      // arquivo aberto direto (file://)
      || h === "localhost"
      || h === "127.0.0.1"
      || h === "[::1]"
      || /^192\.168\./.test(h)     // rede local — jogar com amigos no mesmo Wi-Fi
      || /^10\./.test(h);
  }

  // Em rede local, o backend está na mesma máquina que serviu a página.
  function devBase() {
    if (/^(192\.168\.|10\.)/.test(location.hostname)) {
      return `http://${location.hostname}:8080`;
    }
    return DEV;
  }

  // Override manual para testes: abra a página com ?server=https://outro.host
  // (fica salvo na sessão, então sobrevive a um F5).
  function override() {
    try {
      const q = new URLSearchParams(location.search).get("server");
      if (q) { sessionStorage.setItem("cf_server", q); return q; }
      return sessionStorage.getItem("cf_server");
    } catch (e) { return null; }
  }

  function base() {
    return override() || PROD; // Força produção no APK mobile para não buscar no localhost do aparelho
  }

  window.CF_CONFIG = {
    // Para fetch(): /health e /rooms
    httpUrl() {
      return base().replace(/\/+$/, "");
    },
    // Para new WebSocket(): as partidas
    wsUrl() {
      return this.httpUrl().replace(/^http/i, "ws");
    },
    isLocal
  };
})();
