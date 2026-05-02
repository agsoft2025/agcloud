import { writable } from "svelte/store";

export const session = writable({
  user: null,
  livekitToken: null,
  connected: false
});
