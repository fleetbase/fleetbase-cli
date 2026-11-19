import { describe, expect, it } from 'vitest';
import { redact } from '../../src/output.js';
import { parseDays, parseTimeout, slugify, splitList, splitVersion, studly } from '../../src/util.js';
import { INSTANCE_TOKEN, TOKEN } from './helpers.js';

describe('util', () => {
    it('parses token lifetimes in days, capped at 365', () => {
        expect(parseDays('90')).toBe(90);
        expect(parseDays('180d')).toBe(180);
        expect(parseDays('12w')).toBe(84);
        expect(parseDays('6mo')).toBe(180);
        expect(parseDays('1y')).toBe(365);
        expect(() => parseDays('2y')).toThrow(/between 1 and 365/);
        expect(() => parseDays('soon')).toThrow(/Invalid duration/);
    });

    it('parses timeouts', () => {
        expect(parseTimeout('90s')).toBe(90_000);
        expect(parseTimeout('15m')).toBe(900_000);
        expect(parseTimeout('2h')).toBe(7_200_000);
        expect(parseTimeout('30')).toBe(30_000);
    });

    it('splits name@version, keeping npm scopes', () => {
        expect(splitVersion('pallet@0.0.2')).toEqual(['pallet', '0.0.2']);
        expect(splitVersion('@acme/engine@1.2.0')).toEqual(['@acme/engine', '1.2.0']);
        expect(splitVersion('@acme/engine')).toEqual(['@acme/engine', undefined]);
        expect(splitVersion('acme/api')).toEqual(['acme/api', undefined]);
    });

    it('slugs and studly-cases names', () => {
        expect(slugify('Fleet Insights')).toBe('fleet-insights');
        expect(slugify('FleetInsights')).toBe('fleet-insights');
        expect(slugify('E2E Insights')).toBe('e2e-insights');
        expect(slugify('Café Ops!')).toBe('cafe-ops');
        expect(studly('fleet insights')).toBe('FleetInsights');
    });

    it('splits lists', () => {
        expect(splitList('read, publish,,install')).toEqual(['read', 'publish', 'install']);
        expect(splitList(undefined)).toEqual([]);
    });

    it('redacts personal and instance tokens in output', () => {
        const text = `token ${TOKEN} and ${INSTANCE_TOKEN}`;
        expect(redact(text)).toBe('token flbp_…Z9x1 and flbi_…M3n4');
        expect(redact('flbp_…Z9x1')).toBe('flbp_…Z9x1');
    });
});
