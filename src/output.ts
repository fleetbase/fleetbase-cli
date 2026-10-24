import pc from 'picocolors';

/**
 * Terminal output. Everything a command prints goes through here so tokens can be
 * redacted in one place: personal (flbp_), instance (flbi_) and session (flbs_) tokens
 * are masked in every message unless a command prints one on purpose with `secret()`.
 */

const TOKEN_PATTERN = /\b(flb[pis]_)[A-Za-z0-9]{8,}/g;

export function redact(text: string): string {
    return text.replace(TOKEN_PATTERN, (match, prefix: string) => `${prefix}…${match.slice(-4)}`);
}

export interface Writer {
    out(text: string): void;
    err(text: string): void;
}

const processWriter: Writer = {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
};

let writer: Writer = processWriter;

/** Tests capture output by swapping the writer. */
export function setWriter(next: Writer | null): void {
    writer = next || processWriter;
}

export const colors = pc;

export const log = {
    /** Plain line on stdout. */
    line(text = ''): void {
        writer.out(redact(text) + '\n');
    },
    info(text: string): void {
        writer.err(redact(text) + '\n');
    },
    step(text: string): void {
        writer.err(`${pc.cyan('›')} ${redact(text)}\n`);
    },
    success(text: string): void {
        writer.err(`${pc.green('✓')} ${redact(text)}\n`);
    },
    warn(text: string): void {
        writer.err(`${pc.yellow('!')} ${redact(text)}\n`);
    },
    error(text: string): void {
        writer.err(`${pc.red('✗')} ${redact(text)}\n`);
    },
    /** The one way to print a token: callers decide (--show-token). */
    secret(text: string): void {
        writer.out(text + '\n');
    },
    json(value: unknown): void {
        writer.out(redact(JSON.stringify(value, null, 2)) + '\n');
    },
};

export interface Column<T> {
    header: string;
    value: (row: T) => string | number | null | undefined;
    max?: number;
}

export function table<T>(rows: T[], columns: Column<T>[]): string {
    const cells = rows.map((row) => columns.map((column) => truncate(String(column.value(row) ?? ''), column.max)));
    const widths = columns.map((column, i) => Math.max(column.header.length, ...cells.map((row) => visibleLength(row[i]))));
    const render = (row: string[]) =>
        row
            .map((cell, i) => (i === row.length - 1 ? cell : cell + ' '.repeat(widths[i] - visibleLength(cell))))
            .join('  ')
            .trimEnd();

    return [pc.bold(render(columns.map((column) => column.header))), ...cells.map(render)].join('\n');
}

function truncate(text: string, max?: number): string {
    return max && text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function visibleLength(text: string): number {
    // eslint-disable-next-line no-control-regex
    return text.replace(/\u001b\[[0-9;]*m/g, '').length;
}

export function formatBytes(bytes: number | null | undefined): string {
    if (bytes === null || bytes === undefined) {
        return '';
    }
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export function formatDate(value: string | null | undefined): string {
    if (!value) {
        return '';
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toISOString().slice(0, 10);
}
