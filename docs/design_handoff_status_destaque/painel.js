const MONITORES = (() => {
  const base = [
    { id: 'jf', nome: 'JF - Arch Home - Situator', erro: 'HTTP 000 · timeout 30s', quedaEm: 2 },
    { id: 'situator', nome: 'Situator (grupo)', erro: 'HTTP 502 · bad gateway', quedaEm: 9, degradaEm: 1 },
    { id: 'guardian', nome: 'Guardian - Situator', erro: 'HTTP 504 · gateway timeout', quedaEm: 5 },
    { id: 'stv', nome: 'STV - Canoas - Situator', erro: 'HTTP 500 · internal error', quedaEm: 5 },
    { id: 'api', nome: 'API Winker - Produção', erro: 'Conexão recusada (ECONNREFUSED)', quedaEm: 5 },
    { id: 'push', nome: 'Notificações push', erro: 'HTTP 429 · rate limit', quedaEm: 5 },
    { id: 'portaria', nome: 'Portaria remota - Canoas', quedaEm: 9 },
    { id: 'boletos', nome: 'Emissão de boletos', quedaEm: 9 },
    { id: 'app', nome: 'App morador - iOS/Android', quedaEm: 9 },
    { id: 'cam', nome: 'Câmeras - Arch Home', quedaEm: 9 }
  ];
  const cidades = ['Canoas', 'Porto Alegre', 'Novo Hamburgo', 'São Leopoldo', 'Gravataí', 'Viamão', 'Sapucaia', 'Cachoeirinha', 'Esteio', 'Alvorada'];
  const produtos = ['Situator', 'Guardian', 'Portaria', 'Câmeras'];
  cidades.forEach((c, i) => produtos.forEach((p, j) => {
    if (base.length < 50) base.push({ id: 'g' + i + j, nome: p + ' - ' + c, quedaEm: 9 });
  }));
  return base;
})();

const COR = { up: 'var(--color-success)', pending: 'var(--color-warning)', down: 'var(--color-danger)', vazio: '#e6e8eb' };

// Heartbeats de exemplo. Em produção: vêm do Uptime Kuma (socket.io ou /api/status-page/<slug>/heartbeat).
function heartbeats(estado, id) {
  const out = [];
  const semente = id.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  if (estado === 'up') { for (let i = 0; i < 45; i++) out.push('up'); return out; }
  const queda = 6 + (semente % 16);
  for (let i = 0; i < 45 - queda - 2; i++) out.push('up');
  out.push('pending', 'pending');
  for (let i = 0; i < queda; i++) out.push(estado === 'down' ? 'down' : 'up');
  return out;
}

const PULSO_MS = 15000;    // duração do pulso após uma mudança de situação
const PAGINA_MS = 15000;   // troca de página da lista

class Painel {
  constructor(raiz) {
    this.raiz = raiz;
    this.nivel = 1;              // 0 = normal · 1 = uma queda · 2 = cinco quedas (só para demonstração)
    this.pagina = 0;
    this.linhas = 5;
    this.piscando = false;
    this.mudaram = [];
    this.chaveAnterior = undefined;
    this.segundos = 60;

    setInterval(() => { this.segundos = this.segundos > 0 ? this.segundos - 1 : 60; this.pintarContador(); }, 1000);
    setInterval(() => { this.pagina++; this.render(); }, PAGINA_MS);
    addEventListener('resize', () => this.render());
    this.render();
    requestAnimationFrame(() => this.medir());
  }

  // ---- estado derivado ---------------------------------------------------
  monitores() {
    return MONITORES.map(m => {
      const down = m.quedaEm <= this.nivel;
      const degradado = !down && m.degradaEm !== undefined && m.degradaEm <= this.nivel;
      const estado = down ? 'down' : degradado ? 'pending' : 'up';
      return Object.assign({}, m, { down, degradado, estado, batidas: heartbeats(estado, m.id) });
    });
  }

  detectarMudanca(fora) {
    const chave = fora.map(m => m.id).join(',');
    if (this.chaveAnterior !== undefined && this.chaveAnterior !== chave) {
      const antes = this.chaveAnterior ? this.chaveAnterior.split(',').filter(Boolean) : [];
      this.mudaram = fora.map(m => m.id).filter(id => antes.indexOf(id) === -1);
      this.piscando = true;
      clearTimeout(this.timerPulso);
      this.timerPulso = setTimeout(() => { this.piscando = false; this.mudaram = []; this.render(); }, PULSO_MS);
    }
    this.chaveAnterior = chave;
  }

  // Capacidade da lista medida no DOM — nunca uma constante.
  medir() {
    const grade = this.raiz.querySelector('[data-grade]');
    if (!grade || !grade.firstElementChild) return;
    const alturaLinha = grade.firstElementChild.getBoundingClientRect().height;
    if (!alturaLinha) return;
    const linhas = Math.max(1, Math.floor(grade.clientHeight / alturaLinha));
    if (linhas !== this.linhas) { this.linhas = linhas; this.render(); }
  }

  // ---- render -----------------------------------------------------------
  render() {
    const lista = this.monitores();
    const fora = lista.filter(m => m.down);
    this.detectarMudanca(fora);

    const restantes = fora.length ? lista.filter(m => !m.down) : lista;
    const porPagina = Math.max(2, this.linhas * 2);
    const paginas = Math.max(1, Math.ceil(restantes.length / porPagina));
    const pagina = this.pagina % paginas;
    // última página retrocede para encher a tela
    const inicio = Math.min(pagina * porPagina, Math.max(0, restantes.length - porPagina));
    const visiveis = restantes.slice(inicio, inicio + porPagina);

    const resumo = (fora.length
      ? 'Demais monitores · ' + restantes.length + ' de ' + MONITORES.length
      : MONITORES.length + ' monitores · todos normais')
      + (paginas > 1 ? '  ·  página ' + (pagina + 1) + '/' + paginas : '');

    this.raiz.innerHTML = this.cabecalho()
      + (fora.length ? this.destaque(fora) : this.tudoOk())
      + this.lista(visiveis, resumo);

    this.pintarContador();
    requestAnimationFrame(() => this.medir());
  }

  pintarContador() {
    const el = this.raiz.querySelector('[data-contador]');
    if (el) el.textContent = 'Próxima leitura em 00:' + String(this.segundos).padStart(2, '0');
  }

  cabecalho() {
    return `<div style="display:flex; align-items:flex-end; justify-content:space-between; gap:40px;">
      <div style="display:flex; flex-direction:column; gap:8px;">
        <p style="margin:0; font-size:22px; font-weight:700; letter-spacing:.14em; text-transform:uppercase; color:var(--color-primary);">Winker · Monitoramento</p>
        <h1 style="margin:0; font-size:64px; font-weight:800; letter-spacing:-.02em; line-height:1;">Status dos serviços</h1>
      </div>
      <div style="display:flex; flex-direction:column; align-items:flex-end; gap:4px;">
        <p style="margin:0; font-size:24px; color:var(--text-secondary);">Atualizado ${new Date().toLocaleTimeString('pt-BR')}</p>
        <p data-contador style="margin:0; font-size:24px; color:var(--text-secondary);"></p>
      </div></div>`;
  }

  barras(batidas, w, h, gap) {
    return `<div style="display:flex; gap:${gap}px; align-items:flex-end; flex:0 0 auto;">`
      + batidas.map(b => `<div style="width:${w}px; height:${h}px; border-radius:${gap > 3 ? 4 : 2}px; background:${COR[b] || COR.vazio};"></div>`).join('')
      + `</div>`;
  }

  destaque(fora) {
    const anim = this.piscando ? 'animation:alertaPisca 1s ease-in-out infinite;' : '';
    const faixa = `<div style="background:var(--color-danger); color:#fff; padding:22px 36px; display:flex; align-items:center; gap:20px;">
      <span style="width:22px; height:22px; border-radius:99px; background:#fff; animation:pulseDot 1.1s ease-in-out infinite;"></span>
      <p style="margin:0; font-size:34px; font-weight:800; letter-spacing:.06em; text-transform:uppercase;">${fora.length === 1 ? 'Serviço fora do ar' : 'Serviços fora do ar'}</p>
      <p style="margin:0 0 0 auto; font-size:30px; font-weight:700;">${fora.length} de ${MONITORES.length} monitores</p></div>`;

    const corpo = fora.length === 1 ? this.cardGrande(fora[0]) : this.gradeCards(fora);

    return `<div style="flex:0 0 auto; display:flex; flex-direction:column; border-radius:var(--r-card); overflow:hidden; box-shadow:var(--shadow-alert); border:3px solid var(--color-danger); ${anim}">${faixa}${corpo}</div>`;
  }

  cardGrande(m) {
    return `<div style="background:var(--surface); padding:28px 36px; display:flex; flex-direction:column; gap:20px; border-top:1px solid var(--divider);">
      <div style="display:flex; align-items:center; gap:40px; flex-wrap:wrap;">
        <h2 style="margin:0; font-size:48px; font-weight:800; letter-spacing:-.02em; line-height:1.05;">${m.nome}</h2>
        <div style="display:flex; align-items:center; gap:14px; padding:12px 22px; border-radius:var(--r-badge); background:rgba(245,61,61,.1);">
          <span style="width:14px; height:14px; border-radius:99px; background:var(--color-danger);"></span>
          <p style="margin:0; font-size:28px; font-weight:800; color:var(--color-danger);">${m.erro}</p></div>
      </div>
      <div style="display:flex; flex-direction:column; gap:10px;">
        <p style="margin:0; font-size:20px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:var(--text-secondary);">Histórico · últimos 60 minutos</p>
        ${this.barras(m.batidas, 24, 52, 6)}
        <div style="display:flex; justify-content:space-between; font-size:20px; color:var(--text-secondary);"><span>60m</span><span>agora</span></div>
      </div></div>`;
  }

  gradeCards(fora) {
    const cards = fora.map(m => {
      const novo = this.piscando && this.mudaram.indexOf(m.id) !== -1;
      return `<div style="background:rgba(245,61,61,.06); border:2px solid rgba(245,61,61,.35); border-radius:var(--r-card); padding:14px 18px; display:flex; flex-direction:column; gap:10px;${novo ? ' animation:cardPisca .9s ease-in-out infinite;' : ''}">
        <div style="display:flex; align-items:flex-start; gap:12px;">
          <h3 style="margin:0; flex:1 1 auto; font-size:30px; font-weight:800; letter-spacing:-.01em; line-height:1.15;">${m.nome}</h3>
          ${novo ? '<span class="wk-badge t-badge" style="background:var(--color-danger); color:#fff; font-size:16px; letter-spacing:.06em; white-space:nowrap; flex:0 0 auto;">mudou agora</span>' : ''}
        </div>
        <p style="margin:0; font-size:22px; font-weight:700; color:var(--color-danger);">${m.erro || 'Sem resposta'}</p>
        <div style="margin-top:auto;">${this.barras(m.batidas, 8, 34, 3)}</div></div>`;
    }).join('');
    return `<div style="background:var(--surface); padding:16px; display:grid; grid-template-columns:repeat(3, 1fr); gap:12px; border-top:1px solid var(--divider);">${cards}</div>`;
  }

  tudoOk() {
    const anim = this.piscando ? 'animation:okPisca 1s ease-in-out infinite;' : '';
    return `<div style="flex:0 0 auto; background:var(--surface); border-radius:var(--r-card); border:1px solid var(--divider); box-shadow:var(--shadow-card); padding:40px 36px; display:flex; align-items:center; gap:22px; ${anim}">
      <span style="width:22px; height:22px; border-radius:99px; background:var(--color-success);"></span>
      <p style="margin:0; font-size:44px; font-weight:800;">Todos os serviços operando normalmente</p></div>`;
  }

  lista(itens, resumo) {
    const linhas = itens.map(m => {
      const cor = m.down ? 'var(--color-danger)' : m.degradado ? 'var(--color-warning)' : 'var(--color-success)';
      const fundo = m.down ? 'rgba(245,61,61,.07)' : m.degradado ? 'rgba(255,165,0,.1)' : 'var(--surface)';
      const status = m.down ? 'Fora do ar' : m.degradado ? 'Degradado' : 'Normal';
      return `<div style="display:flex; align-items:center; gap:20px; padding:14px 28px; border-top:1px solid var(--divider); background:${fundo};">
        <div style="width:8px; align-self:stretch; border-radius:99px; background:${cor};"></div>
        <p style="margin:0; flex:1 1 auto; min-width:0; font-size:24px; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${m.nome}</p>
        <p style="margin:0; flex:0 0 auto; width:130px; font-size:20px; font-weight:700; color:${cor};">${status}</p>
        ${this.barras(m.batidas.slice(-22), 6, 26, 2)}</div>`;
    }).join('');

    return `<div style="flex:1 1 auto; min-height:0; display:flex; flex-direction:column; gap:12px;">
      <div style="display:flex; align-items:baseline; gap:20px;">
        <h2 style="margin:0; font-size:34px; font-weight:800;">Serviços</h2>
        <p style="margin:0; font-size:24px; color:var(--text-secondary);">${resumo}</p>
      </div>
      <div data-grade style="flex:1 1 auto; min-height:0; overflow:hidden; background:var(--divider); border-radius:var(--r-card); box-shadow:var(--shadow-card); border:1px solid var(--divider); display:grid; grid-template-columns:repeat(2, minmax(0,1fr)); column-gap:1px; align-content:start;">${linhas}</div>
    </div>`;
  }
}

window.Painel = Painel;
