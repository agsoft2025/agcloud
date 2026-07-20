import { connectMongo } from "../../shared/db/mongo.client.js";

export interface ContactDocument {
  ownerId: string;
  contactId: string;
  createdAt: Date;
}

export class ContactRepository {
  private async getCollection() {
    const db = await connectMongo();
    return db.collection<ContactDocument>("contacts");
  }

  async addContact(ownerId: string, contactId: string): Promise<void> {
    const collection = await this.getCollection();
    await collection.updateOne(
      { ownerId, contactId },
      { $setOnInsert: { ownerId, contactId, createdAt: new Date() } },
      { upsert: true }
    );
  }

  async removeContact(ownerId: string, contactId: string): Promise<boolean> {
    const collection = await this.getCollection();
    const result = await collection.deleteOne({ ownerId, contactId });
    return result.deletedCount > 0;
  }

  async listContactIds(ownerId: string): Promise<string[]> {
    const collection = await this.getCollection();
    const docs = await collection.find({ ownerId }).toArray();
    return docs.map((d) => d.contactId);
  }

  async isContact(ownerId: string, contactId: string): Promise<boolean> {
    const collection = await this.getCollection();
    const doc = await collection.findOne({ ownerId, contactId });
    return doc !== null;
  }

  /**
   * Users who have `contactId` saved as one of their own contacts — i.e. who
   * should be notified when `contactId`'s presence changes. Used to scope
   * presence broadcasts instead of emitting to every connected socket.
   */
  async getWatchersOf(contactId: string): Promise<string[]> {
    const collection = await this.getCollection();
    const docs = await collection.find({ contactId }).toArray();
    return docs.map((d) => d.ownerId);
  }
}
