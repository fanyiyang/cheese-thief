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

// Client: connect to the host identified by roomCode. A stable `peerId`
// (persisted by the app) lets the host recognise a returning player so it can
// resume them mid-game; if that id is briefly still held by our just-closed
// peer we retry it a few times rather than failing.
// Callbacks: onConnected(myId), onData(msg), onDisconnect(), onError(err)
export function createClient({ roomCode, peerId, onConnected, onData, onDisconnect, onError }) {
  let peer = null;
  let conn = null;
  let destroyed = false;
  let idAttempt = 0;

  function open() {
    peer = peerId ? new Peer(peerId, PEER_OPTS) : new Peer(PEER_OPTS);
    peer.on('open', (myId) => {
      if (destroyed) return;
      conn = peer.connect(roomCode, { reliable: true });
      conn.on('open', () => onConnected && onConnected(myId));
      conn.on('data', (msg) => onData && onData(msg));
      conn.on('close', () => onDisconnect && onDisconnect());
      conn.on('error', (err) => onError && onError(err));
    });
    peer.on('error', (err) => {
      // our persisted id may still be held on the broker by the just-closed peer —
      // keep retrying it (~18s) so the broker has time to release it before we give up
      if (err.type === 'unavailable-id' && peerId && !destroyed && idAttempt < 15) {
        idAttempt++;
        try { peer.destroy(); } catch (e) {}
        setTimeout(() => { if (!destroyed) open(); }, 1200);
        return;
      }
      onError && onError(err);
    });
  }
  open();

  return {
    get peer() { return peer; },
    connected: () => !!(conn && conn.open),
    send(msg) {
      if (conn && conn.open) conn.send(msg);
    },
    destroy() {
      destroyed = true;
      try { peer && peer.destroy(); } catch (e) {}
    },
  };
}
