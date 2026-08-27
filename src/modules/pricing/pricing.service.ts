import { PricingRepository } from "./pricing.repository.js";
import type { PricingRateDocument } from "./pricing.schemas.js";

const repo = new PricingRepository();

export async function getActiveRate(
  callType: "audio" | "video",
  asOf?: Date,
): Promise<PricingRateDocument | null> {
  return repo.findActiveRate(callType, asOf);
}

export async function getActiveRates(asOf?: Date): Promise<{
  audio: PricingRateDocument | null;
  video: PricingRateDocument | null;
}> {
  const [audio, video] = await Promise.all([
    repo.findActiveRate("audio", asOf),
    repo.findActiveRate("video", asOf),
  ]);
  return { audio, video };
}
