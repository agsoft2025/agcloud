import React from 'react';

interface CallPanelProps {
  roomName: string;
  participantCount: number;
}

const CallPanel: React.FC<CallPanelProps> = ({ roomName, participantCount }) => {
  return (
    <section style={{
      border: '1px solid #ddd',
      borderRadius: '0.5rem',
      padding: '1rem',
      marginTop: '1.5rem'
    }}>
      <h2>Call panel</h2>
      <p>Room: {roomName || 'not connected'}</p>
      <p>Participants: {participantCount}</p>
      <button disabled={!roomName} style={{ marginTop: '0.75rem', padding: '0.6rem 1rem' }}>
        Leave call
      </button>
    </section>
  );
};

export default CallPanel;