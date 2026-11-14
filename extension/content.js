(() => {
  'use strict';
  if (window.__rsBagCleaner) return;
  window.__rsBagCleaner = true;

  // ---------- config ----------
  const TIERS = ['COMUM', 'INCOMUM', 'RARO', 'EPICO', 'LENDARIO', 'IMORTAL', 'ARCANO', 'EVENTO'];
  const EVENT = 7;                      // Evento: raridade à parte, vale como Épico na fusão
  const ARCANO = 6;                     // topo da cadeia, não tem tier acima
  const SHOW_ORDER = [0, 1, 2, 3, 7, 4, 5, 6]; // ordem das linhas no painel
  const TIER_LABEL = ['Comum', 'Incomum', 'Raro', 'Épico', 'Lendário', 'Imortal', 'Arcano', 'Evento'];
  const GEAR = ['ARMA', 'ELMO', 'ARMADURA', 'ANEL'];
  // acoes por tier: fav = favoritar e guardar | forge = forjar | sell = vender | skip = ignorar
  const DEFAULTS = {
    auto: false, dry: true, threshold: 45,
    act: ['forge', 'forge', 'forge', 'fav', 'fav', 'fav', 'fav', 'fav'],
    sellLeft: [true, true, true, false, false, false, false, false], // vender sobras de tiers em "forge"
    view: 'full', tab: 'rules', autoCollapse: true,   // view: full | compact | hidden
    scroll: ['none', 'none', 'none', 'none', 'none', 'none', 'none', 'none'], // pergaminho de sorte por tier
    eventAct: 'fav',                                    // itens de evento / visual especial: fav | tier | skip
  };
  let cfg = JSON.parse(JSON.stringify(DEFAULTS));
  let running = false;
  let stopFlag = false;
  let lastAuto = 0, lastCount = -1;
  const stopCheck = () => { if (stopFlag) throw new Error('Parado pelo usuário.'); };

  // ---------- helpers ----------
  // Espera que continua funcionando com a aba oculta ou a janela minimizada: o Chrome freia setTimeout
  // nesses casos, entao pedimos tambem ao service worker da extensao (que nao e freado) e vale o que responder primeiro.
  const sleep = (ms) => new Promise((r) => {
    let done = false; const fin = () => { if (!done) { done = true; r(); } };
    setTimeout(fin, ms);
    try { chrome.runtime.sendMessage({ rsbSleep: ms }, () => { void chrome.runtime.lastError; fin(); }); } catch (e) {}
  });
  const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
  const tierIdx = (s) => TIERS.indexOf(norm(s));
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const btn = (re, root = document) => $$('button', root).find((b) => re.test(norm(b.innerText)));
  async function waitFor(fn, timeout = 4000, step = 100) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { const v = fn(); if (v) return v; await sleep(step); }
    return null;
  }
  // memoria: no modo automatico, itens que ja foram lidos e nao precisam de nada nao sao clicados de novo.
  // Vale so se o item e unico na mochila (mesma aparencia + mesmo nivel), a regra nao mudou e faz menos de 20 min.
  // Modo manual sempre le tudo e atualiza a memoria. Para venda, so itens que NUNCA seriam vendidos sao pulados.
  const memo = new Map(), keep = new Map();
  let memoOn = false;
  const cfgKey = () => JSON.stringify([cfg.act, cfg.sellLeft, cfg.eventAct]);
  const MEMO_TTL = 20 * 60 * 1000;
  const bagItems = () => $$('.bag-grid .ibox').filter((b) => !b.closest('.forge-tab'));
  const sig = (el) => el.innerText.replace(/\s+/g, ' ').trim() + '|' + ((el.querySelector('img') || {}).src || '');
  const ikey = (el) => el.className.replace(/\b(sel|on|active|focus|selected)\b/g, '').replace(/\s+/g, ' ').trim() + '|' + sig(el);
  const keyCounts = () => { const m = new Map(); bagItems().forEach((e) => { const k = ikey(e); m.set(k, (m.get(k) || 0) + 1); }); return m; };
  const remembered = (map, k, cnt, ck) => { const v = memoOn && map.get(k); return !!(v && v.ck === ck && Date.now() - v.t < MEMO_TTL && cnt.get(k) === 1); };
  const remember = (map, i, ck) => { const el = bagItems()[i]; if (!el) return; if (map.size > 3000) map.clear(); map.set(ikey(el), { ck, t: Date.now() }); };

  // ---------- UI ----------
  const TIER_COLOR = ['#9aa0a6', '#52d68a', '#4da3ff', '#b66bff', '#ffa94d', '#ff5c5c', '#37e6d0', '#ff7ad9'];
  const ACTIONS = [
    { v: 'fav', t: 'Guardar (favoritar)' },
    { v: 'forge', t: 'Forjar' },
    { v: 'sell', t: 'Vender' },
    { v: 'skip', t: 'Ignorar' },
  ];

  const root = document.createElement('div');
  root.id = 'rsb-root';

  const tierRows = SHOW_ORDER.map((i) => { const name = TIER_LABEL[i]; return `
    <div class="rsb-tier" data-row="${i}">
      <div class="rsb-tier-top">
        <span class="rsb-dot" style="background:${TIER_COLOR[i]}"></span>
        <span class="rsb-tname">${name}</span>
        <select data-tier="${i}">
          ${ACTIONS.filter((a) => a.v !== 'forge' || i !== ARCANO)
            .map((a) => `<option value="${a.v}">${a.t}</option>`).join('')}
        </select>
      </div>
      <div class="rsb-hint" data-hint="${i}"></div>
      <div class="rsb-sub">
        <label title="Depois de forjar tudo o que dá, vende o que ficou sem grupo completo.">
          <input type="checkbox" data-left="${i}"> Vender o que sobrar
        </label>
      </div>
      <div class="rsb-scroll">
        <div class="rsb-scroll-title">Pergaminho de Sorte nesta forja</div>
        <select data-scroll="${i}">
          <option value="none">Não usar pergaminho</option>
          <option value="auto">Automático (usa o Grande, senão o de Sorte)</option>
          <option value="small">Pergaminho de Sorte: +10% de chance</option>
          <option value="big">Grande Pergaminho de Sorte: +20% de chance</option>
        </select>
        <div class="rsb-hint" style="margin-left:0">O pergaminho é gasto na tentativa, dando certo ou não. Se você escolher um específico e não tiver, a extensão não forja esse grupo.</div>
      </div>
    </div>`; }).join('');

  root.innerHTML = `
    <button id="rsb-launch" type="button">Bag Cleaner</button>
    <div id="rsb-compact">
      <span class="rsb-title">Bag Cleaner</span>
      <span id="rsb-badge2" class="rsb-badge"></span>
      <span id="rsb-status">Pronto</span>
      <button class="rsb-mini stop" id="rsb-stop" type="button" title="Para no próximo ponto seguro">Parar</button>
      <button class="rsb-mini" id="rsb-run2" type="button" title="Limpar a bolsa agora">Limpar</button>
      <button class="rsb-mini" id="rsb-expand" type="button" title="Abrir o painel">&#9633;</button>
      <button class="rsb-mini" id="rsb-hide2" type="button" title="Ocultar">&#x2715;</button>
    </div>
    <div id="rsb-panel">
      <div class="rsb-head">
        <div><span class="rsb-title">Bag Cleaner</span><span id="rsb-badge" class="rsb-badge"></span></div>
        <div class="rsb-head-btns">
          <button class="rsb-x" id="rsb-min" type="button" title="Minimizar para uma barra pequena">&#8211;</button>
          <button class="rsb-x" id="rsb-close" type="button" title="Ocultar (fica só o botão Bag Cleaner)">&#x2715;</button>
        </div>
      </div>

      <div class="rsb-tabs">
        <button class="rsb-tab" data-tab="rules" type="button">Regras</button>
        <button class="rsb-tab" data-tab="opts" type="button">Opções</button>
        <button class="rsb-tab" data-tab="help" type="button">Ajuda</button>
      </div>

      <div class="rsb-body">
        <div class="rsb-page" data-page="rules">
          <p class="rsb-intro">Escolha o que fazer com os itens de cada raridade. Vale para Arma, Elmo, Armadura e Anel.</p>
          ${tierRows}
        </div>

        <div class="rsb-page" data-page="opts">
          <div class="rsb-card">
            <h4>Itens com visual especial</h4>
            <p>Itens com a linha "Muda a aparência" (skins). Os itens da raridade Evento têm linha própria na aba Regras.</p>
            <select id="rsb-ev">
              <option value="fav">Guardar (favoritar e proteger)</option>
              <option value="tier">Seguir a regra do tier (podem ser forjados ou vendidos)</option>
              <option value="skip">Não mexer (fica protegido só nos tiers de Forjar/Vender)</option>
            </select>
          </div>

          <div class="rsb-card">
            <h4>Painel durante a execução</h4>
            <p>Recolhe o painel numa barra pequena enquanto a extensão trabalha, para ele não cobrir o jogo. Na barra há o botão Parar.</p>
            <label class="row"><input type="checkbox" id="rsb-ac"> Recolher o painel enquanto roda</label>
          </div>

          <div class="rsb-card">
            <h4>Modo simulação</h4>
            <p>Mostra no log o que seria feito, sem favoritar, forjar nem vender nada. Use antes de rodar de verdade.</p>
            <label class="row"><input type="checkbox" id="rsb-dry"> Ligar simulação</label>
          </div>

          <div class="rsb-card">
            <h4>Automático</h4>
            <p>Roda a limpeza sozinha quando a mochila enche. Só funciona com a simulação desligada.</p>
            <label class="row"><input type="checkbox" id="rsb-auto"> Ligar modo automático</label>
            <label class="row">Rodar quando a mochila tiver
              <input type="number" id="rsb-th" min="1" max="200" style="width:56px"> itens ou mais</label>
          </div>
        </div>

        <div class="rsb-page rsb-help" data-page="help">
          <h4>O que cada ação faz</h4>
          <ul>
            <li><b>Guardar (favoritar):</b> o item fica favoritado e protegido. Não é forjado nem vendido.</li>
            <li><b>Forjar:</b> junta itens iguais (mesmo tier e mesmo tipo) e sobe um tier. A extensão tira o favorito desses itens antes, porque favorito não aparece na forja.</li>
            <li><b>Vender:</b> vende tudo daquele tier que não esteja favoritado nem tenha gema.</li>
            <li><b>Ignorar:</b> a extensão não mexe nesse tier.</li>
          </ul>

          <h4>Vender o que sobrar</h4>
          <p>Aparece nos tiers em "Forjar". A forja precisa de 3 ou 4 itens iguais. Se depois de forjar tudo ainda ficarem 1 ou 2 itens sem par, eles são as sobras. Com a opção marcada, as sobras são vendidas. Desmarcada, elas ficam na mochila esperando completar um grupo.</p>

          <h4>Forjas de risco e pergaminhos</h4>
          <p>Nos tiers altos (a partir de Épico) a forja tem uma roleta: se cair no vermelho, todos os itens da fusão são perdidos. A extensão só forja um tier se você deixar ele em "Forjar".</p>
          <p>Os <b>Pergaminhos de Sorte</b> aumentam a chance de sucesso: o de Sorte dá <b>+10%</b> e o Grande dá <b>+20%</b>. Em cada tier você escolhe: não usar, <b>automático</b> (usa o Grande se tiver, senão o de Sorte, senão forja sem), ou um pergaminho específico. Se escolher um específico e não tiver, o grupo é pulado.</p>

          <h4>Raridade Evento</h4>
          <p>Itens Evento valem como Épico na fusão e podem ser misturados com Épicos. Na linha Evento você escolhe: Guardar (favoritar), Forjar (entra nas fusões de Épico), Vender ou Ignorar. Para eles entrarem na forja, o Épico também precisa estar em Forjar.</p>

          <h4>Ordem da limpeza</h4>
          <ul>
            <li>1. Ajusta os favoritos de cada tier.</li>
            <li>2. Forja os grupos completos.</li>
            <li>3. Confere os favoritos de novo (o item novo segue a regra do tier dele).</li>
            <li>4. Vende o que está marcado para vender.</li>
          </ul>

          <h4>Dicas</h4>
          <ul>
            <li>Rode primeiro em <b>simulação</b>.</li>
            <li>Deixe a aba do personagem aberta e não clique no jogo enquanto ela roda.</li>
            <li>Itens com gema engastada nunca são forjados nem vendidos.</li>
          </ul>
        </div>
      </div>

      <div class="rsb-actions">
        <button class="rsb-btn main" id="rsb-run" type="button">Limpar bolsa agora</button>
        <button class="rsb-btn" id="rsb-fav" type="button">Só ajustar favoritos</button>
        <button class="rsb-btn stop" id="rsb-stop2" type="button">Parar</button>
      </div>
      <pre id="rsb-log"></pre>
    </div>`;
  document.body.appendChild(root);

  const $ = (q) => root.querySelector(q);
  const logEl = $('#rsb-log');
  const log = (m) => {
    logEl.textContent += m + '\n'; logEl.scrollTop = logEl.scrollHeight; console.log('[BagCleaner]', m);
    const st = $('#rsb-status'); if (st) { st.textContent = String(m).replace(/^-+\s*/, '').split('\n')[0]; st.title = st.textContent; }
  };

  const setStep = (t) => { const st = $('#rsb-status'); if (st) { st.textContent = t; st.title = t; } };

  function hintFor(i) {
    const act = cfg.act[i], name = TIER_LABEL[i], next = TIER_LABEL[i + 1];
    if (act === 'fav') return 'Fica favoritado e protegido: não é forjado nem vendido.';
    if (act === 'forge' && i === EVENT) return 'Entra nas fusões de Épico como se fosse Épico. Só vale se o Épico também estiver em Forjar.';
    if (act === 'sell' && i === EVENT) return 'Vende os itens Evento sem favorito. Se o Épico estiver em Forjar, eles entram na fusão antes.';
    if (act === 'forge') {
      return `Junta itens iguais e sobe para ${next}. ` +
        (cfg.sellLeft[i] ? 'O que sobrar é vendido.' : 'O que sobrar fica na mochila.');
    }
    if (act === 'sell') return `Vende todo ${name} sem favorito e sem gema.`;
    return 'A extensão não mexe nesse tier.';
  }

  function save() { try { chrome.storage.local.set({ rsbCfg: cfg }); } catch (e) {} }
  function setTab(name) {
    cfg.tab = name;
    $$('.rsb-tab', root).forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    $$('.rsb-page', root).forEach((p) => p.classList.toggle('on', p.dataset.page === name));
  }
  function syncUI() {
    $('#rsb-ev').value = cfg.eventAct;
    $('#rsb-dry').checked = cfg.dry;
    $('#rsb-auto').checked = cfg.auto;
    $('#rsb-th').value = cfg.threshold;
    $$('select[data-tier]', root).forEach((sel) => { sel.value = cfg.act[+sel.dataset.tier]; });
    $$('input[data-left]', root).forEach((c) => { c.checked = !!cfg.sellLeft[+c.dataset.left]; });
    $$('.rsb-tier', root).forEach((row) => {
      const i = +row.dataset.row;
      row.classList.toggle('is-forge', cfg.act[i] === 'forge');
      row.classList.toggle('no-scroll', i === EVENT || i < 3);
      const sc = row.querySelector('[data-scroll]'); if (sc) sc.value = cfg.scroll[i];
      row.querySelector('[data-hint]').textContent = hintFor(i);
    });
    const badge = $('#rsb-badge');
    badge.textContent = cfg.dry ? 'SIMULAÇÃO' : 'VALENDO';
    badge.className = 'rsb-badge ' + (cfg.dry ? 'sim' : 'real');
    $('#rsb-ac').checked = cfg.autoCollapse;
    const view = running && cfg.autoCollapse ? 'compact' : cfg.view;
    root.dataset.view = view;
    root.classList.toggle('rsb-running', running);
    ['#rsb-run', '#rsb-run2', '#rsb-fav'].forEach((q) => { $(q).disabled = running; });
    $('#rsb-stop').disabled = $('#rsb-stop2').disabled = !running;
    $$('#rsb-panel select, #rsb-panel input', root).forEach((el) => { el.disabled = running; });
    ['#rsb-badge2'].forEach((q) => { $(q).textContent = badge.textContent; $(q).className = badge.className; });
    setTab(cfg.tab || 'rules');
  }

  root.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.tier !== undefined) cfg.act[+t.dataset.tier] = t.value;
    else if (t.dataset.left !== undefined) cfg.sellLeft[+t.dataset.left] = t.checked;
    else if (t.dataset.scroll !== undefined) cfg.scroll[+t.dataset.scroll] = t.value;
    else if (t.id === 'rsb-ev') cfg.eventAct = t.value;
    else if (t.id === 'rsb-ac') cfg.autoCollapse = t.checked;
    else if (t.id === 'rsb-dry') cfg.dry = t.checked;
    else if (t.id === 'rsb-auto') {
      cfg.auto = t.checked;
      if (cfg.auto && cfg.dry) log('Aviso: o automático só age com a simulação desligada.');
    } else if (t.id === 'rsb-th') cfg.threshold = Math.max(1, +t.value || 45);
    save(); syncUI();
  });
  root.addEventListener('click', (e) => {
    const tab = e.target.closest('.rsb-tab');
    if (tab) { setTab(tab.dataset.tab); $('.rsb-body').scrollTop = 0; save(); }
  });
  const setView = (v) => { cfg.view = v; save(); syncUI(); };
  $('#rsb-min').onclick = () => setView('compact');
  $('#rsb-close').onclick = () => setView('hidden');
  $('#rsb-hide2').onclick = () => setView('hidden');
  $('#rsb-expand').onclick = () => setView('full');
  $('#rsb-launch').onclick = () => setView('full');
  const doStop = () => { stopFlag = true; log('Parando no próximo ponto seguro...'); };
  $('#rsb-stop').onclick = doStop;
  $('#rsb-stop2').onclick = doStop;
  $('#rsb-run2').onclick = () => run('manual');
  $('#rsb-run').onclick = () => run('manual');
  $('#rsb-fav').onclick = () => run('favs');

  // ---------- game access ----------
  const goBag = async (needItems = true) => {
    const b = btn(/^MOCHILA/); if (b && !b.classList.contains('on')) b.click();
    const ok = await waitFor(() => btn(/^MOCHILA/)?.classList.contains('on') && !document.querySelector('.forge-tab') && (!needItems || bagItems().length > 0), 4000);
    if (!ok) throw new Error('Não consegui abrir a mochila.');
  };
  const goForge = async () => {
    const b = btn(/^FORJA/); if (b && !b.classList.contains('on')) b.click();
    const ok = await waitFor(() => btn(/^FORJA/)?.classList.contains('on') && document.querySelector('.forge-tab'), 4000);
    if (!ok) throw new Error('Não consegui abrir a forja.');
    await sleep(200);
  };
  const bagCount = () => {
    const b = btn(/^MOCHILA/); const m = b && b.innerText.match(/(\d+)\s*\/\s*(\d+)/);
    return m ? { n: +m[1], max: +m[2] } : null;
  };

  // o jogo atualiza a tela de tempos em tempos e pode limpar o painel de detalhes,
  // por isso cada leitura confere se o painel é mesmo do item clicado e tenta de novo se não for
  async function inspect(i) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const it = bagItems()[i]; if (!it) return null;
      it.click();
      await sleep(220);
      const d = document.querySelector('aside.detail');
      const tag = d && d.querySelector('.rtag');
      if (!tag) {
        // consumiveis (pergaminhos etc.) nao tem raridade nem favorito: o painel diz "Consumivel · xN" com o mesmo xN da caixinha
        const lvT = String((it.querySelector('.lv') || {}).innerText || '').trim();
        if (d && !d.querySelector('.fav-btn') && /CONSUMIVEL/.test(norm(d.innerText)) && lvT && d.innerText.includes(lvT)) {
          return { i, sig: sig(it), tier: -1, slot: null, gems: 0, cosmetic: false, favBtn: null, fav: false, cons: true };
        }
        await sleep(200); continue;
      }
      // o painel precisa mostrar o mesmo nivel que a caixinha do item clicada
      const lv = (it.querySelector('.lv') || {}).innerText;
      const dv = (d.innerText.match(/Nv\.\s*(\d+)/) || [])[1];
      if (lv && dv && String(lv).trim() !== dv) { await sleep(250); continue; }
      await sleep(120); // segunda leitura: a linha de gemas pode chegar um pouco depois
      const tag2 = d.querySelector('.rtag');
      const txt = d.innerText;
      const dv2 = (txt.match(/Nv\.\s*(\d+)/) || [])[1];
      if (!tag2 || (lv && dv2 && String(lv).trim() !== dv2)) { await sleep(250); continue; }   // o painel trocou de item no meio da leitura
      if (/ENGASTES/i.test(txt) && !/(\d+)\s*\/\s*\d+\s*ocupados/i.test(txt)) { await sleep(300); continue; } // gemas ainda carregando
      const slotM = norm(txt).match(/\b(ARMA|ELMO|ARMADURA|ANEL)\b\s*·\s*NV/);
      const gem = txt.match(/(\d+)\s*\/\s*\d+\s*ocupados/i);
      const fav = d.querySelector('.fav-btn');
      return {
        i, sig: sig(it), tier: tierIdx(tag2.innerText), slot: slotM ? slotM[1] : null, gems: gem ? +gem[1] : 0,
        cosmetic: /muda a aparencia/i.test(norm(txt)),      // item com visual especial
        favBtn: fav, fav: !!(fav && fav.classList.contains('on')),
      };
    }
    return null;
  }

  async function setFav(info, want) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let f = document.querySelector('aside.detail .fav-btn');
      if (!f) { info = await inspect(info.i); if (!info || !info.favBtn) return false; f = info.favBtn; }
      if (!!f.classList.contains('on') === want) return true;
      f.click();
      const ok = await waitFor(() => { const n = document.querySelector('aside.detail .fav-btn'); return n && !!n.classList.contains('on') === want; }, 1500, 150);
      if (ok) return true;
    }
    return false;
  }

  // acao efetiva de um tier (protege contra combinacoes que perderiam itens Evento)
  function effAct(tier) {
    const a = cfg.act[tier];
    if (tier === EVENT && a === 'forge' && cfg.act[3] !== 'forge') return 'fav'; // sem Épico em Forjar, Evento não entra em fusão
    if (tier === EVENT && a === 'skip' && cfg.act[3] === 'forge') return 'fav';  // senão a fusão de Épico consumiria os Evento
    return a;
  }

  // ---------- favoritos: aplica a regra de cada tier ----------
  // fav        -> garante favorito
  // forge/sell -> garante SEM favorito (favorito some da forja e da venda)
  async function syncFavorites() {
    await goBag();
    let on = 0, off = 0, fail = 0;
    const n = bagItems().length;
    const ck = cfgKey(), cnt = keyCounts(), keys = bagItems().map(ikey);
    let known = 0;
    for (let i = 0; i < n; i++) {
      stopCheck();
      if (remembered(memo, keys[i], cnt, ck)) { known++; continue; }
      const info = await inspect(i);
      if (!info) { fail++; continue; }                       // não consegui ler: conta como falha e aborta antes de forjar/vender
      const f0 = fail;
      item: {
        if (info.tier < 0 || !info.favBtn) break item;
        const act = effAct(info.tier);
        const gear = GEAR.includes(info.slot);
        if (info.cosmetic && cfg.eventAct !== 'tier') {
          if (cfg.eventAct === 'skip' && act !== 'forge' && act !== 'sell') break item;   // em tier de forja/venda ele é protegido
          if (!info.fav) { if (cfg.dry) on++; else if (await setFav(info, true)) on++; else fail++; }
          break item;
        }
        if (act === 'fav' && !info.fav && gear) {
          if (cfg.dry) on++; else if (await setFav(info, true)) on++; else fail++;
        } else if ((act === 'forge' || act === 'sell') && info.fav && gear && info.gems === 0) {
          if (cfg.dry) off++; else if (await setFav(info, false)) off++; else fail++;
        }
      }
      if (fail === f0 && !cfg.dry) remember(memo, i, ck);
    }
    if (known) log(`${known} itens já conhecidos, não precisei reler.`);
    log(`${cfg.dry ? '[sim] ' : ''}Favoritados: ${on} | Desfavoritados: ${off}${fail ? ' | falhas: ' + fail : ''}`);
    if (cfg.dry && off) log('[sim] Esses favoritos seriam removidos, então entrariam na forja/venda numa execução de verdade.');
    return { on, off, fail };
  }

  // ---------- forjar ----------
  function readGroups() {
    return $$('.forge-group').map((g) => {
      const t = norm(g.querySelector('h3').innerText);
      const m = t.match(/^(\w+)\s*·\s*(\w+)\s*➜\s*(\w+)\s*·\s*(\d+)\s*\/\s*(\d+)/);
      if (!m) return null;
      return { el: g, from: tierIdx(m[1]), slot: m[2], have: +m[4], need: +m[5], first: g.querySelector('.ibox') };
    }).filter(Boolean);
  }
  const skipped = new Set(); // grupos pulados nesta rodada (ex.: falta o pergaminho escolhido)
  const gkey = (x) => x.from + ':' + x.slot;
  const forgeable = (x) => x.from >= 0 && x.from < ARCANO && cfg.act[x.from] === 'forge' && x.have >= x.need && x.first && !skipped.has(gkey(x));
  // Pergaminhos de Sorte: botoes .scroll-opt na janela da forja ("+10% . voce tem 7")
  function scrollOption(kind) {
    const re = kind === 'big' ? /\+20%/ : /\+10%/;
    return $$('.modal-body .scroll-opt').find((b) => {
      const t = norm(b.innerText.replace(/\s+/g, ' '));
      const have = (t.match(/VOCE TEM\s*(\d+)/) || [])[1];
      return re.test(t) && have !== undefined && +have > 0;
    });
  }
  async function pickScroll(kind) {
    const o = scrollOption(kind);
    if (!o) return false;
    if (!o.classList.contains('on')) { o.click(); await sleep(400); }
    const now = scrollOption(kind);
    return !!(now && now.classList.contains('on'));
  }
  // mode: none | small | big | auto (auto: Grande primeiro, depois o de Sorte, senao forja sem)
  async function applyScroll(mode) {
    if (mode === 'none') { // garante "Sem pergaminho", caso o jogo lembre a escolha anterior
      const none = $$('.modal-body .scroll-opt').find((b) => /^SEM PERGAMINHO/.test(norm(b.innerText)));
      if (none && !none.classList.contains('on')) { none.click(); await sleep(400); }
      return { used: null, ok: true };
    }
    for (const k of mode === 'auto' ? ['big', 'small'] : [mode]) {
      if (await pickScroll(k)) return { used: k, ok: true };
    }
    return { used: null, ok: mode === 'auto' };
  }
  // fecha qualquer janela aberta e sai do modo de venda, sem clicar em nada a toa
  async function closeAll() {
    for (let k = 0; k < 6; k++) {
      const m = document.querySelector('.modal-body'); if (!m) break;
      const scope = m.closest('.modal, [role=dialog]') || m.parentElement || document;
      const b = $$('button', scope).find((x) => !x.disabled && /^(CONTINUAR|CANCELAR|FECHAR)/.test(norm(x.innerText)));
      if (b) b.click(); else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(500);
    }
    if (btn(/^VENDER SELECIONADOS/)) btn(/^CANCELAR$/)?.click();   // so sai do modo de venda se ele estiver aberto
  }
  const closeModal = () => closeAll();

  async function forgeAll() {
    if (!cfg.act.some((a, i) => a === 'forge' && i < ARCANO)) return 0;
    skipped.clear();
    let done = 0, failed = 0;
    for (let guard = 0; guard < 120; guard++) {
      stopCheck();
      await goForge();
      const g = readGroups().find(forgeable);
      if (!g) break;
      if (cfg.dry) break;
      g.first.click();
      let ok = await waitFor(() => btn(/^FORJAR(\s|\(|$)/), 2500);
      if (!ok) {
        ['mousedown', 'mouseup', 'click'].forEach((t) => g.first.dispatchEvent(new MouseEvent(t, { bubbles: true })));
        ok = await waitFor(() => btn(/^FORJAR(\s|\(|$)/), 2500);
      }
      if (!ok) { log('Janela da forja não abriu, parando.'); await closeAll(); break; }
      if (ok.disabled) { log('Forja indisponível (ouro insuficiente?), parando.'); await closeAll(); break; }
      // pergaminho de sorte (so nos tiers onde voce escolheu usar)
      const sc = await applyScroll(cfg.scroll[g.from]);
      if (!sc.ok) {
        log(`Pulei ${TIER_LABEL[g.from]} ${g.slot}: sem o pergaminho escolhido.`);
        skipped.add(gkey(g)); await closeAll(); await sleep(300); continue;
      }
      if (cfg.scroll[g.from] !== 'none') log(`${TIER_LABEL[g.from]} ${g.slot}: ${sc.used ? 'pergaminho ' + (sc.used === 'big' ? 'Grande (+20%)' : 'de Sorte (+10%)') : 'sem pergaminho disponível, forjando sem'}.`);
      if (stopFlag) { await closeAll(); stopCheck(); }   // ultimo ponto seguro, antes de gastar o item
      const fb = btn(/^FORJAR(\s|\(|$)/);
      if (!fb) { log('Botão FORJAR sumiu, parando.'); await closeAll(); break; }
      fb.click();
      // Depois do clique: "FORJANDO..." (roleta nas forjas de risco), tela de resultado com CONTINUAR
      // e, se der certo, uma segunda tela revelando o item (tambem com CONTINUAR).
      let sawResult = false, failedNow = false, firstScreen = true;
      const t0 = Date.now();
      while (Date.now() - t0 < 45000) {
        const mb = document.querySelector('.modal-body');
        if (!mb) break;
        const cont = $$('button', mb).find((b) => !b.disabled && /^CONTINUAR/.test(norm(b.innerText)));
        if (cont) {
          const head = norm(mb.innerText).split('\n')[0] || '';
          if (firstScreen) {
            firstScreen = false;
            if (!/SUCEDIDA|CONCLUIDA/.test(head)) { failedNow = true; log('Resultado da forja: ' + head.slice(0, 60)); }
          }
          sawResult = true;
          cont.click();
          await sleep(700);
        } else await sleep(300);
      }
      if (!sawResult) { log('A forja não confirmou, parando.'); await closeAll(); break; }
      if (document.querySelector('.modal-body')) { log('A janela da forja não fechou, parando.'); await closeAll(); break; }
      if (failedNow) failed++;
      done++;
      await sleep(500);
    }
    if (cfg.dry) {
      await goForge();
      const gs = readGroups().filter(forgeable);
      const n = gs.reduce((a, x) => a + Math.floor(x.have / x.need), 0);
      log(`[sim] Forjas possíveis agora: ${n}` + gs.map((x) => `\n  ${TIER_LABEL[x.from]} ${x.slot}: ${x.have}/${x.need}`).join(''));
      return n;
    }
    log(`Forjas feitas: ${done}${failed ? ' (falharam: ' + failed + ')' : ''}`);
    return done;
  }

  // ---------- vender ----------
  // grupos que ainda estao completos na forja (nao forjados): nao sao "sobras", nao podem ser vendidos
  async function completeGroups() {
    await goForge();
    return new Set(readGroups().filter((x) => x.have >= x.need).map((x) => x.from + ':' + x.slot));
  }
  function shouldSell(info, prot) {
    if (!info || (info.cosmetic && cfg.eventAct !== 'tier') || info.tier < 0 || info.fav || info.gems > 0 || !GEAR.includes(info.slot)) return false;
    const a = effAct(info.tier);
    if (a === 'sell') return true;
    if (a !== 'forge' || !cfg.sellLeft[info.tier]) return false;
    const gt = info.tier === EVENT ? 3 : info.tier;            // Evento conta como Épico na forja
    return !prot.has(gt + ':' + info.slot);
  }
  // true se o item PODERIA ser vendido em alguma rodada (ignora a protecao de grupos completos)
  function couldSell(info) {
    if (!info || (info.cosmetic && cfg.eventAct !== 'tier') || info.tier < 0 || info.fav || info.gems > 0 || !GEAR.includes(info.slot)) return false;
    const a = effAct(info.tier);
    return a === 'sell' || (a === 'forge' && !!cfg.sellLeft[info.tier]);
  }
  async function sellLeftovers(prot) {
    await goBag();
    const n = bagItems().length;
    const sell = [];
    const ck = cfgKey(), cnt = keyCounts(), keys = bagItems().map(ikey);
    for (let i = 0; i < n; i++) {
      stopCheck();
      if (remembered(keep, keys[i], cnt, ck)) continue;       // item que nunca seria vendido (favorito, com gema, tier guardado...)
      const info = await inspect(i);
      if (!info) { log('Não consegui ler todos os itens, venda cancelada por segurança.'); return 0; }
      if (shouldSell(info, prot)) sell.push({ i, sig: info.sig });
      else if (!couldSell(info)) remember(keep, i, ck);
    }
    if (!sell.length) { log('Nada para vender.'); return 0; }
    if (cfg.dry) { log(`[sim] Itens que seriam vendidos agora: ${sell.length} (estimativa mínima: não conta as sobras que surgiriam depois das forjas)`); return sell.length; }

    // a bolsa precisa estar igual a quando os itens foram lidos
    const same = () => bagItems().length === n && sell.every((x) => bagItems()[x.i] && sig(bagItems()[x.i]) === x.sig);
    if (!same()) { log('A bolsa mudou durante a leitura, venda cancelada por segurança. Rode de novo.'); return 0; }

    btn(/^SELECIONAR PARA VENDER/)?.click();
    const sellBtn = await waitFor(() => btn(/^VENDER SELECIONADOS/), 3000);
    if (!sellBtn) { log('Modo de venda não abriu, parando.'); await closeAll(); return 0; }
    for (const x of sell) {
      if (stopFlag) { await closeAll(); stopCheck(); }
      bagItems()[x.i]?.click();
      await sleep(120);
    }
    // confere que os itens marcados sao exatamente os planejados
    const marked = bagItems().map((el, i) => (/(^|\s)sel(\s|$)/.test(el.className) ? i : -1)).filter((i) => i >= 0);
    const planned = sell.map((x) => x.i);
    const label = btn(/^VENDER SELECIONADOS/);
    const count = label ? +(norm(label.innerText).match(/\((\d+)\)/) || [])[1] : NaN;
    if (!same() || count !== sell.length || marked.length !== planned.length || marked.some((m, k) => m !== planned[k])) {
      log(`Seleção divergente (${count} marcados de ${sell.length}), cancelando por segurança.`);
      await closeAll();
      return 0;
    }
    if (stopFlag) { await closeAll(); stopCheck(); }
    label.click();
    const conf = await waitFor(() => $$('.modal-body button').find((b) => /^VENDER$/.test(norm(b.innerText))), 4000);
    if (!conf) { log('A confirmação da venda não abriu, nada foi vendido.'); await closeAll(); return 0; }
    conf.click();
    const closed = await waitFor(() => !document.querySelector('.modal-body') && !btn(/^VENDER SELECIONADOS/), 4000);
    if (!closed) { log('Não consegui confirmar a venda, conferindo a tela.'); await closeAll(); return 0; }
    log(`Vendidos: ${sell.length}`);
    return sell.length;
  }

  // ---------- orquestração ----------
  async function run(mode) {
    memoOn = mode === 'auto';
    if (running) return;
    if (document.querySelector('.modal-body') || btn(/^VENDER SELECIONADOS/)) { log('Há uma janela ou o modo de venda aberto no jogo. Feche e tente de novo.'); return; }
    running = true; stopFlag = false; syncUI();
    const c = bagCount();
    log(`--- ${mode === 'auto' ? 'Auto' : mode === 'favs' ? 'Favoritos' : 'Manual'}${cfg.dry ? ' (simulação)' : ''} | mochila ${c ? c.n + '/' + c.max : '?'}`);
    const must = (r) => { if (r.fail) throw new Error(`${r.fail} falha(s) ao ajustar favoritos, parei antes de forjar ou vender.`); };
    try {
      setStep('1/4 Ajustando favoritos');
      must(await syncFavorites());      // 1. tira favorito de quem vai forjar/vender, põe em quem fica
      if (mode !== 'favs') {
        stopCheck(); setStep('2/4 Forjando');
        await forgeAll();               // 2. forja (favorito não entra, por isso o passo 1)
        stopCheck(); setStep('3/4 Conferindo favoritos');
        must(await syncFavorites());    // 3. revalida: resultado novo recebe a regra do seu tier
        stopCheck(); setStep('4/4 Vendendo');
        const prot = await completeGroups();   // grupos completos que não foram forjados não são sobras
        await sellLeftovers(prot);      // 4. vende sobras / tiers marcados como vender
      }
      await goBag(false);
      const e = bagCount(); log(`Fim. Mochila ${e ? e.n + '/' + e.max : '?'}`);
    } catch (err) {
      log(stopFlag ? 'Parado pelo usuário.' : 'Erro: ' + err.message);
      if (stopFlag && mode === 'auto') { cfg.auto = false; save(); log('Modo automático desligado porque você parou a execução.'); }
    } finally {
      lastAuto = Date.now(); const bc = bagCount(); if (bc) lastCount = bc.n;
      try { await closeAll(); } catch (e) {}   // sempre deixa a tela do jogo limpa
      running = false; stopFlag = false; syncUI();
    }
  }

  // ---------- auto ----------
  const autoTick = () => {
    if (!cfg.auto || cfg.dry || running) return;
    if (document.querySelector('.modal-body') || btn(/^VENDER SELECIONADOS/)) return;  // voce esta usando o jogo
    const c = bagCount();
    if (!c || c.n < cfg.threshold) return;
    if (lastCount >= 0 && c.n < lastCount + 5) return;                              // só roda de novo quando entraram 5+ itens desde a última limpeza
    lastAuto = Date.now();
    run('auto');
  };
  (async () => { for (;;) { await sleep(15000); try { autoTick(); } catch (e) {} } })();

  // ---------- init ----------
  try {
    chrome.storage.local.get('rsbCfg', (r) => {
      const s = r && r.rsbCfg;
      if (s && Array.isArray(s.act)) {
        cfg = { ...DEFAULTS, ...s };
        const fit = (arr, fill) => { arr = Array.isArray(arr) ? arr.slice(0, TIERS.length) : []; while (arr.length < TIERS.length) arr.push(fill); return arr; };
        cfg.act = fit(cfg.act, 'fav'); cfg.sellLeft = fit(cfg.sellLeft, false); cfg.scroll = fit(cfg.scroll, 'none');
        if (!['fav', 'tier', 'skip'].includes(cfg.eventAct)) cfg.eventAct = 'fav';
        if (s.open === false && !s.view) cfg.view = 'hidden';
        if (!['full', 'compact', 'hidden'].includes(cfg.view)) cfg.view = 'full';
        if (!['rules', 'opts', 'help'].includes(cfg.tab)) cfg.tab = 'rules';
        cfg.threshold = Math.max(1, +cfg.threshold || 45);
        if (cfg.act[ARCANO] === 'forge') cfg.act[ARCANO] = 'fav';
      }
      syncUI();
    });
  } catch (e) {}
  syncUI();
})();
