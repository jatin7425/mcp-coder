import express, { type Request, type Response } from 'express';
import { request, type IncomingHttpHeaders } from 'node:http';
import { randomBytes } from 'node:crypto';
import { tokenHash } from '../authentication/tokens.js';
import { AppError } from '../shared/types.js';

const cookieName = '__Host-mcp-code-owner';
const nonce = () => randomBytes(32).toString('base64url');
/** The tunnel enters through the MCP port. Owner-only UI requests proxy to loopback. */
export class RemoteDashboard {
  private code?: { hash: string; expiresAt: number; origin: string };
  private sessions = new Map<string, { expiresAt: number; origin: string }>();
  private attempts = { count: 0, start: 0 };
  constructor(
    private uiPort: number,
    private publicUrl: () => string | undefined,
    private web: string,
  ) {}
  createCode() {
    const origin = this.publicUrl();
    if (!origin) throw new AppError('Start a tunnel before creating a remote login code.');
    const code = nonce();
    this.code = { hash: tokenHash(code), expiresAt: Date.now() + 300_000, origin };
    return { code, expiresAt: new Date(this.code.expiresAt).toISOString(), url: origin };
  }
  clear() {
    this.code = undefined;
    this.sessions.clear();
  }
  private cookie(req: Request) {
    return (req.headers.cookie || '')
      .split(';')
      .map((v) => v.trim())
      .find((v) => v.startsWith(cookieName + '='))
      ?.slice(cookieName.length + 1);
  }
  private authenticated(req: Request) {
    for (const [key, session] of this.sessions)
      if (session.expiresAt <= Date.now()) this.sessions.delete(key);
    const raw = this.cookie(req);
    const session = raw && this.sessions.get(tokenHash(raw));
    return !!session && session.origin === this.publicUrl();
  }
  router() {
    const router = express.Router();
    router.get('/remote-login.js', (_req, res) => res.sendFile(this.web + '/remote-login.js'));
    router.get('/remote-login.css', (_req, res) => res.sendFile(this.web + '/remote-login.css'));
    router.post('/owner/login', express.json({ limit: '4kb' }), (req, res) => {
      if (Date.now() - this.attempts.start >= 60_000)
        this.attempts = { count: 0, start: Date.now() };
      if (++this.attempts.count > 10)
        return res.status(429).json({ error: 'Too many attempts. Try again in a minute.' });
      const supplied = req.body?.code;
      if (
        !this.code ||
        this.code.expiresAt <= Date.now() ||
        this.code.origin !== this.publicUrl() ||
        typeof supplied !== 'string' ||
        supplied.length > 128 ||
        tokenHash(supplied) !== this.code.hash
      )
        return res
          .status(401)
          .json({ error: 'Invalid or expired code. Generate a new code in the local dashboard.' });
      this.code = undefined;
      if (this.sessions.size >= 20)
        return res.status(429).json({ error: 'Too many owner sessions.' });
      const raw = nonce();
      this.sessions.set(tokenHash(raw), {
        expiresAt: Date.now() + 8 * 3600_000,
        origin: this.publicUrl()!,
      });
      res.setHeader(
        'Set-Cookie',
        `${cookieName}=${raw}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=28800`,
      );
      res.json({ ok: true });
    });
    router.post('/owner/logout', (req, res) => {
      const raw = this.cookie(req);
      if (raw) this.sessions.delete(tokenHash(raw));
      res.setHeader(
        'Set-Cookie',
        `${cookieName}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
      );
      res.json({ ok: true });
    });
    router.use((req, res, next) => {
      const uiPath =
        req.path === '/' ||
        ['/app.js', '/style.css', '/icon.svg'].includes(req.path) ||
        req.path.startsWith('/api/');
      if (!uiPath) return next();
      if (!this.authenticated(req)) {
        if (req.path.startsWith('/api/'))
          return res.status(401).json({ error: 'Owner login required.' });
        return res.sendFile(this.web + '/remote-login.html');
      }
      if (decodeURIComponent(req.path).replace(/\/+$/, '').toLowerCase() === '/api/remote/code')
        return res.status(403).json({ error: 'Login codes can only be generated locally.' });
      this.proxy(req, res);
    });
    return router;
  }
  private proxy(req: Request, res: Response) {
    const headers: IncomingHttpHeaders = { ...req.headers, host: `127.0.0.1:${this.uiPort}` };
    delete headers.cookie;
    delete headers.authorization;
    delete headers['x-forwarded-host'];
    delete headers['x-forwarded-for'];
    delete headers['x-forwarded-proto'];
    if (headers.origin) headers.origin = `http://127.0.0.1:${this.uiPort}`;
    const upstream = request(
      {
        hostname: '127.0.0.1',
        port: this.uiPort,
        method: req.method,
        path: req.originalUrl,
        headers,
      },
      (response) => {
        res.status(response.statusCode || 502);
        for (const [key, value] of Object.entries(response.headers))
          if (
            value !== undefined &&
            !['connection', 'transfer-encoding', 'set-cookie'].includes(key)
          )
            res.setHeader(key, value);
        response.pipe(res);
      },
    );
    upstream.setTimeout(30_000, () => upstream.destroy(new Error('Dashboard request timed out.')));
    upstream.on('error', () => {
      if (!res.headersSent) res.status(502).json({ error: 'Local dashboard is unavailable.' });
      else res.destroy();
    });
    res.once('close', () => upstream.destroy());
    req.pipe(upstream);
  }
}
