import fs from 'node:fs';
import path from 'node:path';
import type { PublisherExtension } from './types.js';

/**
 * extension.json's `listing` block: the catalog listing, managed from the repository. `flb publish`
 * applies it (`PUT /v1/publisher/extensions/{slug}/listing-manifest`) and the registry then shows the
 * fields it sets read-only in Studio. Fields left out stay Studio's. Price, visibility and media are
 * never in it. Schema: the registry's `resources/schemas/extension.schema.json` (`listing`).
 */
export interface ListingBlock {
    subtitle?: string;
    description?: string;
    promotional_text?: string;
    category?: string;
    tags?: string[];
    languages?: string[];
    icon?: string;
    hosting?: 'cloud' | 'self_hosted' | 'both';
    copyright?: string;
    links?: { website?: string; repo?: string; support?: string; privacy?: string; terms?: string };
}

export const LISTING_KEYS = ['subtitle', 'description', 'promotional_text', 'category', 'tags', 'languages', 'icon', 'hosting', 'copyright', 'links'] as const;
export const LINK_KEYS = ['website', 'repo', 'support', 'privacy', 'terms'] as const;
const HOSTINGS = ['cloud', 'self_hosted', 'both'];
const TEXT_LIMITS: Record<string, number> = { subtitle: 255, description: 20000, promotional_text: 20000, category: 191, copyright: 255, icon: 64 };
/** Block field → listing API field. */
const LINK_FIELDS: Record<(typeof LINK_KEYS)[number], string> = { website: 'website_url', repo: 'repo_url', support: 'support_url', privacy: 'privacy_url', terms: 'tos_url' };
/** Text fields that may name a file instead of holding the text. */
const FILE_FIELDS = ['description', 'promotional_text'] as const;
const FILE_EXTENSIONS = /\.(md|markdown|txt)$/i;
const HTTP_URL = /^https?:\/\/[^\s]+$/i;

/** A value that names a file in the extension (`README.md`, `docs/overview.md`) rather than holding text. */
export function isFileReference(value: unknown): value is string {
    return typeof value === 'string' && !value.includes('\n') && FILE_EXTENSIONS.test(value.trim()) && !/^[a-z]+:\/\//i.test(value.trim());
}

/** Problems with the block's shape and values, as validateManifest reports them. Files are checked by resolveListing. */
export function validateListing(listing: unknown): string[] {
    if (listing === undefined) {
        return [];
    }
    if (!listing || typeof listing !== 'object' || Array.isArray(listing)) {
        return ['`listing` must be an object.'];
    }
    const block = listing as Record<string, unknown>;
    const problems: string[] = [];
    for (const key of Object.keys(block)) {
        if (!(LISTING_KEYS as readonly string[]).includes(key)) {
            problems.push(`\`listing.${key}\` is not a listing field (${LISTING_KEYS.join(', ')}). Price and visibility are set in Studio.`);
        }
    }
    for (const [key, max] of Object.entries(TEXT_LIMITS)) {
        const value = block[key];
        if (value !== undefined && (typeof value !== 'string' || (!isFileReference(value) && [...value].length > max) || (key === 'category' && value === ''))) {
            problems.push(`\`listing.${key}\` must be ${key === 'category' ? 'a category slug' : 'a string'} of at most ${max} characters.`);
        }
    }
    if (typeof block.icon === 'string' && !/^[a-z0-9-]+$/.test(block.icon)) {
        problems.push('`listing.icon` must be a Font Awesome icon name (lowercase letters, digits and dashes, for example satellite-dish).');
    }
    if (block.hosting !== undefined && !HOSTINGS.includes(block.hosting as string)) {
        problems.push('`listing.hosting` must be cloud, self_hosted or both.');
    }
    for (const [key, max, length] of [
        ['tags', 20, 64],
        ['languages', 50, 16],
    ] as const) {
        const value = block[key];
        if (value !== undefined && (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== 'string' || item === '' || item.length > length) || new Set(value).size !== value.length)) {
            problems.push(`\`listing.${key}\` must be at most ${max} different strings of 1 to ${length} characters.`);
        }
    }
    if (block.links !== undefined) {
        if (!block.links || typeof block.links !== 'object' || Array.isArray(block.links)) {
            problems.push('`listing.links` must be an object of website, repo, support, privacy and terms URLs.');
        } else {
            for (const [key, value] of Object.entries(block.links as Record<string, unknown>)) {
                if (!(LINK_KEYS as readonly string[]).includes(key)) {
                    problems.push(`\`listing.links.${key}\` is not a link (${LINK_KEYS.join(', ')}).`);
                } else if (typeof value !== 'string' || !HTTP_URL.test(value) || value.length > 255) {
                    problems.push(`\`listing.links.${key}\` must be an http(s) URL of at most 255 characters.`);
                }
            }
        }
    }
    return problems;
}

/**
 * The body for `PUT …/listing-manifest`: the block in listing API names, file references read from the
 * extension, and the top-level `keywords` / `repository` filling `tags` / `links.repo` when the block
 * leaves them out. Null without a block: the manifest then manages nothing.
 */
export function listingPayload(manifest: Record<string, any>, root: string): { body: Record<string, unknown> | null; problems: string[] } {
    const block = manifest.listing as Record<string, any> | undefined;
    if (block === undefined) {
        return { body: null, problems: [] };
    }
    const problems: string[] = [];
    const body: Record<string, unknown> = {};
    for (const key of ['subtitle', 'category', 'hosting', 'copyright'] as const) {
        if (block[key] !== undefined) {
            body[key] = block[key];
        }
    }
    for (const key of FILE_FIELDS) {
        const value = block[key];
        if (value === undefined) {
            continue;
        }
        if (!isFileReference(value)) {
            body[key] = value;
            continue;
        }
        const file = path.resolve(root, value);
        if (path.relative(root, file).startsWith('..') || path.isAbsolute(path.relative(root, file))) {
            problems.push(`\`listing.${key}\` names ${value}, which is outside the extension.`);
            continue;
        }
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
            problems.push(`\`listing.${key}\` names ${value}, which does not exist.`);
            continue;
        }
        const text = fs.readFileSync(file, 'utf8').trim();
        if ([...text].length > TEXT_LIMITS[key]) {
            problems.push(`${value} (\`listing.${key}\`) has ${[...text].length} characters; the listing takes at most ${TEXT_LIMITS[key]}.`);
            continue;
        }
        body[key] = text;
    }
    const tags = block.tags ?? (Array.isArray(manifest.keywords) ? manifest.keywords : undefined);
    if (tags !== undefined) {
        body.tags = tags;
    }
    if (block.languages !== undefined) {
        body.languages = block.languages;
    }
    if (block.icon !== undefined) {
        body.fa_icon = block.icon;
    }
    const links: Record<string, string> = { ...(block.links ?? {}) };
    if (links.repo === undefined && typeof manifest.repository === 'string' && HTTP_URL.test(manifest.repository)) {
        links.repo = manifest.repository;
    }
    for (const key of LINK_KEYS) {
        if (links[key] !== undefined) {
            body[LINK_FIELDS[key]] = links[key];
        }
    }
    return { body, problems };
}

/** Readable names of the listing API fields, for messages. */
export function fieldLabel(field: string): string {
    return ({ fa_icon: 'icon', website_url: 'website', repo_url: 'repo', support_url: 'support', privacy_url: 'privacy', tos_url: 'terms' } as Record<string, string>)[field] ?? field;
}

/**
 * The block for a listing, for `flb listing pull`. Empty values are left out. A text field the current block
 * already points at a file keeps that file reference (the file itself is not rewritten).
 */
export function blockFromListing(listing: PublisherExtension, current: Record<string, any> = {}): ListingBlock {
    const block: Record<string, unknown> = {};
    const set = (key: string, value: unknown) => {
        if (value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0)) {
            block[key] = value;
        }
    };
    set('subtitle', listing.subtitle);
    for (const key of FILE_FIELDS) {
        set(key, isFileReference(current[key]) ? current[key] : listing[key]);
    }
    set('category', listing.category?.slug);
    set('tags', listing.tags);
    set('languages', listing.languages);
    set('icon', listing.fa_icon);
    set('hosting', listing.hosting);
    set('copyright', listing.copyright);
    const links: Record<string, string> = {};
    for (const key of LINK_KEYS) {
        const value = listing[LINK_FIELDS[key] as keyof PublisherExtension];
        if (typeof value === 'string' && value !== '') {
            links[key] = value;
        }
    }
    if (Object.keys(links).length) {
        block.links = links;
    }
    return block as ListingBlock;
}
