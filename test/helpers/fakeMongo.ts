import { ObjectId } from "mongodb";

/**
 * Minimal in-memory MongoDB stand-in covering only the query/update shapes
 * this codebase actually issues (equality, $or/$and, $in/$nin/$ne, $gt,
 * regex, dotted-path $set/$addToSet). Not a general-purpose Mongo emulator.
 */

type Doc = Record<string, any>;

function getPath(obj: any, path: string): any {
  return path.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function setPath(obj: any, path: string, value: unknown): void {
  const keys = path.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] == null || typeof cur[keys[i]] !== "object") cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a instanceof ObjectId || b instanceof ObjectId) {
    return String(a) === String(b);
  }
  if (a instanceof Date || b instanceof Date) {
    return new Date(a as any).getTime() === new Date(b as any).getTime();
  }
  return a === b;
}

function matchValue(actual: unknown, expected: unknown): boolean {
  if (expected instanceof RegExp) {
    return typeof actual === "string" && expected.test(actual);
  }
  if (expected && typeof expected === "object" && !(expected instanceof ObjectId) && !(expected instanceof Date)) {
    const ops = expected as Record<string, unknown>;
    return Object.entries(ops).every(([op, val]) => {
      switch (op) {
        case "$eq":
          return matchValue(actual, val);
        case "$ne":
          return !matchValue(actual, val);
        case "$in":
          return Array.isArray(val) && (val as unknown[]).some((v) => matchValue(actual, v));
        case "$nin":
          return Array.isArray(val) && !(val as unknown[]).some((v) => matchValue(actual, v));
        case "$gt":
          return actual != null && actual > (val as any);
        case "$gte":
          return actual != null && actual >= (val as any);
        case "$lt":
          return actual != null && actual < (val as any);
        case "$lte":
          return actual != null && actual <= (val as any);
        case "$exists":
          return (actual !== undefined) === Boolean(val);
        default:
          return false;
      }
    });
  }
  if (Array.isArray(actual)) {
    return actual.some((item) => valuesEqual(item, expected));
  }
  return valuesEqual(actual, expected);
}

function matches(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === "$or") return (expected as Doc[]).some((sub) => matches(doc, sub));
    if (key === "$and") return (expected as Doc[]).every((sub) => matches(doc, sub));
    return matchValue(getPath(doc, key), expected);
  });
}

function applyUpdate(doc: Doc, update: Doc): boolean {
  let modified = false;
  if (update.$set) {
    for (const [path, value] of Object.entries(update.$set)) {
      const prev = getPath(doc, path);
      setPath(doc, path, value);
      if (!valuesEqual(prev, value)) modified = true;
    }
  }
  if (update.$addToSet) {
    for (const [path, value] of Object.entries(update.$addToSet)) {
      const arr = getPath(doc, path) ?? [];
      if (!arr.some((v: unknown) => valuesEqual(v, value))) {
        arr.push(value);
        modified = true;
      }
      setPath(doc, path, arr);
    }
  }
  if (update.$unset) {
    for (const path of Object.keys(update.$unset)) {
      const keys = path.split(".");
      let cur = doc;
      for (let i = 0; i < keys.length - 1; i++) cur = cur?.[keys[i]];
      if (cur && keys[keys.length - 1] in cur) {
        delete cur[keys[keys.length - 1]];
        modified = true;
      }
    }
  }
  return modified;
}

function cloneDoc<T>(doc: T): T {
  return JSON.parse(JSON.stringify(doc), (_key, value) => {
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) return new Date(value);
    return value;
  });
}

class FakeCursor<T extends Doc> {
  private results: T[];
  constructor(docs: T[]) {
    this.results = docs;
  }
  sort(spec: Record<string, 1 | -1>): this {
    const [field, dir] = Object.entries(spec)[0] ?? [];
    if (field) {
      this.results = [...this.results].sort((a, b) => {
        const av = getPath(a, field);
        const bv = getPath(b, field);
        if (av === bv) return 0;
        return (av > bv ? 1 : -1) * (dir === -1 ? -1 : 1);
      });
    }
    return this;
  }
  skip(n: number): this {
    this.results = this.results.slice(n);
    return this;
  }
  limit(n: number): this {
    this.results = this.results.slice(0, n);
    return this;
  }
  async toArray(): Promise<T[]> {
    return this.results.map((r) => cloneDoc(r));
  }
}

export class FakeCollection<T extends Doc = Doc> {
  docs: T[] = [];

  seed(docs: T[]): void {
    this.docs = docs.map((d) => cloneDoc(d));
  }

  async insertOne(doc: T): Promise<{ acknowledged: true; insertedId: ObjectId }> {
    const insertedId = (doc as any)._id ?? new ObjectId();
    const stored = { ...cloneDoc(doc), _id: insertedId };
    this.docs.push(stored as T);
    return { acknowledged: true, insertedId };
  }

  async findOne(filter: Doc = {}, _options?: Doc): Promise<T | null> {
    const found = this.docs.find((d) => matches(d, filter));
    return found ? cloneDoc(found) : null;
  }

  find(filter: Doc = {}, options?: { projection?: Record<string, 0 | 1> }): FakeCursor<T> {
    let matched = this.docs.filter((d) => matches(d, filter));
    if (options?.projection) {
      const keys = Object.keys(options.projection);
      matched = matched.map((d) => {
        const projected: Doc = { _id: d._id };
        for (const k of keys) projected[k] = d[k];
        return projected as T;
      });
    }
    return new FakeCursor(matched);
  }

  async findOneAndUpdate(
    filter: Doc,
    update: Doc,
    options?: { projection?: Record<string, 0 | 1>; returnDocument?: "before" | "after" }
  ): Promise<T | null> {
    const doc = this.docs.find((d) => matches(d, filter));
    if (!doc) return null;
    const before = cloneDoc(doc);
    applyUpdate(doc, update);
    const result = options?.returnDocument === "before" ? before : cloneDoc(doc);
    if (options?.projection) {
      const excluded = Object.entries(options.projection)
        .filter(([, v]) => v === 0)
        .map(([k]) => k);
      for (const key of excluded) delete (result as Doc)[key];
    }
    return result as T;
  }

  async updateOne(
    filter: Doc,
    update: Doc,
    options?: { upsert?: boolean }
  ): Promise<{ acknowledged: true; matchedCount: number; modifiedCount: number; upsertedId: ObjectId | null }> {
    const doc = this.docs.find((d) => matches(d, filter));
    if (!doc) {
      if (options?.upsert) {
        const newDoc: Doc = {};
        for (const [key, value] of Object.entries(filter)) {
          if (!key.startsWith("$") && (value === null || typeof value !== "object" || value instanceof ObjectId || value instanceof Date)) {
            setPath(newDoc, key, value);
          }
        }
        applyUpdate(newDoc, update);
        if (update.$setOnInsert) {
          for (const [path, value] of Object.entries(update.$setOnInsert)) setPath(newDoc, path, value);
        }
        const insertedId = newDoc._id ?? new ObjectId();
        newDoc._id = insertedId;
        this.docs.push(newDoc as T);
        return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedId: insertedId };
      }
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedId: null };
    }
    const modified = applyUpdate(doc, update);
    return { acknowledged: true, matchedCount: 1, modifiedCount: modified ? 1 : 0, upsertedId: null };
  }

  async updateMany(
    filter: Doc,
    update: Doc
  ): Promise<{ acknowledged: true; matchedCount: number; modifiedCount: number }> {
    const matched = this.docs.filter((d) => matches(d, filter));
    let modifiedCount = 0;
    for (const doc of matched) {
      if (applyUpdate(doc, update)) modifiedCount++;
    }
    return { acknowledged: true, matchedCount: matched.length, modifiedCount };
  }

  async deleteOne(filter: Doc): Promise<{ acknowledged: true; deletedCount: number }> {
    const idx = this.docs.findIndex((d) => matches(d, filter));
    if (idx === -1) return { acknowledged: true, deletedCount: 0 };
    this.docs.splice(idx, 1);
    return { acknowledged: true, deletedCount: 1 };
  }

  async deleteMany(filter: Doc): Promise<{ acknowledged: true; deletedCount: number }> {
    const before = this.docs.length;
    this.docs = this.docs.filter((d) => !matches(d, filter));
    return { acknowledged: true, deletedCount: before - this.docs.length };
  }

  async countDocuments(filter: Doc = {}): Promise<number> {
    return this.docs.filter((d) => matches(d, filter)).length;
  }

  async createIndex(): Promise<string> {
    return "fake_index";
  }
}

export class FakeDb {
  private collections = new Map<string, FakeCollection<any>>();

  collection<T extends Doc = Doc>(name: string): FakeCollection<T> {
    let col = this.collections.get(name);
    if (!col) {
      col = new FakeCollection<T>();
      this.collections.set(name, col);
    }
    return col;
  }

  async command(_cmd: Record<string, unknown>): Promise<{ ok: 1 }> {
    return { ok: 1 };
  }

  reset(): void {
    this.collections.clear();
  }
}

export function createFakeDb(): FakeDb {
  return new FakeDb();
}
