/**
 * Certificate transport — unit tests with a stubbed `https.request`. No socket is ever opened:
 * the stub records the options it receives and answers with an in-memory stream.
 */
import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  CLIENT_CERT_PASSPHRASE_VAR,
  CLIENT_CERT_PATH_VAR,
  describeTransportError,
  loadClientCertificate,
  mtlsFetch,
  type HttpsRequestFn,
} from './mtls.ts';

interface Reply {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  /** Emitted on the request instead of answering. */
  error?: Error;
  /** Thrown synchronously by `https.request` (what a bad PKCS#12 does when the context is built). */
  throws?: Error;
}

interface Call {
  options: RequestOptions;
  written: Buffer[];
  ended: boolean;
}

/** A stand-in for `https.request` that never touches the network. */
function stubHttps(reply: Reply): { request: HttpsRequestFn; calls: Call[] } {
  const calls: Call[] = [];
  const request: HttpsRequestFn = (options, callback) => {
    if (reply.throws) throw reply.throws;
    const call: Call = { options, written: [], ended: false };
    calls.push(call);
    const req = new EventEmitter() as EventEmitter & {
      write: (chunk: Buffer | string) => boolean;
      end: () => unknown;
      destroy: (err?: Error) => unknown;
    };
    req.write = (chunk) => {
      call.written.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    };
    req.destroy = (err) => {
      if (err) req.emit('error', err);
      return req;
    };
    req.end = () => {
      call.ended = true;
      queueMicrotask(() => {
        if (reply.error) {
          req.emit('error', reply.error);
          return;
        }
        const res = new PassThrough() as PassThrough & {
          statusCode?: number;
          headers: Record<string, string>;
        };
        res.statusCode = reply.status ?? 200;
        res.headers = reply.headers ?? {};
        callback(res as unknown as IncomingMessage);
        res.end(reply.body ?? '');
      });
      return req;
    };
    return req as unknown as ClientRequest;
  };
  return { request, calls };
}

const PFX = Buffer.from('not-a-real-pkcs12-bundle');
const URL_VNIF = 'https://www1.agenciatributaria.gob.es/wlpl/BURT-JDIT/ws/VNifV2SOAP?x=1';

describe('mtlsFetch', () => {
  it('presents the PKCS#12 and passphrase and forwards method, headers and body', async () => {
    const stub = stubHttps({
      status: 200,
      headers: { 'content-type': 'text/xml;charset=UTF-8' },
      body: '<ok/>',
    });
    const fetch = mtlsFetch({
      pfx: PFX,
      passphrase: 'pass-phrase',
      request: stub.request,
      timeoutMs: 1234,
    });
    const controller = new AbortController();
    const res = await fetch(URL_VNIF, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '""' },
      body: '<req>é</req>',
      signal: controller.signal,
    });

    expect(stub.calls).toHaveLength(1);
    const { options, written, ended } = stub.calls[0] as Call;
    expect(options.pfx).toBe(PFX);
    expect(options.passphrase).toBe('pass-phrase');
    expect(options.rejectUnauthorized).toBe(true);
    expect(options.method).toBe('POST');
    expect(options.protocol).toBe('https:');
    expect(options.hostname).toBe('www1.agenciatributaria.gob.es');
    expect(options.port).toBe(443);
    expect(options.path).toBe('/wlpl/BURT-JDIT/ws/VNifV2SOAP?x=1');
    expect(options.timeout).toBe(1234);
    expect(options.signal).toBe(controller.signal);
    const headers = options.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('text/xml; charset=utf-8');
    expect(headers.SOAPAction).toBe('""');
    expect(headers['Content-Length']).toBe(String(Buffer.byteLength('<req>é</req>', 'utf8')));
    expect(Buffer.concat(written).toString('utf8')).toBe('<req>é</req>');
    expect(ended).toBe(true);

    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/xml;charset=UTF-8');
    expect(res.headers.get('x-missing')).toBeNull();
    await expect(res.text()).resolves.toBe('<ok/>');
  });

  it('omits the passphrase option when none is configured and sends no body for a GET', async () => {
    const stub = stubHttps({ status: 401, body: 'certificado no admitido' });
    const res = await mtlsFetch({ pfx: PFX, request: stub.request })(URL_VNIF);
    const { options, written } = stub.calls[0] as Call;
    expect('passphrase' in options).toBe(false);
    expect(options.method).toBe('GET');
    expect((options.headers as Record<string, string>)['Content-Length']).toBeUndefined();
    expect(written).toHaveLength(0);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
    await expect(res.text()).resolves.toBe('certificado no admitido');
  });

  it('refuses a plain http URL and a malformed one without calling https', async () => {
    const stub = stubHttps({});
    const fetch = mtlsFetch({ pfx: PFX, request: stub.request });
    await expect(fetch('http://www1.agenciatributaria.gob.es/x')).rejects.toThrow(
      /only speaks https/,
    );
    await expect(fetch('not a url')).rejects.toThrow(/invalid URL/);
    expect(stub.calls).toHaveLength(0);
  });

  it('rejects with the transport error and never lets the passphrase into the message', async () => {
    const secret = 'my-secret-passphrase';
    const stub = stubHttps({
      error: Object.assign(new Error(`handshake failed for ${secret}`), { code: 'ECONNRESET' }),
    });
    const fetch = mtlsFetch({ pfx: PFX, passphrase: secret, request: stub.request });
    const err = await fetch(URL_VNIF, { method: 'POST', body: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain(secret);
    expect((err as Error).message).toContain('handshake failed for ***');
  });

  it('rejects when https.request itself throws (unreadable PKCS#12) and names the remedy', async () => {
    const stub = stubHttps({
      throws: Object.assign(new Error('unsupported'), { code: 'ERR_CRYPTO_UNSUPPORTED_OPERATION' }),
    });
    const fetch = mtlsFetch({ pfx: PFX, passphrase: 'operator-passphrase', request: stub.request });
    await expect(fetch(URL_VNIF)).rejects.toThrow(/openssl pkcs12 -legacy/);
    expect(stub.calls).toHaveLength(0);
  });
});

describe('describeTransportError', () => {
  it('names the legacy-cipher remedy for an unsupported PKCS#12', () => {
    const e = describeTransportError(
      Object.assign(new Error('unsupported'), { code: 'ERR_CRYPTO_UNSUPPORTED_OPERATION' }),
    );
    expect(e.message).toContain(CLIENT_CERT_PATH_VAR);
    expect(e.message).toContain('openssl pkcs12 -legacy');
    expect(e.cause).toBeInstanceOf(Error);
  });

  it('points at the passphrase variable on a MAC failure, without the value', () => {
    const e = describeTransportError(new Error('mac verify failure'), 'hunter2');
    expect(e.message).toContain(CLIENT_CERT_PASSPHRASE_VAR);
    expect(e.message).not.toContain('hunter2');
  });

  it('surfaces the cause of an abort (the http-layer timeout)', () => {
    const abort = Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
      cause: new Error('timeout after 10000 ms'),
    });
    expect(describeTransportError(abort).message).toBe('timeout after 10000 ms');
  });

  it('wraps non-Error values', () => {
    expect(describeTransportError('boom').message).toBe('boom');
  });
});

describe('loadClientCertificate', () => {
  const envOf = (vars: Record<string, string | undefined>) => (name: string) => vars[name];

  it('returns null when the path variable is unset or empty', () => {
    expect(loadClientCertificate({ env: envOf({}) })).toBeNull();
    expect(loadClientCertificate({ env: envOf({ [CLIENT_CERT_PATH_VAR]: '' }) })).toBeNull();
  });

  it('reads the file at the configured path and the passphrase', () => {
    const read: string[] = [];
    const cert = loadClientCertificate({
      env: envOf({
        [CLIENT_CERT_PATH_VAR]: '/secure/operator.p12',
        [CLIENT_CERT_PASSPHRASE_VAR]: 'pp',
      }),
      readFile: (p) => {
        read.push(p);
        return PFX;
      },
    });
    expect(read).toEqual(['/secure/operator.p12']);
    expect(cert).toEqual({ pfx: PFX, passphrase: 'pp' });
  });

  it('leaves the passphrase out when it is not configured', () => {
    const cert = loadClientCertificate({
      env: envOf({ [CLIENT_CERT_PATH_VAR]: '/secure/operator.p12' }),
      readFile: () => PFX,
    });
    expect(cert).toEqual({ pfx: PFX });
    expect(cert && 'passphrase' in cert).toBe(false);
  });

  it('fails clearly, without the passphrase, when the file cannot be read or is empty', () => {
    const env = envOf({
      [CLIENT_CERT_PATH_VAR]: '/missing.p12',
      [CLIENT_CERT_PASSPHRASE_VAR]: 'hunter2',
    });
    expect(() =>
      loadClientCertificate({
        env,
        readFile: () => {
          throw new Error('ENOENT: no such file or directory');
        },
      }),
    ).toThrow(/VX_CLIENT_CERT_P12 points to a file that cannot be read \(\/missing\.p12\): ENOENT/);
    let message = '';
    try {
      loadClientCertificate({ env, readFile: () => Buffer.alloc(0) });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/empty file/);
    expect(message).not.toContain('hunter2');
  });
});
