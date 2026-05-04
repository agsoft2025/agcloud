import { AccessToken, VideoGrant } from "livekit-server-sdk";
import config from "../config.js";

export function createLiveKitToken(identity) {
  const at = new AccessToken(config.livekitApiKey, config.livekitApiSecret, {
    identity,
    ttl: 60 * 60
  });

  const grant = new VideoGrant();
  at.addGrant(grant);

  return at.toJwt();
}

export function getLiveKitBaseUrl() {
  return config.livekitUrl;
}
