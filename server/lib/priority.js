/**
 * Priorité en cas d'affluence, et seulement dans ce cas.
 * Tant que le serveur a de la marge, tout le monde passe tout de suite : le gratuit n'est jamais
 * ralenti exprès. Quand il sature, les lots des comptes Pro (donateurs) passent devant ; les autres
 * attendent quelques secondes leur tour au lieu d'un refus.
 */
export class Gate {
  #active = 0;
  #queue = [];

  constructor({ capacity = 40, maxWait = 10_000 } = {}) {
    this.capacity = capacity;
    this.maxWait = maxWait;
  }

  get active() {
    return this.#active;
  }

  get waiting() {
    return this.#queue.length;
  }

  get saturated() {
    return this.#active >= this.capacity;
  }

  /** Renvoie true quand la requête peut passer, false si l'attente a été trop longue. */
  enter(priority = false) {
    if (priority || this.#active < this.capacity) {
      this.#active++;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const entry = {
        resolve,
        timer: setTimeout(() => {
          this.#queue.splice(this.#queue.indexOf(entry), 1);
          resolve(false);
        }, this.maxWait),
      };
      this.#queue.push(entry);
    });
  }

  leave() {
    this.#active--;
    while (this.#queue.length > 0 && this.#active < this.capacity) {
      const next = this.#queue.shift();
      clearTimeout(next.timer);
      this.#active++;
      next.resolve(true);
    }
  }
}
