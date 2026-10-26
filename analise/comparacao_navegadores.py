#!/usr/bin/env python3
"""
comparacao_navegadores.py — compara as medições entre navegadores.

Uso: python3 comparacao_navegadores.py chrome=med-chrome.csv edge=... firefox=...
"""
import sys
from pathlib import Path
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pandas as pd

OPER = {"tempo_escrita_ms": "escrita", "tempo_leitura_ms": "leitura"}
CORES = {"Chrome": "#4C72B0", "Edge": "#55A868", "Firefox": "#DD8452"}

def main():
    pares = [a.split("=", 1) for a in sys.argv[1:-1]] if len(sys.argv) > 2 else []
    saida = Path(sys.argv[-1]) if len(sys.argv) > 2 else Path("comparacao")
    saida.mkdir(parents=True, exist_ok=True)

    quadros = []
    for nome, caminho in pares:
        d = pd.read_csv(caminho); d["navegador"] = nome; quadros.append(d)
    df = pd.concat(quadros, ignore_index=True)

    plt.rcParams.update({"font.family": "sans-serif", "font.size": 9,
                         "axes.grid": True, "grid.alpha": .3, "figure.dpi": 200})

    mecanismos = ["LocalStorage", "SessionStorage", "IndexedDB"]
    for coluna, rot in OPER.items():
        fig, eixos = plt.subplots(1, 3, figsize=(12, 3.8), sharey=True)
        for ax, mec in zip(eixos, mecanismos):
            for nav in sorted(df.navegador.unique()):
                s = df[(df.mecanismo == mec) & (df.navegador == nav)]
                if s.empty: continue
                g = s.groupby("volume")[coluna].median()
                ax.plot(g.index, g.values, marker="o", label=nav,
                        color=CORES.get(nav.split()[0], None))
            ax.set_xscale("log"); ax.set_yscale("log")
            ax.set_title(mec); ax.set_xlabel("Volume (registros)")
        eixos[0].set_ylabel(f"Tempo de {rot} — mediana (ms)")
        eixos[0].legend(frameon=False, fontsize=8)
        fig.suptitle(f"Tempo de {rot} por navegador")
        fig.tight_layout()
        cam = saida / f"comparacao_{rot}.png"; fig.savefig(cam); plt.close(fig)
        print("  ", cam)

    tab = (df.groupby(["mecanismo", "volume", "navegador"])
             [["tempo_escrita_ms", "tempo_leitura_ms"]].median().round(2).reset_index())
    tab.to_csv(saida / "medianas_por_navegador.csv", index=False)
    print("  ", saida / "medianas_por_navegador.csv")

if __name__ == "__main__":
    main()
