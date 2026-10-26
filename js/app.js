/**
 * app.js
 * Orquestração da interface e exportação dos dados coletados.
 */

import { criarAdaptadores } from './adapters.js';
import {
  executarExperimento,
  medirVolumeMaximo,
  VOLUMES,
  AQUECIMENTOS,
  REPETICOES
} from './benchmark.js';
import { gerarConjunto, validarConjunto, TAMANHO_REGISTRO_BYTES } from './dataset.js';

const $ = (sel) => document.querySelector(sel);

/**
 * Teto do teste de volume máximo, em registros. O IndexedDB pode receber uma
 * cota de vários gigabytes; sem um teto, a inserção progressiva levaria dezenas
 * de minutos. 1.000.000 de registros equivalem a 256 MB de conteúdo.
 */
const TETO_REGISTROS = 1000000;

const elLog = $('#log');
const elBarra = $('#barra');
const elStatus = $('#status');
const elAmbiente = $('#ambiente');
const elResultados = $('#resultados');

let ultimosResultados = null;
let ultimoVolumeMaximo = null;
let ultimaPersistencia = null;
let ocupado = false;

const BOTOES_LONGOS = ['#btn-executar', '#btn-volume', '#btn-verificar', '#btn-persistir'];

/**
 * Impede que uma segunda execução seja disparada enquanto a primeira está em
 * andamento. Sem essa trava, dois cliques produzem duas medições concorrentes
 * que limpam o armazenamento uma da outra e invalidam os resultados.
 */
function travar(valor) {
  ocupado = valor;
  for (const sel of BOTOES_LONGOS) {
    const b = $(sel);
    if (b) b.disabled = valor;
  }
  document.body.style.cursor = valor ? 'progress' : '';
}

function registrar(msg) {
  const linha = document.createElement('div');
  linha.textContent = `[${new Date().toLocaleTimeString('pt-BR')}] ${msg}`;
  elLog.appendChild(linha);
  elLog.scrollTop = elLog.scrollHeight;
}

function progresso(feito, total) {
  const pct = total ? Math.round((feito / total) * 100) : 0;
  elBarra.style.width = `${pct}%`;
  elBarra.textContent = `${pct}%`;
}

/* ---------------- ambiente de execução ---------------- */

function coletarAmbiente() {
  const nav = navigator;
  return {
    userAgent: nav.userAgent,
    plataforma: nav.userAgentData?.platform ?? nav.platform ?? 'não informado',
    nucleosLogicos: nav.hardwareConcurrency ?? 'não informado',
    memoriaAproximadaGB: nav.deviceMemory ?? 'não informado',
    idioma: nav.language,
    online: nav.onLine,
    dataHora: new Date().toISOString(),
    tamanhoRegistroBytes: TAMANHO_REGISTRO_BYTES,
    volumes: VOLUMES,
    aquecimentos: AQUECIMENTOS,
    repeticoes: REPETICOES
  };
}

function mostrarAmbiente() {
  const amb = coletarAmbiente();
  elAmbiente.textContent = Object.entries(amb)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
    .join('\n');
}

/* ---------------- exportação ---------------- */

function paraCSV(linhas) {
  if (!linhas.length) return '';
  const colunas = Object.keys(linhas[0]);
  const corpo = linhas.map((l) =>
    colunas.map((c) => (l[c] === null || l[c] === undefined ? '' : l[c])).join(',')
  );
  return [colunas.join(','), ...corpo].join('\n');
}

function baixar(nome, conteudo, tipo = 'text/plain;charset=utf-8') {
  const blob = new Blob([conteudo], { type: tipo });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nome;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ---------------- ações ---------------- */

async function rodarExperimento() {
  elResultados.textContent = '';
  elLog.textContent = '';
  const adaptadores = criarAdaptadores();

  const cenarios = VOLUMES.length * adaptadores.length;
  const execucoesPorCenario = AQUECIMENTOS + REPETICOES;
  const totalExecucoes = cenarios * execucoesPorCenario;
  let feito = 0;

  elStatus.textContent = 'Executando...';
  registrar(
    `Início: ${cenarios} cenários × ${execucoesPorCenario} execuções ` +
      `(${AQUECIMENTOS} de aquecimento descartadas).`
  );

  const t0 = performance.now();
  const { resultados, ocorrencias } = await executarExperimento(
    adaptadores,
    () => progresso(++feito, totalExecucoes),
    registrar
  );
  const duracao = ((performance.now() - t0) / 1000).toFixed(1);

  ultimosResultados = { ambiente: coletarAmbiente(), resultados, ocorrencias };

  registrar(`Concluído em ${duracao}s. ${resultados.length} medições válidas.`);
  if (ocorrencias.length) {
    registrar(`Ocorrências: ${ocorrencias.length} (ver arquivo exportado).`);
  }
  elStatus.textContent = 'Concluído';
  resumir(resultados, ocorrencias);
}

async function rodarVolumeMaximo() {
  elStatus.textContent = 'Medindo volume máximo...';
  registrar('Inserção progressiva até o estouro de cota ou o teto do experimento.');
  const saida = [];
  for (const adaptador of criarAdaptadores()) {
    if (!(await adaptador.disponivel())) continue;

    const quota = await adaptador.quotaDeclaradaBytes().catch(() => null);
    if (quota != null) {
      registrar(
        `${adaptador.nome}: cota declarada pelo navegador = ` +
          `${(quota / 1048576).toFixed(1)} MB`
      );
    }

    const r = await medirVolumeMaximo(adaptador, 1000, registrar, TETO_REGISTROS);
    saida.push(r);
    registrar(
      `${r.mecanismo}: ${r.registros_suportados.toLocaleString('pt-BR')} registros ` +
        `(~${(r.bytes_conteudo_aproximados / 1048576).toFixed(1)} MB) — ` +
        `limite atingido: ${r.limite_atingido}`
    );
  }
  ultimoVolumeMaximo = saida;
  elStatus.textContent = 'Concluído';
}

function resumir(resultados, ocorrencias) {
  const chaves = new Map();
  for (const r of resultados) {
    const k = `${r.mecanismo}|${r.volume}`;
    if (!chaves.has(k)) chaves.set(k, { escrita: [], leitura: [] });
    chaves.get(k).escrita.push(r.tempo_escrita_ms);
    chaves.get(k).leitura.push(r.tempo_leitura_ms);
  }

  const media = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const desvio = (a) => {
    const m = media(a);
    return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
  };

  let html =
    '<table><thead><tr><th>Mecanismo</th><th>Volume</th>' +
    '<th>Escrita média (ms)</th><th>DP</th>' +
    '<th>Leitura média (ms)</th><th>DP</th></tr></thead><tbody>';

  for (const [k, v] of chaves) {
    const [mec, vol] = k.split('|');
    html +=
      `<tr><td>${mec}</td><td>${Number(vol).toLocaleString('pt-BR')}</td>` +
      `<td>${media(v.escrita).toFixed(2)}</td><td>${desvio(v.escrita).toFixed(2)}</td>` +
      `<td>${media(v.leitura).toFixed(2)}</td><td>${desvio(v.leitura).toFixed(2)}</td></tr>`;
  }
  html += '</tbody></table>';

  if (ocorrencias.length) {
    html += '<p class="aviso"><strong>Ocorrências:</strong></p><ul>';
    for (const o of ocorrencias) {
      html += `<li>${o.mecanismo} — ${o.volume.toLocaleString('pt-BR')} registros: ${o.situacao}</li>`;
    }
    html += '</ul>';
  }

  elResultados.innerHTML = html;
}

/* ---------------- verificação do conjunto ---------------- */

function verificarConjunto() {
  const amostra = gerarConjunto(1000);
  const v = validarConjunto(amostra);
  registrar(
    v.valido
      ? `Conjunto verificado: 1.000 registros, todos com ${TAMANHO_REGISTRO_BYTES} bytes.`
      : `ATENÇÃO: ${v.divergentes.length} registros com tamanho divergente.`
  );
}

/* ---------------- teste offline ---------------- */

const REGISTROS_PERSISTENCIA = 100;

/**
 * Prefixo dos metadados do teste offline. Precisa ser distinto do prefixo dos
 * registros ('bench:'), caso contrário o adaptador de Web Storage trataria o
 * marcador como se fosse um registro, falharia ao desserializá-lo e informaria
 * zero registros preservados no LocalStorage — resultado oposto ao real.
 */
const CHAVE_MARCADOR = 'meta_bench_marcador';
const CHAVE_GRAVACAO = 'meta_bench_gravacao';

/**
 * Determina se a página em execução foi servida pelo service worker a partir
 * do cache, e não pela rede. Duas evidências independentes são registradas:
 * o controle da página pelo service worker e a interceptação da própria
 * requisição de navegação (workerStart > 0 na Navigation Timing).
 */
function detectarOrigemDoCarregamento() {
  let navegacao = null;
  try {
    navegacao = performance.getEntriesByType('navigation')[0] ?? null;
  } catch {
    navegacao = null;
  }
  return {
    online: navigator.onLine,
    controlada_por_service_worker: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
    navegacao_interceptada_pelo_service_worker:
      navegacao && typeof navegacao.workerStart === 'number' ? navegacao.workerStart > 0 : null,
    tipo_de_navegacao: navegacao ? navegacao.type : null
  };
}

async function testarPersistencia() {
  const adaptadores = criarAdaptadores();
  const registros = gerarConjunto(REGISTROS_PERSISTENCIA);
  const gravados = [];
  for (const a of adaptadores) {
    if (!(await a.disponivel())) continue;
    await a.limpar();
    await a.gravar(registros);
    gravados.push({ mecanismo: a.nome, registros_gravados: registros.length });
  }
  const marcador = new Date().toISOString();
  localStorage.setItem(CHAVE_MARCADOR, marcador);
  localStorage.setItem(CHAVE_GRAVACAO, JSON.stringify(gravados));
  registrar(
    `${REGISTROS_PERSISTENCIA} registros gravados nos três mecanismos. ` +
      'Ative o modo offline, feche a aba, reabra a aplicação e clique em "Verificar persistência".'
  );
}

/**
 * Testa se a origem ainda responde pela rede. A requisição usa um caminho
 * inexistente e sem cache, de modo que o service worker não a resolva pelo
 * cache e precise repassá-la à rede. Se o servidor estiver no ar, a resposta
 * chega (ainda que 404); se estiver encerrado, ou a conexão desativada, a
 * requisição falha.
 *
 * Esta é a evidência forte do cenário offline: a aplicação continuar operando
 * enquanto nenhuma resposta pode vir do servidor. O indicador navigator.onLine
 * é mais fraco, pois reflete apenas a existência de interface de rede no
 * sistema, e não a acessibilidade da origem.
 */
async function testarAlcanceDaRede() {
  const url = `./sonda-de-rede-inexistente?t=${Date.now()}`;
  try {
    const resposta = await fetch(url, { cache: 'no-store' });
    return { alcancavel: true, status: resposta.status };
  } catch (erro) {
    return { alcancavel: false, falha: erro.message };
  }
}

async function verificarPersistencia() {
  const marcador = localStorage.getItem(CHAVE_MARCADOR);
  const bruto = localStorage.getItem(CHAVE_GRAVACAO);
  const gravados = bruto ? JSON.parse(bruto) : [];
  const mapaGravados = new Map(gravados.map((g) => [g.mecanismo, g.registros_gravados]));

  const carregamento = detectarOrigemDoCarregamento();
  const rede = await testarAlcanceDaRede();
  const mecanismos = [];

  for (const a of criarAdaptadores()) {
    if (!(await a.disponivel())) continue;
    const dados = await a.ler().catch(() => []);
    const esperados = mapaGravados.get(a.nome) ?? REGISTROS_PERSISTENCIA;
    mecanismos.push({
      mecanismo: a.nome,
      registros_gravados: esperados,
      registros_recuperados: dados.length,
      preservou: dados.length === esperados
    });
  }

  // O teste é válido quando três condições se verificam: os dados foram
  // gravados nesta mesma origem, a página foi servida pelo service worker a
  // partir do cache, e nenhuma resposta podia vir do servidor no momento da
  // verificação. O valor de navigator.onLine é registrado como observação,
  // por ser indicador de interface de rede e não de acessibilidade da origem.
  const problemas = [];
  if (!marcador) {
    problemas.push(
      'Nenhum marcador de gravação encontrado nesta origem. Os dados não foram ' +
        'gravados, ou foram gravados em outro endereço (por exemplo, 127.0.0.1 ' +
        'em vez de localhost). Clique em "Gravar dados de persistência" primeiro.'
    );
  }
  // Origem pelo cache. A evidência direta é workerStart > 0 na Navigation
  // Timing API. Nem todo navegador preenche esse atributo para a navegação
  // (no Firefox ele foi observado igual a zero); nesse caso, a origem pelo
  // cache é inferida do controle da página pelo service worker combinado com
  // a inacessibilidade do servidor, já que a página não teria outra fonte.
  let criterioOrigemCache = null;
  if (carregamento.navegacao_interceptada_pelo_service_worker === true) {
    criterioOrigemCache = 'workerStart > 0 (interceptação da navegação registrada pelo navegador)';
  } else if (carregamento.controlada_por_service_worker && !rede.alcancavel) {
    criterioOrigemCache =
      'página controlada pelo service worker com o servidor inacessível ' +
      '(o navegador não informou workerStart para a navegação)';
  } else {
    problemas.push(
      'A página não foi servida pelo service worker. Um recarregamento forçado ' +
        '(Ctrl+Shift+R) ignora o service worker de propósito: recarregue com F5.'
    );
  }
  if (rede.alcancavel) {
    problemas.push(
      `O servidor ainda responde pela rede (status ${rede.status}). Encerre o ` +
        'servidor HTTP, ou desative a conexão, antes de verificar.'
    );
  }

  const observacoes = [];
  if (criterioOrigemCache && carregamento.navegacao_interceptada_pelo_service_worker !== true) {
    observacoes.push(
      'O navegador não informou a interceptação da navegação (workerStart igual a zero). ' +
        'A origem pelo cache foi inferida do controle da página pelo service worker ' +
        'combinado com a inacessibilidade do servidor.'
    );
  }
  if (carregamento.online) {
    observacoes.push(
      'navigator.onLine indicava conexão ativa. Esse indicador reflete apenas a ' +
        'existência de interface de rede no sistema, e não a acessibilidade da ' +
        'origem, que foi verificada diretamente pela sonda de rede.'
    );
  }

  ultimaPersistencia = {
    ambiente: coletarAmbiente(),
    data_hora_verificacao: new Date().toISOString(),
    marcador_da_gravacao: marcador,
    servidor_inacessivel: rede.alcancavel === false,
    criterio_origem_cache: criterioOrigemCache,
    sonda_de_rede: rede,
    teste_valido: problemas.length === 0,
    problemas,
    observacoes,
    carregamento,
    mecanismos
  };

  registrar(marcador ? `Marcador da gravação: ${marcador}` : 'Nenhum marcador encontrado.');
  registrar(
    `Conexão: ${carregamento.online ? 'online' : 'offline'} — ` +
      `service worker controlando a página: ${carregamento.controlada_por_service_worker ? 'sim' : 'não'} — ` +
      `navegação servida pelo service worker: ${
        carregamento.navegacao_interceptada_pelo_service_worker === null
          ? 'não informado'
          : carregamento.navegacao_interceptada_pelo_service_worker
            ? 'sim'
            : 'não'
      }`
  );
  registrar(
    rede.alcancavel
      ? `Sonda de rede: o servidor respondeu (status ${rede.status}).`
      : 'Sonda de rede: nenhuma resposta do servidor — a aplicação está operando apenas pelo cache.'
  );
  for (const m of mecanismos) {
    registrar(
      `${m.mecanismo}: ${m.registros_recuperados} de ${m.registros_gravados} registros preservados` +
        `${m.preservou ? '' : ' (dados descartados)'}`
    );
  }
  registrar('Clique em "Exportar resultado do teste offline" para salvar este resultado.');

  mostrarPersistencia();
}

function mostrarPersistencia() {
  if (!ultimaPersistencia) return;

  if (!ultimaPersistencia.teste_valido) {
    let aviso = '<p class="aviso"><strong>Teste não caracterizado.</strong></p><ul>';
    for (const p of ultimaPersistencia.problemas) aviso += `<li>${p}</li>`;
    aviso += '</ul><p>Refaça o procedimento antes de exportar.</p>';
    elResultados.innerHTML = aviso;
    for (const p of ultimaPersistencia.problemas) registrar(`ATENÇÃO: ${p}`);
    return;
  }

  let html =
    '<table><thead><tr><th>Mecanismo</th><th>Gravados</th>' +
    '<th>Recuperados</th><th>Preservou</th></tr></thead><tbody>';
  for (const m of ultimaPersistencia.mecanismos) {
    html +=
      `<tr><td>${m.mecanismo}</td><td>${m.registros_gravados}</td>` +
      `<td>${m.registros_recuperados}</td><td>${m.preservou ? 'sim' : 'não'}</td></tr>`;
  }
  html += '</tbody></table>';
  html +=
    `<p>Conexão no momento da verificação: <strong>${
      ultimaPersistencia.carregamento.online ? 'online' : 'offline'
    }</strong>. Página servida pelo cache do <em>service worker</em>: <strong>${
      ultimaPersistencia.criterio_origem_cache ? 'sim' : 'não'
    }</strong>. Servidor acessível pela rede: <strong>${
      ultimaPersistencia.servidor_inacessivel ? 'não' : 'sim'
    }</strong>.</p>`;
  if (ultimaPersistencia.observacoes.length) {
    html += '<p class="aviso"><strong>Observações:</strong></p><ul>';
    for (const o of ultimaPersistencia.observacoes) html += `<li>${o}</li>`;
    html += '</ul>';
  }
  elResultados.innerHTML = html;
}

/* ---------------- inicialização ---------------- */

/** Executa uma ação longa sob trava, impedindo execuções concorrentes. */
async function comTrava(acao) {
  if (ocupado) {
    registrar('Já existe uma execução em andamento. Aguarde a conclusão.');
    return;
  }
  travar(true);
  try {
    await acao();
  } catch (e) {
    registrar(`ERRO: ${e.message}`);
    elStatus.textContent = 'Erro';
  } finally {
    travar(false);
  }
}

$('#btn-verificar').addEventListener('click', () => comTrava(verificarConjunto));
$('#btn-executar').addEventListener('click', () => comTrava(rodarExperimento));
$('#btn-volume').addEventListener('click', () => comTrava(rodarVolumeMaximo));
$('#btn-persistir').addEventListener('click', () => comTrava(testarPersistencia));
$('#btn-verificar-persistencia').addEventListener('click', verificarPersistencia);

$('#btn-csv').addEventListener('click', () => {
  if (!ultimosResultados) return registrar('Nenhum resultado para exportar.');
  const carimbo = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  baixar(`medicoes-${carimbo}.csv`, paraCSV(ultimosResultados.resultados), 'text/csv');
});

$('#btn-exportar-persistencia').addEventListener('click', () => {
  if (!ultimaPersistencia) {
    return registrar('Execute "Verificar persistência" antes de exportar.');
  }
  if (!ultimaPersistencia.teste_valido) {
    return registrar(
      'Exportação cancelada: o teste não foi caracterizado. Veja os avisos acima.'
    );
  }
  const carimbo = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  baixar(
    `persistencia-offline-${carimbo}.json`,
    JSON.stringify(ultimaPersistencia, null, 2),
    'application/json'
  );
});

$('#btn-json').addEventListener('click', () => {
  if (!ultimosResultados && !ultimoVolumeMaximo) {
    return registrar('Nenhum resultado para exportar.');
  }
  const carimbo = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  // Permite exportar apenas o volume máximo, sem ter rodado o experimento.
  const base = ultimosResultados || { ambiente: coletarAmbiente() };
  const pacote = { ...base, volumeMaximo: ultimoVolumeMaximo };
  const nome = ultimosResultados ? 'execucao' : 'volume-maximo';
  baixar(`${nome}-${carimbo}.json`, JSON.stringify(pacote, null, 2), 'application/json');
});

window.addEventListener('online', () => registrar('Conexão restabelecida.'));
window.addEventListener('offline', () => registrar('Aplicação operando sem conexão.'));

if ('serviceWorker' in navigator) {
  navigator.serviceWorker
    .register('./sw.js')
    .then(() => registrar('Service worker registrado.'))
    .catch((e) => registrar(`Service worker não registrado: ${e.message}`));
}

mostrarAmbiente();
