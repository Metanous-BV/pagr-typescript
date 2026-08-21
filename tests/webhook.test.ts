import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PagrDecodeError, PagrError, PagrSignatureError } from '../src/errors.js';
import {
  DEFAULT_SIGNATURE_TOLERANCE_MS,
  RenderCompletion,
  RenderProgress,
  parseCallback,
  parseSignedCallback,
  verifySignature,
} from '../src/webhook.js';

function docNode(name: string) {
  return {
    id: `doc-${name}`,
    documentName: name,
    templateId: 'tmpl-1',
    versionNumber: 1,
    environment: 'test',
    fileSizeBytes: 10,
    pageCount: 1,
    renderedAt: '2024-01-01T00:00:00Z',
    renderDuration: 1,
    viewUrl: 'https://example.test',
    documentType: 'pdf',
  };
}

describe('parseCallback', () => {
  it('routes a payload carrying a document to RenderProgress', () => {
    const callback = parseCallback({
      jobId: 'job-1',
      processed: 2,
      requestedCount: 5,
      documentIndex: 1,
      document: docNode('Doc'),
    });
    expect(callback).toBeInstanceOf(RenderProgress);
    if (callback instanceof RenderProgress) {
      expect(callback.progressPct).toBe(40);
      expect(callback.requestedCount).toBe(5);
      expect(callback.documentIndex).toBe(1);
      expect(callback.document.documentName).toBe('Doc');
    }
  });

  it('routes a payload without a document to RenderCompletion, parsing state/status/issues', () => {
    const callback = parseCallback({
      jobId: 'job-1',
      state: 'completed',
      status: 'ok',
      renderedCount: 5,
      requestedCount: 5,
      missingCount: 0,
      issues: [],
    });
    expect(callback).toBeInstanceOf(RenderCompletion);
    if (callback instanceof RenderCompletion) {
      expect(callback.ok).toBe(true);
      expect(callback.state).toBe('completed');
      expect(callback.status).toBe('ok');
      expect(callback.missingCount).toBe(0);
    }
  });

  it('accepts a raw JSON string, not just a pre-parsed object', () => {
    const callback = parseCallback(
      JSON.stringify({ jobId: 'job-1', state: 'completed', status: 'insufficient_credit' }),
    );
    expect(callback).toBeInstanceOf(RenderCompletion);
    expect((callback as RenderCompletion).insufficientCredit).toBe(true);
  });

  it('treats an explicit null document the same as an absent one', () => {
    const callback = parseCallback({
      jobId: 'job-1',
      state: 'failed',
      status: 'failed',
      document: null,
    });
    expect(callback).toBeInstanceOf(RenderCompletion);
  });

  it('progressPct is 0 when requestedCount is 0 (avoids division by zero)', () => {
    const callback = RenderProgress.fromApi({
      jobId: 'job-1',
      processed: 0,
      requestedCount: 0,
      documentIndex: 0,
      document: docNode('Doc'),
    });
    expect(callback.progressPct).toBe(0);
  });

  it('throws PagrDecodeError for a progress-shaped payload missing correlation fields', () => {
    expect(() => parseCallback({ jobId: 'job-1', document: docNode('Doc') })).toThrow(
      PagrDecodeError,
    );
  });

  it('throws PagrDecodeError for a completion-shaped payload missing state/status', () => {
    expect(() => parseCallback({ jobId: 'job-1', renderedCount: 1 })).toThrow(PagrDecodeError);
  });

  it('throws PagrDecodeError (not SyntaxError) for a malformed JSON string', () => {
    expect(() => parseCallback('{ not json')).toThrow(PagrDecodeError);
  });

  it('throws PagrDecodeError for a non-object payload', () => {
    expect(() => parseCallback(42)).toThrow(PagrDecodeError);
  });
});

/*
 * Signature verification. The headers below are built the way the Pagr server
 * builds them (`Pagr.Api.Shared/Services/Rendering/WebhookSigner.cs`) — raw
 * `node:crypto`, never by calling the SDK's own verifier, which would only
 * prove the helper agrees with itself. `COMPLETION_BODY` and the hex digests in
 * `canonical vector` are the vector from `Pagr.SDK/docs/parity-contract.md` §9,
 * shared by all six SDKs' tests.
 */
const SECRET = 'whsec_test-secret';
const OTHER_SECRET = 'whsec_someone-elses-secret';
const ROTATED_IN_SECRET = 'whsec_the-new-one';

/** 2026-08-11T08:00:00Z — `t=1754899200` in the canonical vector. */
const NOW_MS = 1_754_899_200_000;

/**
 * Byte-for-byte the canonical vector's body: written as a literal because the
 * spaces after `:` and `,` are part of the signed bytes and `JSON.stringify`
 * would not produce them.
 */
const COMPLETION_BODY = Buffer.from(
  '{"jobId": "3f2504e0-4f89-11d3-9a0c-0305e82c3301", "state": "completed", "status": "ok", "renderedCount": 2, "requestedCount": 2}',
  'utf-8',
);

const PROGRESS_BODY = Buffer.from(
  JSON.stringify({
    jobId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    processed: 1,
    requestedCount: 2,
    documentIndex: 0,
    document: {
      id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      documentName: 'Invoice 1',
      templateId: '1b4e28ba-2fa1-11d2-883f-0016d3cca427',
      versionNumber: 3,
      environment: 'test',
      fileSizeBytes: 1024,
      pageCount: 1,
      renderedAt: '2026-08-11T09:00:00Z',
      renderDuration: 42.0,
      documentType: 'Template',
    },
  }),
  'utf-8',
);

/** Builds an `X-Pagr-Signature` header the way the Pagr server does. */
function sign(body: Uint8Array, secrets: string[], atMs: number = NOW_MS): string {
  const timestamp = Math.floor(atMs / 1000);
  const signed = Buffer.concat([Buffer.from(`${timestamp}.`, 'utf-8'), Buffer.from(body)]);
  const parts = [`t=${timestamp}`];
  for (const secret of secrets) {
    parts.push(`v1=${createHmac('sha256', secret).update(signed).digest('hex')}`);
  }
  return parts.join(',');
}

describe('verifySignature', () => {
  it('matches the canonical vector in docs/parity-contract.md §9', () => {
    // Hardcoded, so this SDK agrees with the other five by construction rather
    // than by each re-deriving the scheme from the server source.
    expect(sign(COMPLETION_BODY, [SECRET])).toBe(
      't=1754899200,v1=bcaa0dced1702951e44a0c10c9729c853d59433fbb954a8c299e743abd89b2bf',
    );
    expect(sign(COMPLETION_BODY, [OTHER_SECRET])).toBe(
      't=1754899200,v1=471267f764e691c424f4d19583d663595c632be130899c42565d07c216f7446a',
    );
    expect(sign(COMPLETION_BODY, [ROTATED_IN_SECRET])).toBe(
      't=1754899200,v1=2ec463ea515f6d65cb098c2b65d38e6f54063459a1e3da06f56bd42e70772f33',
    );

    expect(
      verifySignature(
        COMPLETION_BODY,
        't=1754899200,v1=bcaa0dced1702951e44a0c10c9729c853d59433fbb954a8c299e743abd89b2bf',
        SECRET,
        { nowMs: NOW_MS },
      ),
    ).toBeUndefined();
  });

  it('accepts a signature produced by the server', () => {
    // Returns undefined rather than a bool: nothing to accidentally ignore.
    expect(
      verifySignature(COMPLETION_BODY, sign(COMPLETION_BODY, [SECRET]), SECRET, { nowMs: NOW_MS }),
    ).toBeUndefined();
  });

  it('accepts a string body identically to bytes', () => {
    const header = sign(COMPLETION_BODY, [SECRET]);

    expect(() =>
      verifySignature(COMPLETION_BODY.toString('utf-8'), header, SECRET, { nowMs: NOW_MS }),
    ).not.toThrow();
  });

  it('defaults nowMs to the current clock and toleranceMs to 5 minutes', () => {
    expect(DEFAULT_SIGNATURE_TOLERANCE_MS).toBe(300_000);

    // No nowMs: exercises the Date.now() default path a real receiver uses.
    const header = sign(COMPLETION_BODY, [SECRET], Date.now());

    expect(() => verifySignature(COMPLETION_BODY, header, SECRET)).not.toThrow();
  });

  it('accepts during rotation when only the old secret is held', () => {
    // The server signs with both secrets for the grace period, so a receiver
    // that has not switched over yet must still verify — that is what makes
    // rotation non-breaking.
    const header = sign(COMPLETION_BODY, [ROTATED_IN_SECRET, SECRET]);

    expect(() => verifySignature(COMPLETION_BODY, header, SECRET, { nowMs: NOW_MS })).not.toThrow();
  });

  it('accepts a retry signed within the tolerance', () => {
    // Each retry attempt is re-signed with a fresh timestamp, so a delivery
    // that lands on attempt 4 is not mistaken for a replay.
    const header = sign(COMPLETION_BODY, [SECRET], NOW_MS - 120_000);

    expect(() => verifySignature(COMPLETION_BODY, header, SECRET, { nowMs: NOW_MS })).not.toThrow();
  });

  it('ignores an unknown scheme version', () => {
    // A future v2= alongside v1= must not make the header unparsable.
    const header = `${sign(COMPLETION_BODY, [SECRET])},v2=deadbeef`;

    expect(() => verifySignature(COMPLETION_BODY, header, SECRET, { nowMs: NOW_MS })).not.toThrow();
  });

  it('rejects a tampered body', () => {
    const header = sign(COMPLETION_BODY, [SECRET]);
    const tampered = COMPLETION_BODY.toString('utf-8').replace('completed', 'failed!!!');

    expect(() => verifySignature(tampered, header, SECRET, { nowMs: NOW_MS })).toThrow(
      PagrSignatureError,
    );
    expect(() => verifySignature(tampered, header, SECRET, { nowMs: NOW_MS })).toThrow(
      /matched the configured/,
    );
  });

  it('rejects a re-serialized body', () => {
    // The documented footgun: same JSON *value*, different bytes. Worth
    // pinning, because it is the failure everyone hits first.
    const header = sign(COMPLETION_BODY, [SECRET]);
    const reSerialized = JSON.stringify(JSON.parse(COMPLETION_BODY.toString('utf-8')), null, 2);

    expect(() => verifySignature(reSerialized, header, SECRET, { nowMs: NOW_MS })).toThrow(
      PagrSignatureError,
    );
  });

  it('rejects a signature from another organisation', () => {
    const header = sign(COMPLETION_BODY, [OTHER_SECRET]);

    expect(() => verifySignature(COMPLETION_BODY, header, SECRET, { nowMs: NOW_MS })).toThrow(
      PagrSignatureError,
    );
  });

  it('rejects a replayed callback', () => {
    const header = sign(COMPLETION_BODY, [SECRET], NOW_MS - 1_800_000);

    expect(() => verifySignature(COMPLETION_BODY, header, SECRET, { nowMs: NOW_MS })).toThrow(
      /outside the/,
    );
  });

  it('rejects a future-dated callback', () => {
    // Drift is absolute in both directions, matching the server-side verifier —
    // a far-future t must not buy an attacker an open window.
    const header = sign(COMPLETION_BODY, [SECRET], NOW_MS + 1_800_000);

    expect(() => verifySignature(COMPLETION_BODY, header, SECRET, { nowMs: NOW_MS })).toThrow(
      /outside the/,
    );
  });

  it('honours a configured toleranceMs', () => {
    const header = sign(COMPLETION_BODY, [SECRET], NOW_MS - 600_000);

    expect(() =>
      verifySignature(COMPLETION_BODY, header, SECRET, { toleranceMs: 900_000, nowMs: NOW_MS }),
    ).not.toThrow();
    expect(() =>
      verifySignature(COMPLETION_BODY, header, SECRET, { toleranceMs: 60_000, nowMs: NOW_MS }),
    ).toThrow(PagrSignatureError);
  });

  it.each([[null], [undefined], [''], ['   ']])('rejects an unsigned request (%j)', (header) => {
    expect(() => verifySignature(COMPLETION_BODY, header, SECRET, { nowMs: NOW_MS })).toThrow(
      /no X-Pagr-Signature/,
    );
  });

  it.each([
    ['garbage'],
    ['t=notanumber,v1=abc'],
    ['t=1754899200'], // no signature at all
    ['v1=abc'], // no timestamp, so nothing bounds a replay
  ])('rejects a malformed header (%j)', (header) => {
    expect(() => verifySignature(COMPLETION_BODY, header, SECRET, { nowMs: NOW_MS })).toThrow(
      PagrSignatureError,
    );
  });

  it.each([[''], [undefined], ['   '], ['\t\n']])(
    'treats an absent or blank secret (%j) as a configuration error, not a bad signature',
    (secret) => {
      // Deliberately NOT PagrSignatureError, and deliberately not a silent
      // pass: an unset env var must be loud and distinguishable from a forged
      // callback. Also not a PagrError, so a handler-wide `catch (PagrError)`
      // cannot turn a broken deployment into "callbacks look forged".
      const call = () =>
        verifySignature(COMPLETION_BODY, sign(COMPLETION_BODY, [SECRET]), secret as string, {
          nowMs: NOW_MS,
        });

      expect(call).toThrow(TypeError);
      expect(call).toThrow(/signing secret is required/);
      let thrown: unknown;
      try {
        call();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).not.toBeInstanceOf(PagrSignatureError);
      expect(thrown).not.toBeInstanceOf(PagrError);
    },
  );
});

describe('parseSignedCallback', () => {
  it('verifies and parses a completion', () => {
    const callback = parseSignedCallback(COMPLETION_BODY, sign(COMPLETION_BODY, [SECRET]), SECRET, {
      nowMs: NOW_MS,
    });

    expect(callback).toBeInstanceOf(RenderCompletion);
    expect(callback.jobId).toBe('3f2504e0-4f89-11d3-9a0c-0305e82c3301');
  });

  it('verifies and parses a progress callback', () => {
    const callback = parseSignedCallback(PROGRESS_BODY, sign(PROGRESS_BODY, [SECRET]), SECRET, {
      nowMs: NOW_MS,
    });

    expect(callback).toBeInstanceOf(RenderProgress);
    expect((callback as RenderProgress).documentIndex).toBe(0);
    expect((callback as RenderProgress).document.documentName).toBe('Invoice 1');
  });

  it('accepts a raw string body as well as bytes', () => {
    const callback = parseSignedCallback(
      COMPLETION_BODY.toString('utf-8'),
      sign(COMPLETION_BODY, [SECRET]),
      SECRET,
      { nowMs: NOW_MS },
    );

    expect(callback).toBeInstanceOf(RenderCompletion);
  });

  it('does not parse an unverified payload', () => {
    // The point of the combined helper: a bad signature must fail before the
    // body is decoded, so application code never sees a payload that was not
    // proven to come from Pagr.
    expect(() =>
      parseSignedCallback(COMPLETION_BODY, sign(COMPLETION_BODY, [OTHER_SECRET]), SECRET, {
        nowMs: NOW_MS,
      }),
    ).toThrow(PagrSignatureError);
  });

  it('reports a verified but unparsable body as a decode error', () => {
    const body = Buffer.from('not json at all', 'utf-8');

    expect(() =>
      parseSignedCallback(body, sign(body, [SECRET]), SECRET, { nowMs: NOW_MS }),
    ).toThrow(/not valid JSON/);
  });

  it('reports a verified body of the wrong shape as a decode error', () => {
    const body = Buffer.from(
      JSON.stringify({ jobId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' }),
      'utf-8',
    );

    const call = () => parseSignedCallback(body, sign(body, [SECRET]), SECRET, { nowMs: NOW_MS });

    expect(call).toThrow(PagrDecodeError);
    expect(call).toThrow(/missing/);
  });

  it('rejects an empty secret before touching the body', () => {
    expect(() =>
      parseSignedCallback(COMPLETION_BODY, sign(COMPLETION_BODY, [SECRET]), '', { nowMs: NOW_MS }),
    ).toThrow(TypeError);
  });
});
