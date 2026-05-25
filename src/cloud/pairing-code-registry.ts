import crypto from "node:crypto";

export type PairingCodeIssueInput = {
  authToken: string;
  userId: string;
  userName: string;
};

type PairingCodeRecord = {
  authToken: string;
  userId: string;
  userName: string;
  expiresAtMs: number;
};

export type PairingCodeResolveResult = {
  pairingCode: string;
  authToken: string;
  userId: string;
  userName: string;
  expiresAtMs: number;
};

export function createPairingCodeRegistry({ ttlMs }: { ttlMs: number }) {
  const byCode = new Map<string, PairingCodeRecord>();
  const codeByToken = new Map<string, string>();

  const nowMs = () => Date.now();

  const random4DigitCode = () => {
    const value = crypto.randomInt(0, 10000);
    return String(value).padStart(4, "0");
  };

  const cleanup = () => {
    const now = nowMs();
    for (const [code, record] of byCode.entries()) {
      if (record.expiresAtMs <= now) {
        byCode.delete(code);
        codeByToken.delete(record.authToken);
      }
    }
  };

  const issue = ({ authToken, userId, userName }: PairingCodeIssueInput) => {
    cleanup();

    const previousCode = codeByToken.get(authToken);
    if (previousCode) {
      byCode.delete(previousCode);
      codeByToken.delete(authToken);
    }

    let code = "";
    for (let i = 0; i < 100; i += 1) {
      const candidate = random4DigitCode();
      const existing = byCode.get(candidate);
      if (!existing || existing.expiresAtMs <= nowMs()) {
        code = candidate;
        break;
      }
    }

    if (!code) {
      throw new Error("failed to allocate pairing code");
    }

    const expiresAtMs = nowMs() + ttlMs;
    const record: PairingCodeRecord = { authToken, userId, userName, expiresAtMs };
    byCode.set(code, record);
    codeByToken.set(authToken, code);

    return {
      pairingCode: code,
      expiresAtMs,
    };
  };

  const resolve = (code: string): PairingCodeResolveResult | null => {
    cleanup();
    const normalized = String(code ?? "").trim();
    if (!/^\d{4}$/.test(normalized)) {
      return null;
    }

    const record = byCode.get(normalized);
    if (!record) {
      return null;
    }

    if (record.expiresAtMs <= nowMs()) {
      byCode.delete(normalized);
      codeByToken.delete(record.authToken);
      return null;
    }

    return {
      pairingCode: normalized,
      authToken: record.authToken,
      userId: record.userId,
      userName: record.userName,
      expiresAtMs: record.expiresAtMs,
    };
  };

  return {
    ttlMs,
    cleanup,
    issue,
    resolve,
  };
}
