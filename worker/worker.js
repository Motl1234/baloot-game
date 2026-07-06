/**
 * Baloot relay — Cloudflare Worker + Durable Object
 * غرف لعب: مضيف + حتى ٣ ضيوف. الـ Worker يوزّع الرسائل فقط؛
 * منطق اللعبة كله يعمل عند المضيف.
 *
 * البروتوكول:
 *  ضيف → مضيف : أي رسالة JSON تُغلَّف {t:'from', id, m}
 *  مضيف → عامل: {to:'<id>'|'all', m:{...}} فتُفك وتُرسل للضيف/الجميع
 *  أحداث للمضيف: {t:'join', id, name} , {t:'leave', id}
 *  أحداث للضيف : {t:'err', m:'noRoom'|'full'} , {t:'hostGone'}
 */

export class Room {
  constructor(state) {
    this.state = state;
    this.host = null;
    this.guests = new Map(); // id -> {ws, name}
    this.nextId = 1;
  }

  async fetch(req) {
    if (req.headers.get('Upgrade') !== 'websocket')
      return new Response('expected websocket', { status: 426 });

    const url = new URL(req.url);
    const role = url.searchParams.get('role');
    const name = (url.searchParams.get('name') || '').slice(0, 20);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    if (role === 'host') this.attachHost(server);
    else this.attachGuest(server, name);

    return new Response(null, { status: 101, webSocket: client });
  }

  attachHost(ws) {
    if (this.host) { try { this.host.close(4000, 'replaced'); } catch (_) {} }
    this.host = ws;

    ws.addEventListener('message', (e) => {
      let d; try { d = JSON.parse(e.data); } catch (_) { return; }
      if (!d || typeof d !== 'object') return;
      const payload = JSON.stringify(d.m);
      if (d.to === 'all') {
        for (const [, g] of this.guests) { try { g.ws.send(payload); } catch (_) {} }
      } else {
        const g = this.guests.get(String(d.to));
        if (g) { try { g.ws.send(payload); } catch (_) {} }
      }
    });

    const bye = () => {
      if (this.host !== ws) return;
      this.host = null;
      for (const [, g] of this.guests) {
        try { g.ws.send(JSON.stringify({ t: 'hostGone' })); } catch (_) {}
      }
    };
    ws.addEventListener('close', bye);
    ws.addEventListener('error', bye);

    // أخبر المضيف بالضيوف الموجودين مسبقًا (إعادة اتصال المضيف)
    for (const [id, g] of this.guests) {
      try { ws.send(JSON.stringify({ t: 'join', id, name: g.name })); } catch (_) {}
    }
  }

  attachGuest(ws, name) {
    if (!this.host) {
      try { ws.send(JSON.stringify({ t: 'err', m: 'noRoom' })); ws.close(4001, 'no host'); } catch (_) {}
      return;
    }
    if (this.guests.size >= 3) {
      try { ws.send(JSON.stringify({ t: 'err', m: 'full' })); ws.close(4002, 'full'); } catch (_) {}
      return;
    }
    const id = String(this.nextId++);
    this.guests.set(id, { ws, name });
    try { this.host.send(JSON.stringify({ t: 'join', id, name })); } catch (_) {}

    ws.addEventListener('message', (e) => {
      let m; try { m = JSON.parse(e.data); } catch (_) { return; }
      if (this.host) { try { this.host.send(JSON.stringify({ t: 'from', id, m })); } catch (_) {} }
    });

    const bye = () => {
      if (!this.guests.has(id)) return;
      this.guests.delete(id);
      if (this.host) { try { this.host.send(JSON.stringify({ t: 'leave', id })); } catch (_) {} }
    };
    ws.addEventListener('close', bye);
    ws.addEventListener('error', bye);
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/room\/([A-Za-z0-9]{4,8})\/ws$/);
    if (m) {
      const id = env.ROOM.idFromName(m[1].toUpperCase());
      return env.ROOM.get(id).fetch(req);
    }
    return new Response('Baloot relay OK 🃏', {
      headers: { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' },
    });
  },
};
