'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Check, Copy, RefreshCw, Smartphone } from 'lucide-react';
import { Button } from '@/components/ui';
import { copyToClipboard } from '../clipboard';

/**
 * Connect Device (#2251, epic #2242) — the admin-only half of native-API device
 * pairing. Mints a short-lived one-time pairing code (via `POST /napi/pair`) and
 * renders it as a QR + the raw 6-char code + a live countdown. The admin's phone
 * (Solaris companion app) scans/enters the code, which the app redeems at the
 * PUBLIC `POST /napi/pair/redeem` for a read-scoped token. This page never sees
 * the token; it only produces the code.
 */

interface PairResponse {
  code: string;
  qr_url: string;
  expires_at: string;
}

function secondsLeft(expiresAt: string): number {
  return Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000));
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Owns the pairing-code lifecycle: mint via /napi/pair, then a 1-Hz countdown
 *  that expires the code at 0. Kept as a hook so the section body stays lean. */
function usePairing() {
  const [pair, setPair] = useState<PairResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const generate = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/napi/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail?.error || `Could not generate a pairing code (HTTP ${res.status}).`);
      }
      const data = (await res.json()) as PairResponse;
      setPair(data);
      setRemaining(secondsLeft(data.expires_at));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not generate a pairing code.');
      setPair(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!pair) return;
    tickRef.current = setInterval(() => {
      const left = secondsLeft(pair.expires_at);
      setRemaining(left);
      if (left <= 0 && tickRef.current) {
        clearInterval(tickRef.current);
        tickRef.current = null;
      }
    }, 1000);
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
      tickRef.current = null;
    };
  }, [pair]);

  const expired = pair !== null && remaining <= 0;
  return { pair, loading, error, remaining, expired, generate };
}

export default function ConnectDeviceSection() {
  const { pair, loading, error, remaining, expired, generate } = usePairing();
  const [copied, setCopied] = useState(false);

  const onCopy = useCallback(async () => {
    if (!pair) return;
    await copyToClipboard(pair.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [pair]);

  return (
    <div className="space-y-4">
      <p className="text-sm text-text-subtle">
        Pair a phone or companion app with a one-time code. Generate a code below, then scan the
        QR (or type the 6-character code) in the app. The code is single-use, expires in a few
        minutes, and grants the device <strong className="text-text">read-only</strong> access — it
        can view your box but never change or delete anything.
      </p>

      {!pair && (
        <Button onClick={generate} disabled={loading} data-testid="pair-generate">
          <Smartphone size={16} className="mr-2" />
          {loading ? 'Generating…' : 'Generate pairing code'}
        </Button>
      )}

      {error && (
        <p className="text-sm text-status-fail" role="alert">{error}</p>
      )}

      {pair && (
        <PairPanel
          pair={pair}
          expired={expired}
          remaining={remaining}
          copied={copied}
          loading={loading}
          onCopy={onCopy}
          onRegenerate={generate}
        />
      )}
    </div>
  );
}

function PairPanel({
  pair, expired, remaining, copied, loading, onCopy, onRegenerate,
}: {
  pair: PairResponse;
  expired: boolean;
  remaining: number;
  copied: boolean;
  loading: boolean;
  onCopy: () => void;
  onRegenerate: () => void;
}) {
  return (
    <div className="flex flex-col sm:flex-row gap-6 items-start" data-testid="pair-panel">
      <div className={`rounded-card bg-white p-4 ${expired ? 'opacity-30' : ''}`}>
        <QRCodeSVG value={pair.qr_url} size={192} level="M" data-testid="pair-qr" />
      </div>
      <div className="space-y-3">
        <div>
          <div className="text-xs uppercase tracking-wide text-text-subtle">Pairing code</div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-2xl tracking-[0.3em] text-text" data-testid="pair-code">
              {pair.code}
            </span>
            <button
              type="button"
              onClick={onCopy}
              aria-label={copied ? 'Copied' : 'Copy code'}
              className="text-text-subtle hover:text-text"
            >
              {copied ? <Check size={16} /> : <Copy size={16} />}
            </button>
          </div>
        </div>
        <div data-testid="pair-countdown">
          {expired ? (
            <span className="text-sm text-status-fail">Code expired — generate a new one.</span>
          ) : (
            <span className="text-sm text-text-subtle">
              Expires in <span className="font-mono text-text">{fmt(remaining)}</span>
            </span>
          )}
        </div>
        <Button onClick={onRegenerate} disabled={loading} variant="secondary">
          <RefreshCw size={14} className="mr-2" />
          {loading ? 'Generating…' : 'New code'}
        </Button>
      </div>
    </div>
  );
}
