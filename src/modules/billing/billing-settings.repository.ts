import { connectMongo } from "../../shared/db/mongo.client.js";

export interface BillingSettings {
  freeMinutes:        number; // default 1 — configurable by admin
  gracePeriodSeconds: number; // default 60 — time after free period before call is cut
}

const DEFAULTS: BillingSettings = {
  freeMinutes:        1,
  gracePeriodSeconds: 60,
};

export class BillingSettingsRepository {
  private collection = connectMongo().then((db) =>
    db.collection<BillingSettings & { _id: string }>("billing_settings"),
  );

  async getSettings(): Promise<BillingSettings> {
    const col = await this.collection;
    const doc = await col.findOne({ _id: "singleton" } as object);
    if (!doc) return { ...DEFAULTS };
    return {
      freeMinutes:        doc.freeMinutes        ?? DEFAULTS.freeMinutes,
      gracePeriodSeconds: doc.gracePeriodSeconds ?? DEFAULTS.gracePeriodSeconds,
    };
  }

  async updateSettings(patch: Partial<BillingSettings>): Promise<BillingSettings> {
    const col = await this.collection;
    const result = await col.findOneAndUpdate(
      { _id: "singleton" } as object,
      { $set: patch },
      { upsert: true, returnDocument: "after" },
    );
    if (!result) return { ...DEFAULTS, ...patch };
    return {
      freeMinutes:        result.freeMinutes        ?? DEFAULTS.freeMinutes,
      gracePeriodSeconds: result.gracePeriodSeconds ?? DEFAULTS.gracePeriodSeconds,
    };
  }
}
