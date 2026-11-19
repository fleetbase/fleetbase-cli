import crypto from 'node:crypto';
import fs from 'node:fs';

/** An expected failure: printed without a stack trace, exits with `exitCode`. */
export class CliError extends Error {
    constructor(
        message: string,
        readonly exitCode = 1,
        readonly hints: string[] = [],
    ) {
        super(message);
    }
}

/**
 * Token lifetime in days from `90`, `90d`, `12w`, `6mo` or `1y`. The service caps tokens at 365 days.
 */
export function parseDays(value: string | number): number {
    if (typeof value === 'number') {
        return checkDays(value, String(value));
    }
    const match = String(value).trim().toLowerCase().match(/^(\d+)\s*(d|days?|w|weeks?|mo|months?|y|years?)?$/);
    if (!match) {
        throw new CliError(`Invalid duration "${value}": use days (90 or 90d), weeks (12w), months (6mo) or years (1y).`);
    }
    const amount = Number(match[1]);
    const unit = match[2] || 'd';
    const factor = unit.startsWith('w') ? 7 : unit.startsWith('mo') ? 30 : unit.startsWith('y') ? 365 : 1;
    return checkDays(amount * factor, value);
}

function checkDays(days: number, raw: string): number {
    if (!Number.isInteger(days) || days < 1 || days > 365) {
        throw new CliError(`Invalid duration "${raw}": tokens last between 1 and 365 days.`);
    }
    return days;
}

/** Durations for timeouts: `90s`, `15m`, `2h`, or seconds. Returns milliseconds. */
export function parseTimeout(value: string): number {
    const match = String(value).trim().toLowerCase().match(/^(\d+)\s*(ms|s|m|h)?$/);
    if (!match) {
        throw new CliError(`Invalid timeout "${value}": use seconds (90s), minutes (15m) or hours (2h).`);
    }
    const amount = Number(match[1]);
    const unit = match[2] || 's';
    return amount * (unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000);
}

export function splitList(value: string | string[] | undefined): string[] {
    const items = Array.isArray(value) ? value : value ? [value] : [];
    return items
        .flatMap((item) => item.split(/[\s,]+/))
        .map((item) => item.trim())
        .filter(Boolean);
}

let stdinOverride: string | null = null;

/** Tests feed stdin through this instead of the process stream. */
export function setStdin(value: string | null): void {
    stdinOverride = value;
}

export async function readStdin(): Promise<string> {
    if (stdinOverride !== null) {
        return stdinOverride.replace(/\r?\n$/, '');
    }
    if (process.stdin.isTTY) {
        throw new CliError('Nothing on stdin: pipe the value in, for example `printf %s "$TOKEN" | flb login --token-stdin`.');
    }
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

export function sha256File(file: string): string {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function slugify(value: string): string {
    return value
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/([a-z])([A-Z])/g, '$1-$2')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

export function studly(value: string): string {
    return slugify(value)
        .split('-')
        .filter(Boolean)
        .map((part) => part[0].toUpperCase() + part.slice(1))
        .join('');
}

/** `name@1.2.0`, `@scope/name@1.2.0` → [name, version]; `@scope/name` keeps its scope. */
export function splitVersion(ref: string): [string, string | undefined] {
    const at = ref.lastIndexOf('@');
    if (at > 0) {
        return [ref.slice(0, at), ref.slice(at + 1) || undefined];
    }
    return [ref, undefined];
}
