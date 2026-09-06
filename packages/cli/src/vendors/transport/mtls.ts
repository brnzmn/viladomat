/**
 * Mutual-TLS transport for the certificate-gated registry checks (AEAT VNifV2).
 *
 * The AEAT web service identifies its caller through the TLS handshake: the operator's qualified
 * certificate (an FNMT personal or representative certificate today; the community's own
 * "representante de entidad sin personalidad jurídica" certificate later, with no code change) is
 * presented as a PKCS#12 file. `node:https` takes the file directly (`pfx` + `passphrase`), so no
 * dependency is added and the checks keep using the {@link FetchLike} shape they already have.
 *
 * Boundaries:
 * - the certificate is read from the path in `VX_CLIENT_CERT_P12` on the operator's machine only;
 *   hosted functions never see the variable, the file or the passphrase (`.env.example`);
 * - the passphrase stays in memory for the run and is never written to a log, an error message or
 *   a check row (error text is scrubbed defensively before it leaves this module);
 * - the transport never retries and never lowers certificate verification of the server: the
 *   limiter and the timeout of `vendors/http.ts` apply to it exactly as to the plain `fetch`.
 *
 * Known OpenSSL 3 caveat (to verify with the operator's file): a PKCS#12 exported with legacy
 * ciphers (RC2-40 / 3DES) is refused by Node ≥ 17 with `ERR_CRYPTO_UNSUPPORTED_OPERATION`; the
 * fix is to re-export it (`openssl pkcs12 -legacy -in old.p12 -nodes | openssl pkcs12 -export
 * -out new.p12`), never to lower the security level. The error path below names that remedy.
 */
import { readFileSync } from 'node:fs';
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { envOptional } from '../../lib/env.ts';
import {
  DEFAULT_TIMEOUT_MS,
  type FetchLike,
  type HttpRequestInit,
  type HttpResponse,
} from '../types.ts';

/** Environment variable holding the path to the PKCS#12 file (operator machine only). */
export const CLIENT_CERT_PATH_VAR = 'VX_CLIENT_CERT_P12';
/** Environment variable holding the passphrase of that file; never logged. */
export const CLIENT_CERT_PASSPHRASE_VAR = 'VX_CLIENT_CERT_PASSPHRASE';

export interface ClientCertificate {
  /** PKCS#12 bundle (certificate and private key) as read from disk. */
  pfx: Buffer;
  passphrase?: string;
}

/** The `https.request` signature the transport relies on; injectable so tests never open a socket. */
export type HttpsRequestFn = (
  options: RequestOptions,
  callback: (res: IncomingMessage) => void,
) => ClientRequest;

export interface MtlsFetchOptions extends ClientCertificate {
  /** Socket idle timeout in ms; a safety net under the abort signal the http layer passes in. */
  timeoutMs?: number;
  /** Defaults to `https.request`. Tests pass a stub that records the options it was given. */
  request?: HttpsRequestFn;
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | null {
  const v = headers[name.toLowerCase()];
  if (v === undefined) return null;
  return Array.isArray(v) ? v.join(', ') : String(v);
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const wanted = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === wanted);
}

/**
 * Turn a transport or TLS error into one the operator can act on, without leaking the passphrase.
 * Exported for the unit test; the check layer only ever sees the returned message.
 */
export function describeTransportError(err: unknown, passphrase?: string): Error {
  const original = err instanceof Error ? err : new Error(String(err));
  const code = (original as { code?: unknown }).code;
  const cause = (original as { cause?: unknown }).cause;
  let message =
    original.name === 'AbortError' && cause instanceof Error ? cause.message : original.message;

  if (code === 'ERR_CRYPTO_UNSUPPORTED_OPERATION' || /\bunsupported\b/i.test(message)) {
    message +=
      ` — the PKCS#12 file in ${CLIENT_CERT_PATH_VAR} may use legacy ciphers OpenSSL 3 refuses; ` +
      're-export it with `openssl pkcs12 -legacy -in old.p12 -nodes | openssl pkcs12 -export -out new.p12`.';
  } else if (
    /mac verify failure|ERR_OSSL_PKCS12_MAC_VERIFY_FAILURE/i.test(message + String(code))
  ) {
    message += ` — the passphrase in ${CLIENT_CERT_PASSPHRASE_VAR} was not accepted for the PKCS#12 file.`;
  }
  if (passphrase && passphrase.length > 0) message = message.split(passphrase).join('***');

  const out = new Error(message, { cause: original });
  out.name = original.name === 'Error' ? 'TransportError' : original.name;
  return out;
}

/**
 * A {@link FetchLike} that presents the client certificate on every request. Only `https:` URLs
 * are accepted: a certificate must never be offered over a plain connection.
 */
export function mtlsFetch(options: MtlsFetchOptions): FetchLike {
  const request = options.request ?? httpsRequest;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { pfx, passphrase } = options;

  return (url: string, init: HttpRequestInit = {}) =>
    new Promise<HttpResponse>((resolve, reject) => {
      let target: URL;
      try {
        target = new URL(url);
      } catch {
        reject(new Error(`invalid URL for the certificate transport: ${url}`));
        return;
      }
      if (target.protocol !== 'https:') {
        reject(
          new Error(
            `the certificate transport only speaks https; refused ${target.protocol} for ${target.host}`,
          ),
        );
        return;
      }

      const body = init.body === undefined ? null : Buffer.from(init.body, 'utf8');
      const headers: Record<string, string> = { ...(init.headers ?? {}) };
      if (body && !hasHeader(headers, 'content-length')) {
        headers['Content-Length'] = String(body.byteLength);
      }

      const reqOptions: RequestOptions = {
        protocol: 'https:',
        hostname: target.hostname,
        port: target.port ? Number(target.port) : 443,
        path: `${target.pathname}${target.search}`,
        method: init.method ?? 'GET',
        headers,
        pfx,
        ...(passphrase === undefined ? {} : { passphrase }),
        rejectUnauthorized: true,
        timeout: timeoutMs,
        ...(init.signal ? { signal: init.signal } : {}),
      };

      let settled = false;
      const fail = (err: unknown): void => {
        if (settled) return;
        settled = true;
        reject(describeTransportError(err, passphrase));
      };

      let req: ClientRequest;
      try {
        req = request(reqOptions, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer | string) =>
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
          );
          res.on('error', fail);
          res.on('end', () => {
            if (settled) return;
            settled = true;
            const status = res.statusCode ?? 0;
            const text = Buffer.concat(chunks).toString('utf8');
            const responseHeaders = res.headers;
            resolve({
              ok: status >= 200 && status < 300,
              status,
              headers: { get: (name) => headerValue(responseHeaders, name) },
              text: () => Promise.resolve(text),
            });
          });
        });
      } catch (err) {
        fail(err);
        return;
      }
      req.on('timeout', () => req.destroy(new Error(`timeout after ${timeoutMs} ms`)));
      req.on('error', fail);
      if (body) req.write(body);
      req.end();
    });
}

export interface LoadCertificateDeps {
  env?: (name: string) => string | undefined;
  readFile?: (path: string) => Buffer;
}

/**
 * The operator's client certificate from the environment, or null when none is configured.
 *
 * Reads `VX_CLIENT_CERT_P12` (path to the PKCS#12 file) and `VX_CLIENT_CERT_PASSPHRASE` through
 * `envOptional`. A configured path that cannot be read is an error — the operator asked for the
 * certificate route, so silently falling back to the manual one would hide the misconfiguration.
 * The passphrase never appears in the error.
 */
export function loadClientCertificate(deps: LoadCertificateDeps = {}): ClientCertificate | null {
  const env = deps.env ?? envOptional;
  const read = deps.readFile ?? ((p: string) => readFileSync(p));
  const file = env(CLIENT_CERT_PATH_VAR);
  if (!file) return null;

  let pfx: Buffer;
  try {
    pfx = read(file);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${CLIENT_CERT_PATH_VAR} points to a file that cannot be read (${file}): ${reason}`,
    );
  }
  if (pfx.byteLength === 0) {
    throw new Error(`${CLIENT_CERT_PATH_VAR} points to an empty file (${file})`);
  }
  const passphrase = env(CLIENT_CERT_PASSPHRASE_VAR);
  return passphrase === undefined ? { pfx } : { pfx, passphrase };
}
