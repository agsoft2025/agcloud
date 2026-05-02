import { MongoClient } from "mongodb";
import config from "../config.js";

const client = new MongoClient(config.mongoUri);
let db = null;

export async function connectMongo() {
  if (!db) {
    await client.connect();
    db = client.db();
  }
  return db;
}

export function getMongoClient() {
  return client;
}
