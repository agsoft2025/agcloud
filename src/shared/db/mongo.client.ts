import { MongoClient, Db } from "mongodb";
import config from "../../config/index.js";

const client = new MongoClient(config.mongoUri);
let db: Db | null = null;

export async function connectMongo(): Promise<Db> {
  if (!db) {
    await client.connect();
    db = client.db();
  }
  return db;
}

export function getMongoClient(): MongoClient {
  return client;
}
