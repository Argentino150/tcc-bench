/**
 * dataset.js
 * Geração determinística do conjunto de dados de teste.
 *
 * Decisão metodológica: o mesmo conjunto de dados é utilizado nos três
 * mecanismos avaliados. Para garantir reprodutibilidade entre execuções e
 * entre máquinas, os registros são gerados por um gerador pseudoaleatório
 * com semente fixa (mulberry32), e não por Math.random().
 *
 * Cada registro é serializado em JSON com tamanho FIXO de 256 bytes (UTF-8).
 * O campo "descricao" atua como preenchimento (padding) ajustado para que o
 * tamanho final seja idêntico em todos os registros, isolando o volume de
 * dados como variável independente.
 */

export const TAMANHO_REGISTRO_BYTES = 256;

/** Gerador pseudoaleatório determinístico (mulberry32). */
function criarPRNG(semente) {
  let a = semente >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const codificador = new TextEncoder();

/** Número de bytes que a string ocupa em UTF-8. */
export function bytesUTF8(texto) {
  return codificador.encode(texto).length;
}

const ALFABETO = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Monta um registro com tamanho serializado exatamente igual a
 * TAMANHO_REGISTRO_BYTES. O padding é calculado por diferença.
 */
function montarRegistro(indice, rnd) {
  const base = {
    id: indice,
    codigo: String(indice).padStart(8, '0'),
    nome: `Registro ${String(indice).padStart(8, '0')}`,
    valor: Math.round(rnd() * 1000000) / 100,
    ativo: rnd() > 0.5,
    criadoEm: new Date(Date.UTC(2026, 0, 1) + indice * 1000).toISOString(),
    descricao: ''
  };

  const tamanhoSemPadding = bytesUTF8(JSON.stringify(base));
  const faltando = TAMANHO_REGISTRO_BYTES - tamanhoSemPadding;

  if (faltando < 0) {
    throw new Error(
      `Registro ${indice} excede ${TAMANHO_REGISTRO_BYTES} bytes sem padding.`
    );
  }

  let padding = '';
  for (let i = 0; i < faltando; i++) {
    padding += ALFABETO[Math.floor(rnd() * ALFABETO.length)];
  }
  base.descricao = padding;

  return base;
}

/**
 * Gera um conjunto de `quantidade` registros.
 * A mesma semente produz sempre o mesmo conjunto.
 *
 * `idInicial` permite gerar lotes com identificadores contínuos (usado na
 * medição do volume máximo). O id entra na montagem do registro, de modo que
 * o padding é recalculado e todo registro mantém exatamente 256 bytes.
 */
export function gerarConjunto(quantidade, semente = 20260913, idInicial = 1) {
  const rnd = criarPRNG(semente);
  const registros = new Array(quantidade);
  for (let i = 0; i < quantidade; i++) {
    registros[i] = montarRegistro(idInicial + i, rnd);
  }
  return registros;
}

/** Soma dos bytes UTF-8 dos registros já serializados. */
export function tamanhoConjuntoBytes(quantidade) {
  return quantidade * TAMANHO_REGISTRO_BYTES;
}

/** Verificação de integridade: confirma que todo registro tem o tamanho alvo. */
export function validarConjunto(registros) {
  const divergentes = [];
  for (const r of registros) {
    const t = bytesUTF8(JSON.stringify(r));
    if (t !== TAMANHO_REGISTRO_BYTES) divergentes.push({ id: r.id, tamanho: t });
  }
  return { valido: divergentes.length === 0, divergentes };
}
