// LABUM Awards — API (Vercel Serverless Function, Node.js)
// Banco: Upstash Redis pelo Marketplace da Vercel (variáveis KV_REST_API_URL / KV_REST_API_TOKEN
// ou UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN, injetadas automaticamente).
// Login do criador: variáveis ADMIN_USER e ADMIN_PASSWORD definidas no painel da Vercel.
const crypto = require("crypto");

const EDITION = "labum-2025";                   // mesmo valor de EDITION_ID no index.html
const SESSION_TTL = 60 * 60 * 12;                // 12 horas
const MAX_CONFIG = 400 * 1024;                   // configuração do formulário (sem fotos)
const MAX_IMG = 900 * 1024;                      // foto enviada pelo editor (data URL)
const K = s => `${EDITION}:${s}`;
// repositório de conteúdos (só criador e admins): arquivos em pedaços de até ~700 KB (base64)
const RK = s => `labum-repo:${s}`;               // independente da edição do formulário
const MAX_FILE = 25 * 1024 * 1024;               // 25 MB por arquivo
const CHUNK = 720 * 1024;                        // caracteres base64 por pedaço
const REPO_TIPOS = ["imagem", "video", "audio", "texto", "arquivo"];
const REPO_STATUS = ["novo", "aprovado", "usado", "descartado"];
const clip = (v, n) => String(v == null ? "" : v).trim().slice(0, n);

function env(names) {
  for (const n of names) if (process.env[n]) return process.env[n];
  const k = Object.keys(process.env).find(k => names.some(n => k.endsWith(n)));
  return k ? process.env[k] : "";
}
const R_URL = () => env(["KV_REST_API_URL", "UPSTASH_REDIS_REST_URL"]).replace(/\/$/, "");
const R_TOKEN = () => env(["KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_TOKEN"]);

async function redis(...cmd) {
  const r = await fetch(R_URL(), { method: "POST", headers: { Authorization: `Bearer ${R_TOKEN()}`, "Content-Type": "application/json" }, body: JSON.stringify(cmd) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error("redis: " + (j.error || r.status));
  return j.result;
}

const sha = s => crypto.createHash("sha256").update(String(s)).digest("hex");
const safeEq = (a, b) => { const x = Buffer.from(sha(a)), y = Buffer.from(sha(b)); return crypto.timingSafeEqual(x, y); };
const norm = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const hashPass = (pass, salt) => crypto.pbkdf2Sync(String(pass), salt, 120000, 32, "sha256").toString("hex");
function randomPass() {
  const A = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  return [...crypto.randomBytes(10)].map(b => A[b % A.length]).join("");
}
const slug = name => norm(name).replace(/[^a-z0-9]+/g, "").slice(0, 14) || "admin";
const parse = s => { try { return JSON.parse(s); } catch { return null; } };

function cleanVote(v, src) {
  if (!v || typeof v !== "object" || v.e !== EDITION) return null;
  const n = typeof v.n === "string" ? v.n.trim().slice(0, 40) : "";
  if (!n || typeof v.a !== "object" || !v.a || Array.isArray(v.a)) return null;
  const a = {};
  for (const [k, val] of Object.entries(v.a).slice(0, 120)) {
    if (!/^[a-z0-9-]{1,40}$/.test(k)) continue;
    if (typeof val === "string") a[k] = val.slice(0, 2000);
    else if (Number.isInteger(val) && val >= 1 && val <= 10) a[k] = val;
    else if (Array.isArray(val)) a[k] = val.filter(x => typeof x === "string").slice(0, 20).map(x => x.slice(0, 200));
  }
  return { e: EDITION, n, t: Number(v.t) || Date.now(), a, src };
}

async function session(req) {
  const h = req.headers.authorization || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!tok || tok.length < 20) return null;
  const s = parse(await redis("GET", K("sess:" + sha(tok))));
  if (!s) return null;
  if (s.role === "co" && !(await redis("HEXISTS", K("admins"), s.user))) return null; // admin removido
  return s;
}
async function settings() { return parse(await redis("GET", K("settings"))) || { closed: false }; }

module.exports = async (req, res) => {
  const a = (req.query && req.query.a) || "";
  const send = (code, obj) => { res.setHeader("Cache-Control", "no-store"); res.status(code).json(obj); };
  const body = (req.body && typeof req.body === "object") ? req.body : (parse(req.body) || {});

  if (!R_URL() || !R_TOKEN()) return send(a === "status" ? 200 : 503, { ok: false, configured: false, error: "banco_nao_configurado" });

  try {
    // ---------- público ----------
    if (a === "status") {
      const [st, keys, cfg, pub] = await Promise.all([settings(), redis("HKEYS", K("votes")), redis("GET", K("config")), redis("EXISTS", K("results"))]);
      // quem já votou, como código (o site compara com os nomes dos membros para colorir as fotos)
      const voted = (keys || []).map(k => sha(EDITION + ":" + k).slice(0, 12));
      return send(200, { ok: true, configured: true, closed: !!st.closed, ownerReady: !!(process.env.ADMIN_USER && process.env.ADMIN_PASSWORD), count: voted.length, voted, published: !!pub, config: parse(cfg) });
    }
    if (a === "img") {
      const id = String(req.query.id || "").replace(/[^a-z0-9]/g, "").slice(0, 40);
      const data = id && await redis("GET", K("img:" + id));
      const m = data && /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(data);
      if (!m) { res.status(404); return res.end(); }
      res.setHeader("Content-Type", m[1]);
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable"); // id novo a cada envio
      res.status(200); return res.end(Buffer.from(m[2], "base64"));
    }
    if (a === "results") {
      const r = parse(await redis("GET", K("results")));
      return r ? send(200, { ok: true, results: r }) : send(404, { error: "nao_publicado" });
    }
    if (a === "vote" && req.method === "POST") {
      if ((await settings()).closed) return send(403, { error: "encerrada" });
      if (JSON.stringify(body).length > 60000) return send(413, { error: "grande_demais" });
      const devTok = String(body.device || "");
      if (devTok.length < 20) return send(400, { error: "aparelho_invalido" });
      const v = cleanVote(body.vote, "site");
      if (!v) return send(400, { error: "voto_invalido" });
      const key = norm(v.n);
      const prev = parse(await redis("HGET", K("votes"), key));
      if (prev && prev.dev !== sha(devTok)) return send(409, { error: "nome_em_uso" });
      v.t = Date.now(); v.dev = sha(devTok);
      await redis("HSET", K("votes"), key, JSON.stringify(v));
      return send(200, { ok: true, t: v.t });
    }

    // ---------- login ----------
    if (a === "login" && req.method === "POST") {
      const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "x";
      const lk = K("try:" + sha(ip));
      const tries = await redis("INCR", lk);
      if (tries === 1) await redis("EXPIRE", lk, 600);
      if (tries > 10) return send(429, { error: "muitas_tentativas" });
      const user = String(body.user || "").trim().toLowerCase().slice(0, 40), pass = String(body.pass || "");
      let s = null;
      if (process.env.ADMIN_USER && process.env.ADMIN_PASSWORD && safeEq(user, process.env.ADMIN_USER.trim().toLowerCase()) && safeEq(pass, process.env.ADMIN_PASSWORD)) {
        s = { role: "owner", user, name: process.env.ADMIN_USER };
      } else {
        const ad = parse(await redis("HGET", K("admins"), user));
        if (ad && safeEq(hashPass(pass, ad.salt), ad.hash)) s = { role: "co", user, name: ad.name };
      }
      if (!s) return send(401, { error: "login_invalido" });
      await redis("DEL", lk);
      const tok = crypto.randomBytes(24).toString("hex");
      await redis("SET", K("sess:" + sha(tok)), JSON.stringify(s), "EX", SESSION_TTL);
      return send(200, { token: tok, role: s.role, name: s.name, user: s.user });
    }

    const s = await session(req);
    if (!s) return send(401, { error: "sessao" });

    if (a === "logout" && req.method === "POST") {
      await redis("DEL", K("sess:" + sha((req.headers.authorization || "").slice(7))));
      return send(200, { ok: true });
    }

    // ---------- dados (criador: com nomes; admin: anônimos) ----------
    if (a === "data") {
      const [all, st] = await Promise.all([redis("HGETALL", K("votes")), settings()]);
      const votes = [];
      for (let i = 0; i < (all || []).length; i += 2) { const v = parse(all[i + 1]); if (v) votes.push({ key: all[i], ...v }); }
      if (s.role === "owner") {
        const adm = await redis("HGETALL", K("admins")); const admins = [];
        for (let i = 0; i < (adm || []).length; i += 2) { const x = parse(adm[i + 1]); if (x) admins.push({ user: adm[i], name: x.name, t: x.t }); }
        return send(200, { role: s.role, name: s.name, closed: !!st.closed, admins, votes: votes.map(({ dev, ...v }) => v) });
      }
      const anon = votes.map(v => [sha(EDITION + v.key), v.a]).sort((x, y) => x[0] < y[0] ? -1 : 1).map(x => ({ a: x[1] }));
      return send(200, { role: s.role, name: s.name, closed: !!st.closed, votes: anon });
    }

    // ---------- repositório (criador e admins) ----------
    if (a.startsWith("repo")) {
      const ano = String((req.query.ano || body.ano || "")).replace(/[^0-9a-z-]/gi, "").slice(0, 12);
      if (!ano) return send(400, { error: "ano" });
      const H = RK("items:" + ano);
      const id = String(req.query.id || body.id || "").replace(/[^a-f0-9]/g, "").slice(0, 32);
      const canEdit = m => s.role === "owner" || m.by === s.user;
      if (a === "repolist") {
        const [all, ys] = await Promise.all([redis("HGETALL", H), redis("HKEYS", RK("years"))]);
        const items = [];
        for (let i = 0; i < (all || []).length; i += 2) { const m = parse(all[i + 1]); if (m) items.push({ id: all[i], ...m, mine: m.by === s.user }); }
        items.sort((x, y) => y.em - x.em);
        return send(200, { ok: true, items, years: ys || [], user: s.user, role: s.role });
      }
      if (a === "repoadd" && req.method === "POST") {
        const tipo = REPO_TIPOS.includes(body.tipo) ? body.tipo : "texto";
        const size = Math.max(0, Number(body.size) || 0);
        if (size > MAX_FILE) return send(413, { error: "arquivo_grande_demais" });
        const chunks = tipo === "texto" ? 0 : Math.max(1, Math.min(60, Number(body.chunks) || 0));
        const m = { tipo, titulo: clip(body.titulo, 140), texto: clip(body.texto, 4000), cat: clip(body.cat, 80), quem: clip(body.quem, 200),
          nome: clip(body.nome, 120), mime: clip(body.mime, 80), size, chunks, recebidos: 0, status: "novo", by: s.user, byName: s.name, em: Date.now() };
        if (tipo !== "texto" && !/^(image|video|audio)\/[a-z0-9.+-]+$|^application\/[a-z0-9.+-]+$/.test(m.mime)) return send(400, { error: "tipo_invalido" });
        if (tipo === "texto" && !m.texto && !m.titulo) return send(400, { error: "vazio" });
        const thumb = String(body.thumb || "");
        const nid = crypto.randomBytes(8).toString("hex");
        if (/^data:image\/(jpeg|webp|png);base64,[A-Za-z0-9+/=]+$/.test(thumb) && thumb.length < 120000) { await redis("SET", RK("thumb:" + nid), thumb); m.thumb = true; }
        await redis("HSET", H, nid, JSON.stringify(m));
        await redis("HSET", RK("years"), ano, "1");
        return send(200, { ok: true, id: nid });
      }
      const m = id && parse(await redis("HGET", H, id));
      if (!m) return send(404, { error: "nao_existe" });
      if (a === "repochunk" && req.method === "POST") {
        if (m.by !== s.user) return send(403, { error: "so_autor" });
        const i = Number(body.i), data = String(body.data || "");
        if (!(Number.isInteger(i) && i >= 0 && i < m.chunks) || !data || data.length > CHUNK + 8 || !/^[A-Za-z0-9+/=]+$/.test(data)) return send(400, { error: "pedaco_invalido" });
        await redis("SET", RK(`file:${id}:${i}`), data);
        m.recebidos = Math.max(m.recebidos || 0, i + 1);
        await redis("HSET", H, id, JSON.stringify(m));
        return send(200, { ok: true, completo: m.recebidos >= m.chunks });
      }
      if (a === "repofile") {
        const i = Number(req.query.i) || 0;
        if (!(i >= 0 && i < m.chunks)) return send(400, { error: "pedaco_invalido" });
        const data = await redis("GET", RK(`file:${id}:${i}`));
        return data ? send(200, { ok: true, data, mime: m.mime, chunks: m.chunks }) : send(404, { error: "sem_arquivo" });
      }
      if (a === "repothumb") {
        const t = m.thumb && await redis("GET", RK("thumb:" + id));
        const x = t && /^data:(image\/[a-z]+);base64,(.+)$/.exec(t);
        if (!x) { res.status(404); return res.end(); }
        res.setHeader("Content-Type", x[1]); res.setHeader("Cache-Control", "private, max-age=86400");
        res.status(200); return res.end(Buffer.from(x[2], "base64"));
      }
      if (a === "repoupd" && req.method === "POST") {
        if (body.status != null) { if (!REPO_STATUS.includes(body.status)) return send(400, { error: "status" }); m.status = body.status; }
        if (body.cat != null) m.cat = clip(body.cat, 80);
        if (body.nota != null) m.nota = clip(body.nota, 400);
        if (body.usadoEm != null) m.usadoEm = clip(body.usadoEm, 80);
        if (body.titulo != null || body.texto != null || body.quem != null) {
          if (!canEdit(m)) return send(403, { error: "so_autor" });
          if (body.titulo != null) m.titulo = clip(body.titulo, 140);
          if (body.texto != null) m.texto = clip(body.texto, 4000);
          if (body.quem != null) m.quem = clip(body.quem, 200);
        }
        m.editado = { por: s.name, em: Date.now() };
        await redis("HSET", H, id, JSON.stringify(m));
        return send(200, { ok: true, item: { id, ...m, mine: m.by === s.user } });
      }
      if (a === "repodel" && req.method === "POST") {
        if (!canEdit(m)) return send(403, { error: "so_autor" });
        for (let i = 0; i < (m.chunks || 0); i++) await redis("DEL", RK(`file:${id}:${i}`));
        await redis("DEL", RK("thumb:" + id));
        await redis("HDEL", H, id);
        return send(200, { ok: true });
      }
      return send(404, { error: "acao_desconhecida" });
    }

    if (s.role !== "owner") return send(403, { error: "so_criador" });

    // ---------- só o criador ----------
    if (a === "import" && req.method === "POST") {
      let novos = 0, atual = 0, ign = 0;
      for (const raw of (Array.isArray(body.votes) ? body.votes : []).slice(0, 300)) {
        const v = cleanVote(raw, "código"); if (!v) { ign++; continue; }
        const key = norm(v.n);
        const prev = parse(await redis("HGET", K("votes"), key));
        if (prev && (prev.t || 0) >= v.t) { ign++; continue; }
        if (prev && prev.dev) v.dev = prev.dev;
        await redis("HSET", K("votes"), key, JSON.stringify(v));
        prev ? atual++ : novos++;
      }
      return send(200, { novos, atual, ign });
    }
    if (a === "reassign" && req.method === "POST") {
      const from = String(body.key || ""), to = String(body.to || "").trim().slice(0, 40);
      const prev = parse(await redis("HGET", K("votes"), from));
      if (!prev || !to) return send(404, { error: "nao_existe" });
      const nk = norm(to);
      if (nk === from) return send(200, { ok: true });
      if (await redis("HEXISTS", K("votes"), nk)) return send(409, { error: "destino_ja_votou" });
      prev.moved = { de: from, em: Date.now() }; prev.n = to;
      await redis("HSET", K("votes"), nk, JSON.stringify(prev));
      await redis("HDEL", K("votes"), from);
      return send(200, { ok: true });
    }
    if (a === "delvote" && req.method === "POST") { await redis("HDEL", K("votes"), String(body.key || "")); return send(200, { ok: true }); }
    if (a === "wipe" && req.method === "POST") {
      if (body.confirm !== "APAGAR") return send(400, { error: "confirmacao" });
      await redis("DEL", K("votes")); await redis("DEL", K("results"));
      return send(200, { ok: true });
    }
    if (a === "settings" && req.method === "POST") { await redis("SET", K("settings"), JSON.stringify({ closed: !!body.closed })); return send(200, { ok: true, closed: !!body.closed }); }
    if (a === "saveconfig" && req.method === "POST") {
      if (body.reset) { await redis("DEL", K("config")); return send(200, { ok: true, reset: true }); }
      const c = body.config;
      if (!c || typeof c !== "object" || !Array.isArray(c.secoes) || !Array.isArray(c.membros)) return send(400, { error: "config_invalida" });
      const txt = JSON.stringify({ ...c, savedAt: Date.now() });
      if (txt.length > MAX_CONFIG) return send(413, { error: "config_grande_demais" });
      await redis("SET", K("config"), txt);
      return send(200, { ok: true });
    }
    if (a === "upimg" && req.method === "POST") {
      const data = String(body.data || "");
      if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(data)) return send(400, { error: "imagem_invalida" });
      if (data.length > MAX_IMG) return send(413, { error: "imagem_grande_demais" });
      const id = crypto.randomBytes(8).toString("hex");
      await redis("SET", K("img:" + id), data);
      return send(200, { ok: true, id });
    }
    if (a === "publish" && req.method === "POST") {
      if (!body.results) { await redis("DEL", K("results")); return send(200, { ok: true, published: false }); }
      const txt = JSON.stringify(body.results);
      if (txt.length > MAX_CONFIG) return send(413, { error: "grande_demais" });
      await redis("SET", K("results"), txt);
      return send(200, { ok: true, published: true });
    }
    if (a === "addadmin" && req.method === "POST") {
      const name = String(body.name || "").trim().slice(0, 40);
      if (!name) return send(400, { error: "nome" });
      let user = slug(name) + ".adm";
      while (await redis("HEXISTS", K("admins"), user)) user = slug(name) + (Math.floor(Math.random() * 90) + 10) + ".adm";
      const pass = randomPass(), salt = crypto.randomBytes(16).toString("hex");
      await redis("HSET", K("admins"), user, JSON.stringify({ name, salt, hash: hashPass(pass, salt), t: Date.now() }));
      return send(200, { user, pass, name });
    }
    if (a === "resetadmin" && req.method === "POST") {
      const user = String(body.user || "");
      const ad = parse(await redis("HGET", K("admins"), user));
      if (!ad) return send(404, { error: "nao_existe" });
      const pass = randomPass(); ad.salt = crypto.randomBytes(16).toString("hex"); ad.hash = hashPass(pass, ad.salt);
      await redis("HSET", K("admins"), user, JSON.stringify(ad));
      return send(200, { user, pass, name: ad.name });
    }
    if (a === "deladmin" && req.method === "POST") { await redis("HDEL", K("admins"), String(body.user || "")); return send(200, { ok: true }); }

    return send(404, { error: "acao_desconhecida" });
  } catch (e) {
    console.error(e);
    return send(500, { error: "erro_interno" });
  }
};
