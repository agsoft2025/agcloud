<script lang="ts">
  import { callApi } from "$lib/services/api";
  import { connectToLiveKit } from "$lib/services/livekit";
  import { session } from "$lib/stores/session";

  let email = "";
  let password = "";
  let message = "";

  async function handleLogin() {
    const result = await callApi("/api/auth/login", { email, password });
    message = JSON.stringify(result);
  }

  async function handleConnect() {
    const token = "TODO_LIVEKIT_TOKEN";
    await connectToLiveKit(token);
    message = "LiveKit connect flow started";
  }
</script>

<main>
  <h1>agcloud frontend starter</h1>
  <p>This app uses a backend API and LiveKit for all call signaling.</p>

  <section>
    <h2>Login</h2>
    <input type="email" bind:value={email} placeholder="Email" />
    <input type="password" bind:value={password} placeholder="Password" />
    <button on:click={handleLogin}>Login</button>
  </section>

  <section>
    <h2>LiveKit</h2>
    <button on:click={handleConnect}>Connect to LiveKit</button>
  </section>

  <section>
    <h3>Status</h3>
    <pre>{message}</pre>
  </section>
</main>

<style>
  main {
    max-width: 720px;
    margin: 2rem auto;
    padding: 1rem;
    font-family: system-ui, sans-serif;
  }

  input {
    display: block;
    margin: 0.5rem 0;
    padding: 0.75rem;
    width: 100%;
    box-sizing: border-box;
  }

  button {
    margin-top: 0.75rem;
    padding: 0.75rem 1.5rem;
  }
</style>
