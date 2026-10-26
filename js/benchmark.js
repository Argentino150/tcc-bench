/**
 * benchmark.js
 * Protocolo experimental de medição.
 *
 * Parâmetros do experimento (variáveis independentes):
 *   - mecanismo de armazenamento: LocalStorage, SessionStorage, IndexedDB
 *   - volume de dados: 100, 1.000, 10.000 e 100.000 registros
 *   - tipo de operação: escrita e leitura
 *
 * Variáveis dependentes (métricas):
 *   - tempo de escrita (ms)
 *   - tempo de leitura (ms)
 *   - volume lógico de dados armazenados (bytes)
 *   - volume máximo de dados suportado (registros e bytes)
 *
 * Controles aplicados:
 *   - 15 execuções de aquecimento descartadas por cenário
 *   - 30 execuções válidas por cenário
 *   - limpeza do armazenamento entre execuções (estado inicial equivalente)
 *   - ordem dos mecanismos alternada a cada repetição, evitando que efeitos
 *     de ordenação favoreçam sistematicamente um mecanismo
 *   - medição por performance.now() (relógio monotônico de alta resolução)
 */

import { gerarConjunto } from './dataset.js';
import { isErroDeCota } from './adapters.js';

export const VOLUMES = [100, 1000, 10000, 100000];
export const AQUECIMENTOS = 15;
export const REPETICOES = 30;

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Executa um cenário (mecanismo × volume) e devolve as medições brutas.
 * Cada repetição gera uma linha: escrita, leitura e volume lógico armazenado.
 */
async function medirCenario(adaptador, volume, registros, aoProgredir) {
  const linhas = [];
  let falhaDeCota = false;
  let mensagemFalha = null;

  const total = AQUECIMENTOS + REPETICOES;

  for (let execucao = 1; execucao <= total; execucao++) {
    const aquecimento = execucao <= AQUECIMENTOS;

    await adaptador.limpar();
    await dormir(0); // devolve a thread ao navegador entre execuções

    let tEscrita = null;
    let tLeitura = null;
    let usoDepois = null;
    let usoNavegador = null;
    let lidos = 0;

    try {
      const t0 = performance.now();
      await adaptador.gravar(registros);
      tEscrita = performance.now() - t0;

      const t1 = performance.now();
      const dados = await adaptador.ler();
      tLeitura = performance.now() - t1;
      lidos = dados.length;

      usoDepois = await adaptador.usoEstimadoBytes();
      usoNavegador = await adaptador.usoNavegadorBytes().catch(() => null);
    } catch (erro) {
      if (isErroDeCota(erro)) {
        falhaDeCota = true;
        mensagemFalha = `${erro.name}: ${erro.message}`;
        await adaptador.limpar().catch(() => {});
        break;
      }
      throw erro;
    }

    if (!aquecimento) {
      linhas.push({
        mecanismo: adaptador.nome,
        volume,
        execucao: execucao - AQUECIMENTOS,
        tempo_escrita_ms: Number(tEscrita.toFixed(4)),
        tempo_leitura_ms: Number(tLeitura.toFixed(4)),
        uso_conteudo_bytes: usoDepois,
        uso_navegador_bytes: usoNavegador,
        registros_lidos: lidos
      });
    }

    if (aoProgredir) aoProgredir({ adaptador: adaptador.nome, volume, execucao, total });
  }

  await adaptador.limpar().catch(() => {});

  return { linhas, falhaDeCota, mensagemFalha };
}

/**
 * Experimento principal: percorre volumes e mecanismos.
 * A ordem dos mecanismos é invertida a cada volume para neutralizar
 * efeitos de ordenação.
 */
export async function executarExperimento(adaptadores, aoProgredir, aoRegistrar) {
  const resultados = [];
  const ocorrencias = [];

  for (let iv = 0; iv < VOLUMES.length; iv++) {
    const volume = VOLUMES[iv];
    if (aoRegistrar) aoRegistrar(`Gerando conjunto de ${volume} registros...`);
    const registros = gerarConjunto(volume);

    const ordem = iv % 2 === 0 ? adaptadores : [...adaptadores].reverse();

    for (const adaptador of ordem) {
      if (!(await adaptador.disponivel())) {
        ocorrencias.push({ mecanismo: adaptador.nome, volume, situacao: 'indisponível' });
        continue;
      }

      if (aoRegistrar) aoRegistrar(`${adaptador.nome} — ${volume} registros`);

      const { linhas, falhaDeCota, mensagemFalha } = await medirCenario(
        adaptador,
        volume,
        registros,
        aoProgredir
      );

      resultados.push(...linhas);

      if (falhaDeCota) {
        ocorrencias.push({
          mecanismo: adaptador.nome,
          volume,
          situacao: 'cota excedida',
          detalhe: mensagemFalha
        });
        if (aoRegistrar) {
          aoRegistrar(`${adaptador.nome} — ${volume} registros: cota excedida`);
        }
      }
    }
  }

  return { resultados, ocorrencias };
}

/**
 * Volume máximo suportado: inserção progressiva em blocos de tamanho
 * crescente até a ocorrência de erro de cota.
 *
 * Correção (v10): após o erro, o total NÃO é estimado pela soma dos lotes
 * concluídos, e sim obtido pela contagem dos registros efetivamente
 * armazenados (adaptador.contar()). No Web Storage, um lote interrompido pela
 * cota deixa gravada a parte anterior ao erro; somar apenas os lotes
 * completos subestimava o limite (ex.: 15.000 em vez de ~19.700). Os lotes
 * também passaram a ser gerados já com o id definitivo (idInicial), para que
 * cada registro mantenha exatamente 256 bytes.
 *
 * O valor obtido é dependente do ambiente (navegador, política de cota,
 * espaço livre em disco, modo anônimo) e deve ser interpretado como
 * referência comparativa entre mecanismos no mesmo ambiente, e não como
 * limite absoluto.
 */
export async function medirVolumeMaximo(
  adaptador,
  blocoInicial = 1000,
  aoRegistrar,
  tetoRegistros = 1000000
) {
  await adaptador.limpar().catch(() => {});

  let acumulado = 0;
  let bloco = blocoInicial;
  let erroFinal = null;
  const refino = Math.max(50, Math.floor(blocoInicial / 10));

  const gravarLote = async (quantidade) => {
    const lote = gerarConjunto(quantidade, undefined, acumulado + 1);
    await adaptador.gravar(lote);
    acumulado += quantidade;
  };

  // Fase 1 — crescimento geométrico até a primeira falha de cota.
  try {
    while (acumulado < tetoRegistros) {
      await gravarLote(Math.min(bloco, tetoRegistros - acumulado));
      if (aoRegistrar) aoRegistrar(`${adaptador.nome}: ${acumulado} registros gravados`);
      await dormir(0);
      if (bloco < 50000) bloco *= 2;
    }
  } catch (erro) {
    if (!isErroDeCota(erro)) throw erro;
    erroFinal = `${erro.name}: ${erro.message}`;
    acumulado = await adaptador.contar(); // registros efetivamente armazenados
  }

  // Fase 2 — refinamento com lotes pequenos a partir do total contado,
  // até nova falha; ao final, nova contagem define o valor registrado.
  if (erroFinal) {
    try {
      for (let i = 0; i < 1000; i++) {
        await gravarLote(refino);
        await dormir(0);
      }
    } catch (erro) {
      if (!isErroDeCota(erro)) throw erro;
      erroFinal = `${erro.name}: ${erro.message}`;
    }
    acumulado = await adaptador.contar();
    if (aoRegistrar) {
      aoRegistrar(`${adaptador.nome}: limite medido em ${acumulado} registros (contagem após o erro)`);
    }
  }

  // Volume lógico (chaves + registros em UTF-8) apenas no Web Storage: no
  // IndexedDB, ler 1.000.000 de registros só para somar bytes exigiria
  // centenas de MB de memória; ali vale bytes_conteudo_aproximados.
  const usoConteudo = adaptador.sincrono
    ? await adaptador.usoEstimadoBytes().catch(() => null)
    : null;
  const usoBytes = await adaptador.usoNavegadorBytes().catch(() => null);
  const quotaBytes = await adaptador.quotaDeclaradaBytes().catch(() => null);
  await adaptador.limpar().catch(() => {});

  return {
    mecanismo: adaptador.nome,
    registros_suportados: acumulado,
    metodo_contagem: erroFinal ? 'contagem após QuotaExceededError' : 'teto atingido',
    bytes_conteudo_aproximados: acumulado * 256,
    volume_logico_bytes: usoConteudo,
    uso_reportado_bytes: usoBytes,
    quota_declarada_bytes: quotaBytes,
    limite_atingido: erroFinal ? 'cota do navegador' : 'teto do experimento',
    teto_registros: tetoRegistros,
    erro: erroFinal,
    versao_app: 'bench-v10'
  };
}
