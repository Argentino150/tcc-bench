# Aplicação de testes — Avaliação de desempenho de armazenamento *client-side*

Aplicação desenvolvida para o Trabalho de Conclusão de Curso *Avaliação de
Desempenho de Métodos de Armazenamento Client-Side em Aplicações Web*
(Ciência da Computação, UNESC).

Mede tempo de escrita, tempo de leitura, volume lógico de dados armazenados e volume máximo
suportado por **LocalStorage**, **Session Storage** e **IndexedDB**.

---

## Como executar

A aplicação precisa ser servida por HTTP — abrir o `index.html` pelo sistema de
arquivos (`file://`) não funciona, porque módulos ES e *service workers* exigem
uma origem HTTP.

```bash
# a partir da raiz do projeto
python3 -m http.server 8080
# depois: http://localhost:8080
```

Ordem sugerida de uso:

1. **Verificar conjunto de dados** — confirma que todos os registros têm
   exatamente 256 bytes.
2. **Executar experimento** — 4 volumes × 3 mecanismos × 35 execuções.
3. **Medir volume máximo** — inserção progressiva até o estouro de cota.
4. **Exportar CSV** — gera o arquivo de medições.

---

## Estrutura

```
index.html                    interface
manifest.json                 manifesto da PWA
sw.js                         service worker (cache-first)
css/style.css
js/dataset.js                 geração determinística dos registros
js/adapters.js                camada de abstração dos três mecanismos
js/benchmark.js               protocolo experimental
js/app.js                     orquestração e exportação
analise/analise_estatistica.py  análise estatística e gráficos
dados/                        medições e resultados
```

---

## Conjunto de dados

Cada registro é um objeto JSON com **tamanho fixo de 256 bytes (UTF-8)**. Os
campos `id`, `codigo`, `nome`, `valor`, `ativo` e `criadoEm` compõem o conteúdo;
o campo `descricao` funciona como preenchimento, calculado por diferença para
que todos os registros ocupem exatamente o mesmo espaço.

Os registros são gerados por um PRNG determinístico (*mulberry32*) com semente
fixa `20260913`. A mesma semente produz sempre o mesmo conjunto, em qualquer
máquina ou navegador.

| Volume | Conteúdo |
|---|---|
| 100 | 25,6 KB |
| 1.000 | 256 KB |
| 10.000 | 2,56 MB |
| 100.000 | 25,6 MB |

---

## Protocolo experimental

| Parâmetro | Valor |
|---|---|
| Execuções de aquecimento (descartadas) | 15 por cenário |
| Execuções válidas | 30 por cenário |
| Limpeza entre execuções | sim |
| Ordem dos mecanismos | alternada a cada volume |
| Relógio | `performance.now()` |
| Volume lógico de dados armazenados (métrica principal) | soma dos bytes UTF-8 de chaves e registros serializados, nos três mecanismos |
| Uso reportado pelo navegador (medida secundária) | `navigator.storage.estimate().usage`, apenas IndexedDB |

**Equivalência entre mecanismos.** Os três adaptadores expõem a mesma interface
assíncrona. Os mecanismos síncronos também retornam `Promise`, de modo que o
arnês de medição seja idêntico e o tempo do IndexedDB inclua a espera pela
conclusão efetiva da transação (`tx.oncomplete`).

**Granularidade das operações.** Os registros são gravados individualmente em
todos os mecanismos: uma chave por registro no Web Storage e um `put` por
registro no IndexedDB, dentro de uma única transação. A comparação é entre
operações equivalentes, e não entre gravação em bloco e gravações unitárias.

**Volume máximo.** Obtido por duas vias complementares:

1. *Cota declarada* — `navigator.storage.estimate().quota`, lida sem gravar
   dados. Vale para o IndexedDB; o Web Storage não é contabilizado por essa API.
2. *Inserção progressiva* — crescimento geométrico dos lotes até o primeiro
   `QuotaExceededError`, seguido de refinamento com lotes pequenos. Após o
   erro, o total é obtido pela **contagem dos registros efetivamente
   armazenados** (`contar()`), e não pela soma dos lotes concluídos: no Web
   Storage, um lote interrompido pela cota deixa gravada a parte anterior ao
   erro (correção da versão `bench-v10`).

A inserção progressiva tem um **teto de 1.000.000 de registros** (256 MB),
definido em `TETO_REGISTROS` no `app.js`. Sem esse teto, um IndexedDB com
vários gigabytes de cota levaria dezenas de minutos para estourar. O campo
`limite_atingido` no resultado informa se o valor corresponde à cota do
navegador ou ao teto do experimento — no segundo caso, o número deve ser
relatado como *superior a* e não como o limite real.

O valor depende do navegador, da política de cota, do espaço livre em disco e
do modo de navegação, devendo ser interpretado como referência comparativa no
mesmo ambiente, e não como limite absoluto.

**Trava de reentrada.** Os botões de ação longa são desabilitados durante a
execução. Sem essa trava, um segundo clique dispararia uma medição concorrente
que limparia o armazenamento da primeira, invalidando ambas.

---

## Análise estatística

```bash
pip install pandas numpy scipy matplotlib
python3 analise/analise_estatistica.py dados/medicoes.csv --saida dados/resultados
```

Procedimento, para cada combinação de volume e operação:

| Etapa | Método | Finalidade |
|---|---|---|
| Normalidade | Shapiro-Wilk | adequado a n = 30 |
| Homocedasticidade | Levene (centro na mediana) | robusto a desvios de normalidade |
| Comparação global | ANOVA de uma via **ou** Kruskal-Wallis | conforme os pressupostos |
| Pós-teste | Mann-Whitney U com correção de Bonferroni | três pares por cenário |
| Tamanho de efeito | Delta de Cliff | magnitude, não apenas significância |

Nível de significância: **α = 0,05**. No pós-teste, α corrigido = 0,05/3 ≈ 0,0167.

Saídas geradas: `estatistica_descritiva.csv`, `testes_hipotese.csv`,
`comparacoes_pareadas.csv` e quatro gráficos em PNG (300 dpi).

---

## Ambiente

A aplicação registra automaticamente, junto com os dados exportados:
`userAgent`, plataforma, núcleos lógicos, memória aproximada, idioma, estado da
conexão e data/hora da execução. **Anote também**: modelo e configuração do
computador, sistema operacional e versão exata de cada navegador testado
(`chrome://version`, `about:support`) — esses dados são necessários na seção de
Materiais e Métodos.

---

## Cenário *offline*

Execute **uma vez em cada navegador**, depois do experimento principal.

1. Com o servidor no ar, abra a aplicação e clique em **Gravar dados de
   persistência** (grava 100 registros nos três mecanismos e cria um marcador).
2. **Encerre o servidor HTTP** (`Ctrl+C` no terminal).
3. **Feche a aba** — não basta recarregar. O Session Storage sobrevive a um
   recarregamento na mesma aba e só é descartado quando a aba é fechada;
   recarregar produziria o resultado oposto ao esperado.
4. Abra uma nova aba no mesmo endereço. A aplicação deve carregar mesmo com o
   servidor fora do ar, a partir do *cache* do *service worker*.
5. Clique em **Verificar persistência**.
6. Clique em **Exportar resultado do teste offline**.

Não é necessário desligar a rede nem usar o modo *Offline* das ferramentas do
desenvolvedor. Encerrar o servidor é suficiente e produz evidência mais forte.

**Validação automática.** A verificação só é considerada caracterizada quando
três condições se verificam, e a exportação é recusada caso alguma falhe:

| Condição | Como é verificada |
|---|---|
| Os dados foram gravados nesta origem | presença do marcador |
| A página veio do *cache* | `workerStart > 0` na *Navigation Timing API* |
| Nenhuma resposta podia vir do servidor | sonda de rede a um caminho inexistente, sem *cache* |

A sonda de rede requisita um caminho que não existe e não pode ser resolvido
pelo *cache*, obrigando o *service worker* a repassá-la à rede: se o servidor
estiver no ar, a resposta chega (ainda que 404); se estiver encerrado, a
requisição falha. Esse é o critério adotado, e não `navigator.onLine`, que
indica apenas a existência de interface de rede no sistema e não a
acessibilidade da origem — seu valor é registrado como observação.

Comportamento esperado: LocalStorage e IndexedDB preservam os 100 registros; o
Session Storage os descarta, por definição da especificação.

> **Nota de implementação.** Os metadados do teste usam prefixo de chave
> distinto do prefixo dos registros. Enquanto compartilhavam o mesmo prefixo, o
> adaptador de Web Storage tratava o marcador como um registro, falhava ao
> desserializá-lo e informava zero registros preservados no LocalStorage —
> exatamente o contrário do comportamento real.

---

## Limitações conhecidas

- `navigator.storage.estimate()` é atualizado de forma assíncrona pelo Chrome.
  Medições feitas imediatamente após a gravação retornam valores inconsistentes
  — inclusive diferenças nulas. Por isso a métrica principal de uso passou a ser
  a contagem direta dos bytes serializados, idêntica nos três mecanismos; o
  valor do navegador é registrado apenas como medida secundária, na coluna
  `uso_navegador_bytes`.
- O aquecimento é de 15 execuções por cenário. Com 5, as primeiras medições
  válidas do IndexedDB ainda apareciam contaminadas (leituras de 170 ms contra
  2 ms no regime estável).
- O LocalStorage e o Session Storage contabilizam a cota em unidades UTF-16,
  o que faz o limite prático ficar próximo de 5 MB de conteúdo ASCII. O cenário
  de 10.000 registros (2,56 MB) opera perto desse limite em alguns navegadores.
- A sincronização com servidor remoto está fora do escopo.
- Medições em máquina única; resultados não são generalizáveis para outros
  perfis de hardware sem replicação.
