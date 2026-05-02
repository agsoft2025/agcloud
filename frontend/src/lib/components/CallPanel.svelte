<script lang="ts">
  export let roomName = "";
  export let participantCount = 0;
</script>

<section>
  <h2>Call panel</h2>
  <p>Room: {roomName || "not connected"}</p>
  <p>Participants: {participantCount}</p>
  <button disabled={!roomName}>Leave call</button>
</section>

<style>
  section {
    border: 1px solid #ddd;
    border-radius: 0.5rem;
    padding: 1rem;
    margin-top: 1.5rem;
  }

  button {
    margin-top: 0.75rem;
    padding: 0.6rem 1rem;
  }
</style>
