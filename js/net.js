// Thin wrapper around PeerJS for host-authoritative play.
// PeerJS is loaded globally from a CDN <script> in index.html.
/* global Peer */

// PeerJS's free public broker handles signaling; the data flows peer-to-peer.
const PEER_OPTS = { debug: 1 };

// Host: peer id IS the room code, so clients can connect knowing only the code.
// Callbacks: onReady(code), onConnect(peerId), onData(peerId, msg),
//            onDisconnect(peerId), onError(err)
export function createHost({
  roomCode,
  onReady,
  onConnect,
  onData,
  onDisconnect,
  onError,
}) {
  const peer = new Peer(roomCode, PEER_OPTS);
  const conns = new Map(); // peerId -> DataConnection

  peer.on('open', (id) => onReady && onReady(id));
  peer.on('error', (err) => onError && onError(err));

  peer.on('connection', (conn) => {
    conn.on('open', () => {
      conns.set(conn.peer, conn);
      onConnect && onConnect(conn.peer);
    });
    conn.on('data', (msg) => onData && onData(conn.peer, msg));
    conn.on('close', () => {
      conns.delete(conn.peer);
      onDisconnect && onDisconnect(conn.peer);
    });
  });

  return {
    peer,
    id: () => peer.id,
    peers: () => [...conns.keys()],
    sendTo(peerId, msg) {
      const c = conns.get(peerId);
      if (c && c.open) c.send(msg);
    },
    broadcast(msg) {
      for (const c of conns.values()) if (c.open) c.send(msg);
    },
    destroy() {
      peer.destroy();
    },
  };
}

// Client: connect to the host identified by roomCode.
// Callbacks: onConnected(), onData(msg), onDisconnect(), onError(err)
export function createClient({ roomCode, onConnected, onData, onDisconnect, onError }) {
  const peer = new Peer(PEER_OPTS);
  let conn = null;

  peer.on('open', () => {
    conn = peer.connect(roomCode, { reliable: true });
    conn.on('open', () => onConnected && onConnected());
    conn.on('data', (msg) => onData && onData(msg));
    conn.on('close', () => onDisconnect && onDisconnect());
    conn.on('error', (err) => onError && onError(err));
  });
  peer.on('error', (err) => onError && onError(err));

  return {
    peer,
    send(msg) {
      if (conn && conn.open) conn.send(msg);
    },
    destroy() {
      peer.destroy();
    },
  };
}
