import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:4000/test-session');

ws.on('open', () => {
  console.log('Connected! Sending caller message...');
  ws.send(JSON.stringify({ 
    text: 'I need an oil change this Friday for my Honda City' 
  }));
});

ws.on('message', (data) => {
  console.log('Received response from server:');
  try {
    const parsed = JSON.parse(data.toString());
    console.log(JSON.stringify(parsed, null, 2));
  } catch (e) {
    console.log(data.toString());
  }
});

ws.on('error', (err) => {
  console.error('WebSocket error:', err.message);
});