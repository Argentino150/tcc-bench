/**
 * adapters.js
 * Camada de abstração comum aos três mecanismos de armazenamento avaliados.
 *
 * Decisão metodológica: os três adaptadores expõem exatamente a mesma
 * interface assíncrona (gravar, ler, limpar, usoEstimadoBytes). Os mecanismos
 * síncronos (LocalStorage e Session Storage) também retornam Promise, de modo
 * que o arnês de medição seja idêntico para os três e o tempo medido inclua,
 * no IndexedDB, a espera pela conclusão efetiva da transação.
 *
 * Os registros são gravados individualmente em todos os mecanismos: uma chave
 * por registro no Web Storage e um objeto por registro no IndexedDB. Assim a
 * operação comparada é equivalente, e não uma gravação em bloco contra N
 * gravações unitárias.
 */

const PREFIXO = 'bench:';
const BD_NOME = 'bench-db';
const BD_STORE = 'registros';

/* ------------------------------------------------------------------ */
/* Web Storage (LocalStorage e Session Storage)                        */
/* ------------------------------------------------------------------ */

class AdaptadorWebStorage {
  constructor(nome, storage) {
    this.nome = nome;
    this.storage = storage;
    this.sincrono = true;
  }

  async disponivel() {
    try {
      const chave = `${PREFIXO}__teste__`;
      this.storage.setItem(chave, '1');
      this.storage.removeItem(chave);
      return true;
    } catch {
      return false;
    }
  }

  async gravar(registros) {
    for (let i = 0; i < registros.length; i++) {
      this.storage.setItem(PREFIXO + registros[i].id, JSON.stringify(registros[i]));
    }
    return registros.length;
  }

  async ler() {
    const saida = [];
    for (let i = 0; i < this.storage.length; i++) {
      const chave = this.storage.key(i);
      if (chave && chave.startsWith(PREFIXO)) {
        saida.push(JSON.parse(this.storage.getItem(chave)));
      }
    }
    return saida;
  }

  /** Quantidade de registros do experimento atualmente gravados. */
  async contar() {
    let n = 0;
    for (let i = 0; i < this.storage.length; i++) {
      const chave = this.storage.key(i);
      if (chave && chave.startsWith(PREFIXO)) n++;
    }
    return n;
  }

  async limpar() {
    const remover = [];
    for (let i = 0; i < this.storage.length; i++) {
      const chave = this.storage.key(i);
      if (chave && chave.startsWith(PREFIXO)) remover.push(chave);
    }
    for (const chave of remover) this.storage.removeItem(chave);
  }

  /**
   * O Web Storage não é contabilizado de forma confiável por
   * navigator.storage.estimate(). O uso é calculado diretamente a partir do
   * conteúdo serializado (chave + valor), em bytes UTF-8.
   */
  async quotaDeclaradaBytes() {
    return null; // o Web Storage não é contabilizado por navigator.storage.estimate()
  }

  async usoNavegadorBytes() {
    return null; // idem: a API não contabiliza o Web Storage
  }

  async usoEstimadoBytes() {
    const cod = new TextEncoder();
    let total = 0;
    for (let i = 0; i < this.storage.length; i++) {
      const chave = this.storage.key(i);
      if (chave && chave.startsWith(PREFIXO)) {
        total += cod.encode(chave).length;
        total += cod.encode(this.storage.getItem(chave)).length;
      }
    }
    return total;
  }
}

/* ------------------------------------------------------------------ */
/* IndexedDB                                                           */
/* ------------------------------------------------------------------ */

class AdaptadorIndexedDB {
  constructor() {
    this.nome = 'IndexedDB';
    this.sincrono = false;
    this.db = null;
  }

  async disponivel() {
    return typeof indexedDB !== 'undefined';
  }

  _abrir() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(BD_NOME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(BD_STORE)) {
          db.createObjectStore(BD_STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => {
        this.db = req.result;
        resolve(this.db);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async gravar(registros) {
    const db = await this._abrir();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(BD_STORE, 'readwrite');
      const store = tx.objectStore(BD_STORE);
      for (let i = 0; i < registros.length; i++) store.put(registros[i]);
      // O tempo é contabilizado até a conclusão efetiva da transação.
      tx.oncomplete = () => resolve(registros.length);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Transação abortada'));
    });
  }

  async ler() {
    const db = await this._abrir();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(BD_STORE, 'readonly');
      const req = tx.objectStore(BD_STORE).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  /** Quantidade de registros atualmente gravados no object store. */
  async contar() {
    const db = await this._abrir();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(BD_STORE, 'readonly');
      const req = tx.objectStore(BD_STORE).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async limpar() {
    const db = await this._abrir();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(BD_STORE, 'readwrite');
      tx.objectStore(BD_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Uso de armazenamento medido pelo conteúdo efetivamente gravado: soma dos
   * bytes UTF-8 da chave e do registro serializado, exatamente como no Web
   * Storage. Essa definição torna a métrica comparável entre os três
   * mecanismos.
   *
   * A alternativa, navigator.storage.estimate(), foi descartada como métrica
   * principal por ser atualizada de forma assíncrona pelo navegador: medições
   * imediatamente após a gravação retornavam valores inconsistentes, inclusive
   * diferenças nulas. Ela permanece disponível em usoNavegadorBytes() como
   * medida secundária.
   */
  async usoEstimadoBytes() {
    const cod = new TextEncoder();
    const registros = await this.ler();
    let total = 0;
    for (const r of registros) {
      total += cod.encode(String(r.id)).length;
      total += cod.encode(JSON.stringify(r)).length;
    }
    return total;
  }

  /** Uso relatado pelo navegador (medida secundária, sujeita a atraso). */
  async usoNavegadorBytes() {
    if (!navigator.storage || !navigator.storage.estimate) return null;
    const { usage } = await navigator.storage.estimate();
    return usage ?? null;
  }

  /**
   * Cota declarada pelo navegador para a origem. Diferentemente da inserção
   * progressiva, é obtida sem gravar dados e corresponde ao limite que o
   * próprio navegador informa à aplicação.
   */
  async quotaDeclaradaBytes() {
    if (!navigator.storage || !navigator.storage.estimate) return null;
    const { quota } = await navigator.storage.estimate();
    return quota ?? null;
  }
}

/* ------------------------------------------------------------------ */

export function criarAdaptadores() {
  return [
    new AdaptadorWebStorage('LocalStorage', window.localStorage),
    new AdaptadorWebStorage('SessionStorage', window.sessionStorage),
    new AdaptadorIndexedDB()
  ];
}

/** Identifica erro de estouro de cota em qualquer um dos mecanismos. */
export function isErroDeCota(erro) {
  if (!erro) return false;
  const nome = erro.name || '';
  const msg = (erro.message || '').toLowerCase();
  return (
    nome === 'QuotaExceededError' ||
    nome === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    erro.code === 22 ||
    erro.code === 1014 ||
    msg.includes('quota') ||
    msg.includes('exceeded')
  );
}
