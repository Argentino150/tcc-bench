/**
 * complementar.js
 * Testes complementares, acrescentados após a revisão do orientador.
 *
 * 1. Leitura por chave conhecida × leitura por posição (Web Storage)
 *    Isola o custo do algoritmo de enumeração. A leitura do experimento
 *    principal percorre o armazenamento por posição (key(i)); aqui ela é
 *    comparada com a recuperação direta de cada registro pela sua chave
 *    (getItem("bench:" + id)), com o mesmo conteúdo gravado.
 *
 * 2. Bloqueio da interface durante a gravação
 *    Mede quanto tempo a thread principal fica sem produzir quadros enquanto
 *    cada mecanismo grava 10.000 registros. Um laço de requestAnimationFrame
 *    registra o instante de cada quadro; o maior intervalo entre dois quadros
 *    consecutivos que se sobrepõe à gravação é o período em que a página não
 *    pôde ser redesenhada nem responder ao usuário. Onde o navegador oferece a
 *    Long Tasks API (Chromium), a soma das tarefas longas é registrada também.
 *
 * Ambos seguem o protocolo principal: 15 aquecimentos descartados e 30
 * medições válidas por cenário, com a ordem dos métodos alternada.
 */

import { gerarConjunto } from './dataset.js';

export const AQUEC_COMP = 15;
export const REP_COMP = 30;
export const VOLUMES_LEITURA = [1000, 10000];
export const VOLUME_BLOQUEIO = 10000;

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const proximoQuadro = () => new Promise((r) => requestAnimationFrame(() => r(performance.now())));

/* ------------------------------------------------------------------ */
/* 1. Leitura por chave conhecida × por posição                        */
/* ------------------------------------------------------------------ */

export async function testarLeitura(adaptadoresWS, aoProgredir, aoRegistrar) {
  const linhas = [];
  for (const volume of VOLUMES_LEITURA) {
    const registros = gerarConjunto(volume);
    const ids = registros.map((r) => r.id);
    for (const ad of adaptadoresWS) {
      await ad.limpar();
      await ad.gravar(registros);
      if (aoRegistrar) aoRegistrar(`Leitura — ${ad.nome}, ${volume} registros`);
      const total = AQUEC_COMP + REP_COMP;
      for (let exec = 1; exec <= total; exec++) {
        // Ordem alternada: posição primeiro nas execuções ímpares.
        const ordem = exec % 2 ? ['posicao', 'chave'] : ['chave', 'posicao'];
        const medida = {};
        for (const metodo of ordem) {
          await dormir(0);
          const t0 = performance.now();
          const dados = metodo === 'posicao' ? await ad.ler() : await ad.lerPorChave(ids);
          medida[metodo] = { tempo: performance.now() - t0, lidos: dados.length };
        }
        if (exec > AQUEC_COMP) {
          linhas.push({
            teste: 'leitura',
            mecanismo: ad.nome,
            volume,
            execucao: exec - AQUEC_COMP,
            leitura_posicao_ms: Number(medida.posicao.tempo.toFixed(4)),
            leitura_chave_ms: Number(medida.chave.tempo.toFixed(4)),
            lidos_posicao: medida.posicao.lidos,
            lidos_chave: medida.chave.lidos
          });
        }
        if (aoProgredir) aoProgredir();
      }
      await ad.limpar();
    }
  }
  return linhas;
}

/* ------------------------------------------------------------------ */
/* 1b. Leitura logo após a gravação × após uma pausa                   */
/* ------------------------------------------------------------------ */

/**
 * No experimento principal, a leitura começa na mesma tarefa do navegador em
 * que a gravação terminou, sem devolver o controle ao laço de eventos. Este
 * teste mede a leitura por posição nessas condições e depois de uma pausa
 * (setTimeout), além da leitura por chave após a pausa, regravando os dados
 * a cada execução, como no protocolo principal.
 */
export async function testarLeituraAposGravacao(adaptadoresWS, aoProgredir, aoRegistrar) {
  const linhas = [];
  const volume = 10000;
  const registros = gerarConjunto(volume);
  const ids = registros.map((r) => r.id);
  for (const ad of adaptadoresWS) {
    if (aoRegistrar) aoRegistrar(`Leitura após gravação — ${ad.nome}, ${volume} registros`);
    const total = AQUEC_COMP + REP_COMP;
    for (let exec = 1; exec <= total; exec++) {
      await ad.limpar();
      await dormir(0);
      await ad.gravar(registros);
      // Mesma tarefa da gravação, como no experimento principal.
      const t0 = performance.now();
      const imediata = await ad.ler();
      const tImediata = performance.now() - t0;
      await dormir(0);
      const ordem = exec % 2 ? ['posicao', 'chave'] : ['chave', 'posicao'];
      const m = {};
      for (const metodo of ordem) {
        const t1 = performance.now();
        const d = metodo === 'posicao' ? await ad.ler() : await ad.lerPorChave(ids);
        m[metodo] = { tempo: performance.now() - t1, lidos: d.length };
        await dormir(0);
      }
      if (exec > AQUEC_COMP) {
        linhas.push({
          teste: 'leitura_apos_gravacao',
          mecanismo: ad.nome,
          volume,
          execucao: exec - AQUEC_COMP,
          posicao_imediata_ms: Number(tImediata.toFixed(4)),
          posicao_apos_pausa_ms: Number(m.posicao.tempo.toFixed(4)),
          chave_apos_pausa_ms: Number(m.chave.tempo.toFixed(4)),
          lidos: Math.min(imediata.length, m.posicao.lidos, m.chave.lidos)
        });
      }
      if (aoProgredir) aoProgredir();
    }
    await ad.limpar();
  }
  return linhas;
}

/* ------------------------------------------------------------------ */
/* 2. Bloqueio da interface durante a gravação                         */
/* ------------------------------------------------------------------ */

function criarMonitorDeQuadros() {
  const quadros = [];
  let ativo = true;
  const laco = (t) => {
    quadros.push(performance.now());
    if (ativo) requestAnimationFrame(laco);
  };
  requestAnimationFrame(laco);
  return {
    quadros,
    parar() { ativo = false; }
  };
}

function criarMonitorDeTarefasLongas() {
  const suportado =
    typeof PerformanceObserver !== 'undefined' &&
    (PerformanceObserver.supportedEntryTypes || []).includes('longtask');
  if (!suportado) return { suportado: false, entradas: [], parar() {} };
  const entradas = [];
  const obs = new PerformanceObserver((lista) => entradas.push(...lista.getEntries()));
  obs.observe({ type: 'longtask', buffered: false });
  return {
    suportado: true,
    entradas,
    parar() {
      entradas.push(...obs.takeRecords());
      obs.disconnect();
    }
  };
}

/** Maior intervalo entre quadros consecutivos que se sobrepõe a [ini, fim]. */
function maiorIntervalo(quadros, ini, fim) {
  let maior = 0;
  for (let i = 1; i < quadros.length; i++) {
    const a = quadros[i - 1];
    const b = quadros[i];
    if (b >= ini && a <= fim) maior = Math.max(maior, b - a);
  }
  return maior;
}

/** Intervalo típico entre quadros (mediana) antes da operação. */
function intervaloBase(quadros, ini) {
  const gaps = [];
  for (let i = 1; i < quadros.length && quadros[i] < ini; i++) gaps.push(quadros[i] - quadros[i - 1]);
  if (!gaps.length) return null;
  gaps.sort((x, y) => x - y);
  return gaps[Math.floor(gaps.length / 2)];
}

export async function testarBloqueio(adaptadores, aoProgredir, aoRegistrar) {
  const linhas = [];
  const registros = gerarConjunto(VOLUME_BLOQUEIO);
  const total = AQUEC_COMP + REP_COMP;
  if (document.visibilityState !== 'visible') {
    throw new Error('Mantenha esta aba visível durante o teste de bloqueio da interface.');
  }
  for (let iv = 0; iv < adaptadores.length; iv++) {
    const ad = adaptadores[iv];
    if (aoRegistrar) aoRegistrar(`Bloqueio da interface — ${ad.nome}, ${VOLUME_BLOQUEIO} registros`);
    for (let exec = 1; exec <= total; exec++) {
      await ad.limpar();
      const monitor = criarMonitorDeQuadros();
      const tarefas = criarMonitorDeTarefasLongas();
      // Deixa a página produzir quadros antes da operação, para medir o ritmo normal.
      await dormir(150);
      await proximoQuadro();
      const ini = performance.now();
      await ad.gravar(registros);
      const fim = performance.now();
      // Garante que o primeiro quadro após a gravação seja registrado.
      await proximoQuadro();
      await proximoQuadro();
      monitor.parar();
      tarefas.parar();

      const base = intervaloBase(monitor.quadros, ini);
      const maior = maiorIntervalo(monitor.quadros, ini, fim);
      const longas = tarefas.entradas.filter((e) => e.startTime + e.duration >= ini && e.startTime <= fim);
      if (exec > AQUEC_COMP) {
        linhas.push({
          teste: 'bloqueio',
          mecanismo: ad.nome,
          volume: VOLUME_BLOQUEIO,
          execucao: exec - AQUEC_COMP,
          tempo_escrita_ms: Number((fim - ini).toFixed(4)),
          maior_intervalo_sem_quadro_ms: Number(maior.toFixed(4)),
          intervalo_normal_entre_quadros_ms: base == null ? null : Number(base.toFixed(4)),
          tarefas_longas_ms: tarefas.suportado
            ? Number(longas.reduce((s, e) => s + e.duration, 0).toFixed(4))
            : null,
          tarefas_longas_qtd: tarefas.suportado ? longas.length : null
        });
      }
      if (aoProgredir) aoProgredir();
    }
    await ad.limpar();
  }
  return linhas;
}
