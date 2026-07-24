export type ArchiveSearch = {
  q: string;
  game: "csgo" | "cs2" | "";
  from: string;
  to: string;
};

export function validateArchiveSearch(search: Record<string, unknown>): ArchiveSearch {
  return {
    q: typeof search.q === "string" ? search.q : "",
    game: search.game === "csgo" || search.game === "cs2" ? search.game : "",
    from: typeof search.from === "string" ? search.from : "",
    to: typeof search.to === "string" ? search.to : "",
  };
}

export function archiveSearchParams(search: ArchiveSearch): URLSearchParams {
  const parameters = new URLSearchParams();
  if (search.q) parameters.set("q", search.q);
  if (search.game) parameters.set("game", search.game);
  if (search.from) parameters.set("from", search.from);
  if (search.to) parameters.set("to", search.to);
  return parameters;
}

export function resetArchiveSearch(): ArchiveSearch {
  return { q: "", game: "", from: "", to: "" };
}

export type SearchStatus = "loading" | "updating" | "ready" | "empty" | "unavailable";

export type SearchState<T> = {
  requestId: number;
  hits: T[];
  status: SearchStatus;
  error: string;
};

export type SearchStateAction<T> =
  | { type: "request"; requestId: number }
  | { type: "success"; requestId: number; hits: T[] }
  | { type: "failure"; requestId: number; error: string };

export function createSearchState<T>(): SearchState<T> {
  return { requestId: 0, hits: [], status: "loading", error: "" };
}

export function searchStateReducer<T>(state: SearchState<T>, action: SearchStateAction<T>): SearchState<T> {
  if (action.type === "request") {
    return {
      ...state,
      requestId: action.requestId,
      status: state.hits.length > 0 ? "updating" : "loading",
      error: "",
    };
  }

  if (action.requestId !== state.requestId && !(state.requestId === 0 && state.status === "loading" && action.requestId === 1)) {
    return state;
  }

  if (action.type === "success") {
    return {
      requestId: action.requestId,
      hits: action.hits,
      status: action.hits.length > 0 ? "ready" : "empty",
      error: "",
    };
  }

  return { ...state, requestId: action.requestId, status: "unavailable", error: action.error };
}

export type NoteBodyRecord<T> = {
  status: "pending" | "ready" | "error";
  promise: Promise<T>;
  controller?: AbortController;
  value?: T;
  error?: unknown;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

const resolverByPromise = new WeakMap<Promise<unknown>, Deferred<unknown>>();

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  const result = { promise, resolve, reject };
  resolverByPromise.set(promise, result as Deferred<unknown>);
  return result;
}

function deferredResolver<T>(promise: Promise<T>): Deferred<T> | undefined {
  return resolverByPromise.get(promise) as Deferred<T> | undefined;
}

export class NoteBodyCache<T> {
  #records = new Map<string, NoteBodyRecord<T>>();
  #queue: string[] = [];
  #active = 0;

  constructor(
    private readonly fetcher: (id: string, signal: AbortSignal) => Promise<T>,
    private readonly maxActive = 4,
    private readonly onChange?: () => void,
  ) {}

  ensure(id: string): Promise<T> {
    const existing = this.#records.get(id);
    if (existing) return existing.promise;

    const next = deferred<T>();
    this.#records.set(id, { status: "pending", promise: next.promise });
    this.#queue.push(id);
    this.#startQueued();
    return next.promise;
  }

  prefetch(ids: Iterable<string>) {
    for (const id of new Set(ids)) void this.ensure(id).catch(() => undefined);
  }

  retain(ids: Iterable<string>) {
    const visible = new Set(ids);
    this.#queue = this.#queue.filter((id) => {
      if (visible.has(id)) return true;
      this.#records.delete(id);
      return false;
    });
    this.onChange?.();
  }

  retry(id: string): Promise<T> {
    const existing = this.#records.get(id);
    if (!existing || existing.status !== "error") return this.ensure(id);
    this.#records.delete(id);
    return this.ensure(id);
  }

  record(id: string) {
    return this.#records.get(id);
  }

  queuedIds() {
    return [...this.#queue];
  }

  #startQueued() {
    while (this.#active < this.maxActive && this.#queue.length > 0) {
      const id = this.#queue.shift();
      if (!id) continue;
      const record = this.#records.get(id);
      if (!record || record.controller) continue;

      const controller = new AbortController();
      record.controller = controller;
      this.#active += 1;
      this.onChange?.();
      void this.fetcher(id, controller.signal).then(
        (value) => {
          if (this.#records.get(id) !== record) return;
          record.status = "ready";
          record.value = value;
          record.controller = undefined;
          deferredResolver(record.promise)?.resolve(value);
          this.onChange?.();
        },
        (error: unknown) => {
          if (this.#records.get(id) !== record) return;
          record.status = "error";
          record.error = error;
          record.controller = undefined;
          deferredResolver(record.promise)?.reject(error);
          this.onChange?.();
        },
      ).finally(() => {
        this.#active -= 1;
        this.#startQueued();
      });
    }
  }
}
