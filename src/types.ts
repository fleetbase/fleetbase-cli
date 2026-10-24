/** Shapes returned by the Registry Service (only the fields the CLI reads). */

export interface Organization {
    id: string;
    slug: string;
    name: string;
    role?: string;
    is_personal?: boolean;
}

export interface Account {
    id: string;
    name: string;
    username?: string | null;
    email: string;
    status: string;
    email_verified_at?: string | null;
    organizations?: Organization[];
}

export interface TokenDetails {
    id: string;
    name: string;
    masked: string;
    prefix: string;
    last_four: string;
    scopes: string[];
    organization: { id: string; slug: string; name: string } | null;
    expires_at: string | null;
    last_used_at: string | null;
    revoked_at: string | null;
    created_at: string;
}

export interface IssuedToken {
    token: string;
    token_type: string;
    expires_at: string | null;
    token_details: TokenDetails;
    account?: Account;
}

export interface Package {
    kind: 'npm' | 'composer';
    name: string;
}

export interface PublisherExtension {
    id: string;
    slug: string;
    name: string;
    status: string;
    organization: { id: string; slug: string; name: string };
    packages: Package[];
    readiness?: { ready: boolean; missing: string[] };
    subtitle?: string | null;
    description?: string | null;
    promotional_text?: string | null;
    hosting?: string;
    category?: { slug: string; name: string } | null;
    tags?: string[];
    languages?: string[];
    website_url?: string | null;
    repo_url?: string | null;
    support_url?: string | null;
    privacy_url?: string | null;
    tos_url?: string | null;
    copyright?: string | null;
    fa_icon?: string | null;
    price?: { model: string; amount: number; currency: string } | null;
}

export interface ReleaseCheck {
    check: string;
    passed: boolean;
    skipped: boolean;
    summary: string | null;
    errors: string[];
    warnings: string[];
    updated_at?: string;
}

export interface ReviewEntry {
    action: string;
    from_status: string | null;
    to_status: string;
    actor: string;
    by: { id: string; name: string } | null;
    reason: string | null;
    items: { code: string; passed: boolean; note?: string }[];
    created_at: string;
}

export interface ReleaseFile {
    id: string;
    name: string;
    size: number;
    sha256: string;
}

export interface ReleaseDetail {
    id: string;
    extension: { id: string; slug: string; name: string; status: string; organization?: { slug: string } };
    version: string;
    channel: string;
    status: string;
    compat: { console?: string | null; api?: string | null } | null;
    notes: string | null;
    size_bytes: number | null;
    files?: { engine: ReleaseFile | null; api: ReleaseFile | null; dist: ReleaseFile | null };
    checks_passed?: boolean | null;
    checks?: ReleaseCheck[];
    submission?: { requested: boolean; submitted_at: string | null; errors: string[] };
    review?: { required: boolean | null; reasons: Record<string, unknown> | unknown[] };
    reviews?: ReviewEntry[];
    published_at: string | null;
    yanked_at: string | null;
    created_at: string;
    updated_at?: string;
}

export interface CatalogListing {
    id: string;
    slug: string;
    name: string;
    subtitle: string | null;
    description?: string | null;
    tags: string[];
    hosting: string;
    status: string;
    publisher: { id: string; slug: string; name: string; is_verified?: boolean } | null;
    category: { slug: string; name: string } | null;
    latest_version: string | null;
    compat: { console?: string | null; api?: string | null } | null;
    packages: { npm?: string | null; composer?: string | null };
    price: { model: string; amount: number; currency: string; effective_amount: number } | null;
    is_paid: boolean;
    installs_count: number;
    published_at: string | null;
    website_url?: string | null;
    repo_url?: string | null;
    support_url?: string | null;
}

export interface CatalogRelease {
    id: string;
    version: string;
    channel: string;
    status: string;
    compat: { console?: string | null; api?: string | null } | null;
    size_bytes: number | null;
    notes: string | null;
    published_at: string | null;
    yanked_at: string | null;
}

export interface Instance {
    id: string;
    name: string;
    host: string | null;
    kind: string;
    console_version: string | null;
    api_version: string | null;
    status: string;
    organization: { id: string; slug: string; name: string };
    last_seen_at: string | null;
}
