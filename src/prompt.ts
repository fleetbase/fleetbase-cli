import enquirer from 'enquirer';
import { CliError } from './util.js';

/**
 * Prompts that refuse to hang: without a TTY they fail with the flag to pass instead.
 */

export function interactive(): boolean {
    return Boolean(process.stdin.isTTY && process.stderr.isTTY) && process.env.CI !== 'true';
}

function requireTty(flag: string): void {
    if (!interactive()) {
        throw new CliError(`Missing ${flag} (no terminal to prompt on).`);
    }
}

export async function ask(message: string, flag: string, initial?: string, validate?: (value: string) => true | string): Promise<string> {
    requireTty(flag);
    const { value } = await enquirer.prompt<{ value: string }>({
        type: 'input',
        name: 'value',
        message,
        initial,
        stdout: process.stderr,
        validate: (input: string) => (validate ? validate(input.trim()) : input.trim() !== '' || 'Required'),
    } as Parameters<typeof enquirer.prompt>[0]);
    return value.trim();
}

export async function askSecret(message: string, flag: string): Promise<string> {
    requireTty(flag);
    const { value } = await enquirer.prompt<{ value: string }>({
        type: 'password',
        name: 'value',
        message,
        stdout: process.stderr,
        validate: (input: string) => input !== '' || 'Required',
    } as Parameters<typeof enquirer.prompt>[0]);
    return value;
}

export async function confirm(message: string, flag = '--yes', initial = false): Promise<boolean> {
    requireTty(flag);
    const { value } = await enquirer.prompt<{ value: boolean }>({
        type: 'confirm',
        name: 'value',
        message,
        initial,
        stdout: process.stderr,
    } as Parameters<typeof enquirer.prompt>[0]);
    return value;
}
