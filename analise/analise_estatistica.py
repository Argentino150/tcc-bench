#!/usr/bin/env python3
"""
analise_estatistica.py

Análise estatística das medições exportadas pela aplicação de testes.

Entrada : CSV com as colunas
          mecanismo, volume, execucao, tempo_escrita_ms, tempo_leitura_ms,
          uso_conteudo_bytes, uso_navegador_bytes, registros_lidos
Saída   : estatística descritiva, testes de hipótese e gráficos.

Procedimento adotado, para cada combinação de volume e tipo de operação:

  1. Estatística descritiva
     Média, desvio padrão, mediana, mínimo, máximo, intervalo interquartil e
     coeficiente de variação.

  2. Teste de normalidade — Shapiro-Wilk (alfa = 0,05)
     Escolhido por ser adequado a amostras pequenas (n = 30 por cenário) e por
     ser o teste de normalidade mais utilizado nessa faixa de tamanho amostral.
     H0: a amostra provém de uma distribuição normal.

  3. Teste de homogeneidade de variâncias — Levene (alfa = 0,05)
     Escolhido por ser robusto a desvios de normalidade, diferentemente do
     teste de Bartlett. H0: as variâncias dos grupos são iguais.

  4. Comparação entre os três mecanismos
     Se normalidade E homocedasticidade forem atendidas: ANOVA de uma via.
     Caso contrário: Kruskal-Wallis, alternativa não paramétrica que não exige
     normalidade. H0: as distribuições dos três mecanismos são iguais.

  5. Comparações par a par (pós-teste), quando o teste global rejeita H0
     Mann-Whitney U com correção de Bonferroni para múltiplas comparações
     (três pares por cenário, portanto alfa corrigido = 0,05/3 = 0,0167).

  6. Tamanho de efeito
     Delta de Cliff, medida não paramétrica que quantifica a magnitude da
     diferença independentemente da significância estatística.
     Interpretação: |d| < 0,147 desprezível; < 0,33 pequeno;
     < 0,474 médio; caso contrário grande.

Uso:
    python3 analise_estatistica.py medicoes.csv [--saida resultados/]
"""

import argparse
import itertools
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats

ALFA = 0.05
OPERACOES = {"tempo_escrita_ms": "Escrita", "tempo_leitura_ms": "Leitura"}


# --------------------------------------------------------------------------- #
# Estatística descritiva
# --------------------------------------------------------------------------- #
def descritiva(df: pd.DataFrame) -> pd.DataFrame:
    linhas = []
    for (mec, vol), g in df.groupby(["mecanismo", "volume"], sort=True):
        for coluna, rotulo in OPERACOES.items():
            x = g[coluna].dropna().to_numpy()
            if x.size == 0:
                continue
            q1, q3 = np.percentile(x, [25, 75])
            media = x.mean()
            dp = x.std(ddof=1)
            linhas.append(
                {
                    "mecanismo": mec,
                    "volume": vol,
                    "operacao": rotulo,
                    "n": x.size,
                    "media_ms": round(media, 4),
                    "desvio_padrao_ms": round(dp, 4),
                    "mediana_ms": round(float(np.median(x)), 4),
                    "minimo_ms": round(float(x.min()), 4),
                    "maximo_ms": round(float(x.max()), 4),
                    "iqr_ms": round(float(q3 - q1), 4),
                    "coef_variacao_pct": round(100 * dp / media, 2) if media else None,
                }
            )
    return pd.DataFrame(linhas)


# --------------------------------------------------------------------------- #
# Tamanho de efeito
# --------------------------------------------------------------------------- #
def delta_cliff(a: np.ndarray, b: np.ndarray) -> float:
    """Delta de Cliff: proporção de dominância entre duas amostras."""
    maior = sum((x > y) for x in a for y in b)
    menor = sum((x < y) for x in a for y in b)
    return (maior - menor) / (len(a) * len(b))


def interpretar_delta(d: float) -> str:
    m = abs(d)
    if m < 0.147:
        return "desprezível"
    if m < 0.330:
        return "pequeno"
    if m < 0.474:
        return "médio"
    return "grande"


# --------------------------------------------------------------------------- #
# Pressupostos e testes
# --------------------------------------------------------------------------- #
def testar_pressupostos(grupos: dict) -> dict:
    normais = {}
    for nome, x in grupos.items():
        if len(x) < 3:
            normais[nome] = None
            continue
        _, p = stats.shapiro(x)
        normais[nome] = p

    todos_normais = all(p is not None and p > ALFA for p in normais.values())

    amostras = [x for x in grupos.values() if len(x) >= 2]
    if len(amostras) >= 2:
        _, p_levene = stats.levene(*amostras, center="median")
    else:
        p_levene = None
    homocedastico = p_levene is not None and p_levene > ALFA

    return {
        "shapiro_p": {k: (round(v, 6) if v is not None else None) for k, v in normais.items()},
        "todos_normais": todos_normais,
        "levene_p": round(p_levene, 6) if p_levene is not None else None,
        "homocedastico": homocedastico,
    }


def comparar(grupos: dict) -> dict:
    press = testar_pressupostos(grupos)
    amostras = [x for x in grupos.values() if len(x) >= 2]

    if len(amostras) < 2:
        return {**press, "teste": None, "estatistica": None, "p": None, "rejeita_h0": None}

    if press["todos_normais"] and press["homocedastico"]:
        teste = "ANOVA de uma via"
        estat, p = stats.f_oneway(*amostras)
    else:
        teste = "Kruskal-Wallis"
        estat, p = stats.kruskal(*amostras)

    return {
        **press,
        "teste": teste,
        "estatistica": round(float(estat), 6),
        "p": float(p),
        "rejeita_h0": bool(p < ALFA),
    }


def pos_teste(grupos: dict) -> list:
    """Mann-Whitney U par a par com correção de Bonferroni."""
    nomes = [k for k, v in grupos.items() if len(v) >= 2]
    pares = list(itertools.combinations(nomes, 2))
    if not pares:
        return []
    alfa_corrigido = ALFA / len(pares)

    saida = []
    for a, b in pares:
        xa, xb = grupos[a], grupos[b]
        estat, p = stats.mannwhitneyu(xa, xb, alternative="two-sided")
        d = delta_cliff(xa, xb)
        saida.append(
            {
                "par": f"{a} vs {b}",
                "U": float(estat),
                "p": float(p),
                "p_corrigido_bonferroni": float(min(1.0, p * len(pares))),
                "alfa_corrigido": round(alfa_corrigido, 6),
                "significativo": bool(p < alfa_corrigido),
                "delta_cliff": round(d, 4),
                "magnitude": interpretar_delta(d),
                "mediana_a_ms": round(float(np.median(xa)), 4),
                "mediana_b_ms": round(float(np.median(xb)), 4),
            }
        )
    return saida


# --------------------------------------------------------------------------- #
# Gráficos
# --------------------------------------------------------------------------- #
def gerar_graficos(df: pd.DataFrame, saida: Path) -> list:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    plt.rcParams.update(
        {
            "font.family": "sans-serif",
            "font.size": 10,
            "axes.grid": True,
            "grid.alpha": 0.3,
            "figure.dpi": 200,
        }
    )

    arquivos = []
    volumes = sorted(df["volume"].unique())
    mecanismos = sorted(df["mecanismo"].unique())
    cores = {m: c for m, c in zip(mecanismos, ["#4C72B0", "#DD8452", "#55A868", "#C44E52"])}

    # 1. Tempo médio por volume (escala logarítmica), escrita e leitura.
    for coluna, rotulo in OPERACOES.items():
        fig, ax = plt.subplots(figsize=(7, 4.2))
        for mec in mecanismos:
            medias, erros, vols = [], [], []
            for v in volumes:
                x = df[(df.mecanismo == mec) & (df.volume == v)][coluna].dropna()
                if x.empty:
                    continue
                vols.append(v)
                medias.append(x.mean())
                erros.append(x.std(ddof=1))
            if vols:
                ax.errorbar(vols, medias, yerr=erros, marker="o", capsize=3,
                            label=mec, color=cores.get(mec))
        ax.set_xscale("log")
        ax.set_yscale("log")
        ax.set_xlabel("Volume (registros)")
        ax.set_ylabel(f"Tempo de {rotulo.lower()} (ms)")
        ax.set_title(f"Tempo de {rotulo.lower()} por volume de dados")
        ax.legend(frameon=False)
        fig.tight_layout()
        cam = saida / f"grafico_{rotulo.lower()}_por_volume.png"
        fig.savefig(cam)
        plt.close(fig)
        arquivos.append(cam)

    # 2. Distribuição das medições (boxplot) por volume.
    for coluna, rotulo in OPERACOES.items():
        n = len(volumes)
        fig, eixos = plt.subplots(1, n, figsize=(3.4 * n, 3.8), squeeze=False)
        for i, v in enumerate(volumes):
            ax = eixos[0][i]
            dados, rotulos = [], []
            for mec in mecanismos:
                x = df[(df.mecanismo == mec) & (df.volume == v)][coluna].dropna()
                if not x.empty:
                    dados.append(x.to_numpy())
                    rotulos.append(mec.replace("Storage", "\nStorage"))
            if dados:
                bp = ax.boxplot(dados, tick_labels=rotulos, patch_artist=True, widths=0.6)
                for caixa, mec in zip(bp["boxes"], mecanismos):
                    caixa.set_facecolor(cores.get(mec, "#999"))
                    caixa.set_alpha(0.65)
            ax.set_title(f"{v:,} registros".replace(",", "."))
            if i == 0:
                ax.set_ylabel(f"Tempo de {rotulo.lower()} (ms)")
            ax.tick_params(axis="x", labelsize=8)
        fig.suptitle(f"Distribuição do tempo de {rotulo.lower()}")
        fig.tight_layout()
        cam = saida / f"grafico_distribuicao_{rotulo.lower()}.png"
        fig.savefig(cam)
        plt.close(fig)
        arquivos.append(cam)

    return arquivos


# --------------------------------------------------------------------------- #
def main() -> int:
    ap = argparse.ArgumentParser(description="Análise estatística das medições.")
    ap.add_argument("csv", help="arquivo CSV exportado pela aplicação")
    ap.add_argument("--saida", default="resultados", help="diretório de saída")
    args = ap.parse_args()

    caminho = Path(args.csv)
    if not caminho.exists():
        print(f"Arquivo não encontrado: {caminho}", file=sys.stderr)
        return 1

    saida = Path(args.saida)
    saida.mkdir(parents=True, exist_ok=True)

    df = pd.read_csv(caminho)
    obrigatorias = {"mecanismo", "volume", "tempo_escrita_ms", "tempo_leitura_ms"}
    faltando = obrigatorias - set(df.columns)
    if faltando:
        print(f"Colunas ausentes no CSV: {sorted(faltando)}", file=sys.stderr)
        return 1

    print("=" * 72)
    print("ANÁLISE ESTATÍSTICA DAS MEDIÇÕES")
    print("=" * 72)
    print(f"Arquivo    : {caminho}")
    print(f"Medições   : {len(df)}")
    print(f"Mecanismos : {', '.join(sorted(df.mecanismo.unique()))}")
    print(f"Volumes    : {', '.join(str(v) for v in sorted(df.volume.unique()))}")
    print(f"Nível de significância: alfa = {ALFA}")

    # 0 — uso de armazenamento
    coluna_uso = (
        "uso_conteudo_bytes" if "uso_conteudo_bytes" in df.columns
        else ("uso_bytes" if "uso_bytes" in df.columns else None)
    )
    if coluna_uso:
        uso = (
            df.groupby(["mecanismo", "volume"])[coluna_uso]
            .agg(["mean", "std", "min", "max"])
            .reset_index()
        )
        uso.columns = ["mecanismo", "volume", "media_bytes", "desvio_bytes",
                       "minimo_bytes", "maximo_bytes"]
        uso["media_kb"] = (uso["media_bytes"] / 1024).round(1)
        uso["bytes_por_registro"] = (uso["media_bytes"] / uso["volume"]).round(1)
        uso.to_csv(saida / "uso_armazenamento.csv", index=False)
        print("\n" + "-" * 72)
        print("0. USO DE ARMAZENAMENTO")
        print("-" * 72)
        print(uso.to_string(index=False))

    # 1 — descritiva
    desc = descritiva(df)
    desc.to_csv(saida / "estatistica_descritiva.csv", index=False)
    print("\n" + "-" * 72)
    print("1. ESTATÍSTICA DESCRITIVA")
    print("-" * 72)
    print(desc.to_string(index=False))

    # 2 a 5 — testes
    print("\n" + "-" * 72)
    print("2. TESTES DE HIPÓTESE")
    print("-" * 72)

    linhas_testes, linhas_pos = [], []
    for vol in sorted(df.volume.unique()):
        for coluna, rotulo in OPERACOES.items():
            grupos = {}
            for mec in sorted(df.mecanismo.unique()):
                x = df[(df.mecanismo == mec) & (df.volume == vol)][coluna].dropna().to_numpy()
                if x.size:
                    grupos[mec] = x
            if len(grupos) < 2:
                continue

            r = comparar(grupos)
            print(f"\n► {rotulo} — {vol:,} registros".replace(",", "."))
            print(f"  Shapiro-Wilk (p): " + ", ".join(
                f"{k}={v}" for k, v in r["shapiro_p"].items()))
            print(f"  Normalidade em todos os grupos: {'sim' if r['todos_normais'] else 'não'}")
            print(f"  Levene (p) = {r['levene_p']} → variâncias "
                  f"{'homogêneas' if r['homocedastico'] else 'heterogêneas'}")
            print(f"  Teste aplicado: {r['teste']}")
            print(f"  Estatística = {r['estatistica']}   p = {r['p']:.3e}")
            print(f"  Conclusão: {'há' if r['rejeita_h0'] else 'não há'} "
                  f"diferença estatisticamente significativa (alfa = {ALFA})")

            linhas_testes.append({"volume": vol, "operacao": rotulo, **{
                k: v for k, v in r.items() if k != "shapiro_p"}})

            if r["rejeita_h0"]:
                for pt in pos_teste(grupos):
                    linhas_pos.append({"volume": vol, "operacao": rotulo, **pt})
                    marca = "*" if pt["significativo"] else " "
                    print(f"    {marca} {pt['par']:<34} "
                          f"p_corr={pt['p_corrigido_bonferroni']:.3e}  "
                          f"δ={pt['delta_cliff']:+.3f} ({pt['magnitude']})")

    pd.DataFrame(linhas_testes).to_csv(saida / "testes_hipotese.csv", index=False)
    if linhas_pos:
        pd.DataFrame(linhas_pos).to_csv(saida / "comparacoes_pareadas.csv", index=False)

    # 6 — gráficos
    print("\n" + "-" * 72)
    print("3. GRÁFICOS")
    print("-" * 72)
    for arq in gerar_graficos(df, saida):
        print(f"  {arq}")

    print(f"\nArquivos gravados em: {saida.resolve()}")
    print("=" * 72)
    return 0


if __name__ == "__main__":
    sys.exit(main())
