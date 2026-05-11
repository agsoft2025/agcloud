import React, { useState } from 'react';
import CallPanel from '$components/CallPanel';
import { callApi } from '$lib/services/api';
import { connectToLiveKit } from '$lib/services/livekit';

const Home: React.FC = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');

  const handleLogin = async () => {
    try {
      const result = await callApi('/api/auth/login', { email, password });
      setMessage(JSON.stringify(result));
    } catch (error) {
      setMessage(`Error: ${error}`);
    }
  };

  const handleConnect = async () => {
    const token = 'TODO_LIVEKIT_TOKEN';
    try {
      await connectToLiveKit(token);
      setMessage('LiveKit connect flow started');
    } catch (error) {
      setMessage(`Error: ${error}`);
    }
  };

  return (
    <main style={{ maxWidth: '720px', margin: '2rem auto', padding: '1rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1>agcloud frontend starter</h1>
      <p>This app uses a backend API and LiveKit for all call signaling.</p>

      <section>
        <h2>Login</h2>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email"
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
        />
        <button onClick={handleLogin}>Login</button>
      </section>

      <section>
        <h2>LiveKit</h2>
        <button onClick={handleConnect}>Connect to LiveKit</button>
      </section>

      <CallPanel roomName="" participantCount={0} />

      <section>
        <h3>Status</h3>
        <pre>{message}</pre>
      </section>
    </main>
  );
};

export default Home;