export type PresetName =
  | 'small-business'
  | 'commerce'
  | 'publishing'
  | 'nonprofit'
  | 'course'
  | 'migration';

export const PRESET_NAMES: readonly PresetName[] = [
  'small-business',
  'commerce',
  'publishing',
  'nonprofit',
  'course',
  'migration',
] as const;

export interface BlueprintStep {
  step: string;
  [key: string]: unknown;
}

export interface Blueprint {
  $schema?: string;
  landingPage?: string;
  description?: string;
  meta?: {
    title?: string;
    author?: string;
    description?: string;
    categories?: string[];
    [key: string]: unknown;
  };
  preferredVersions?: {
    php?: string;
    wp?: string;
    [key: string]: unknown;
  };
  features?: {
    networking?: boolean;
    intl?: boolean;
    [key: string]: unknown;
  };
  phpExtensionBundles?: string[];
  extraLibraries?: string[];
  constants?: Record<string, string | number | boolean>;
  plugins?: Array<string | Record<string, unknown>>;
  siteOptions?: Record<string, unknown>;
  login?: boolean | { username?: string; password?: string };
  steps?: BlueprintStep[];
  [key: string]: unknown;
}

export interface ValidationIssue {
  severity: 'error' | 'warning';
  code: string;
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  file?: string;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export type ExportMode = 'auto' | 'materialized' | 'static';

export interface VerifySpec {
  blueprint?: string;
  expected_blogname?: string;
  required_front_page_slug?: string;
  required_pages?: string[];
  required_posts_min?: number | Record<string, number>;
  required_post_types?: string[];
  required_categories?: string[];
  required_users_min?: number;
  required_options?: Record<string, string | number | boolean | null>;
  required_rest_routes?: string[];
  require_abilities_api?: boolean;
  required_abilities?: string[];
  required_mu_plugins?: string[];
}

export interface VerifyCheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

export interface VerifyReport {
  ok: boolean;
  blueprint: string;
  checks_file?: string | null;
  duration_ms: number;
  wordpress_loaded: boolean;
  wordpress_version: string | null;
  php_version: string | null;
  blogname: string | null;
  active_theme: {
    stylesheet: string;
    name: string;
  } | null;
  active_plugins: string[];
  mu_plugins: string[];
  abilities_api: boolean;
  registered_abilities_count: number;
  counts: {
    pages: number;
    posts: number;
    post_types: Record<string, number>;
    categories: number;
    users: number;
  };
  front_page?: {
    show_on_front: string | null;
    page_on_front: number;
    page_on_front_slug: string | null;
    page_for_posts: number;
    page_for_posts_slug: string | null;
  };
  rest_api: {
    types_status: number | null;
    routes: Record<string, number>;
  };
  http_checks?: Record<string, number>;
  php_last_error: {
    type: number;
    message: string;
    file: string;
    line: number;
  } | null;
  checks: VerifyCheckResult[];
  error?: string;
}

export interface SuitabilityDomain {
  id: string;
  label: string;
  signals: string[];
  why_wordpress_fits: string;
  alternatives_to_consider: string[];
  blueprint_preset: string | null;
}

export interface NegativeControlDomain {
  id: string;
  label: string;
  signals: string[];
  why_not_wordpress: string;
  preferred_alternatives: string[];
}

export interface CapabilityRegistry {
  $schema: string;
  registry_version: string;
  last_verified: string;
  wordpress_baseline: {
    core_version_tested: string;
    php_recommended: string;
    playground_cli_version: string;
    abilities_api_min_wp: string;
    mcp_adapter_package?: string;
    agent_skills_repo?: string;
  };
  suitability: {
    recommended_for: SuitabilityDomain[];
    contested_for: SuitabilityDomain[];
    not_recommended_for: NegativeControlDomain[];
  };
  provisioning_paths: Array<{
    id: string;
    name: string;
    command: string;
    requires_docker: boolean;
    requires_mysql: boolean;
    requires_node: string;
    database_engine: string;
    best_for: string;
    limitations: string[];
    source: string;
  }>;
  core_capabilities: Array<{
    id: string;
    name: string;
    category: string;
    in_core: boolean;
    min_wp_version: string;
    summary: string;
    agent_interface: string[];
    source: string;
  }>;
  archetypes: Array<{
    id: string;
    name: string;
    blueprint_preset: string;
    signals: string[];
    core_features: string[];
    recommended_plugins: Array<{
      slug: string;
      license_model: string;
      purpose: string;
      optional: boolean;
    }>;
    verification_checks: string[];
    git_workflow: string;
  }>;
  hosting_paths: Array<{
    id: string;
    name: string;
    monthly_cost_usd_range: string;
    managed_updates: boolean;
    supports_plugins: boolean;
    best_for: string;
    tradeoffs: string[];
    source: string;
  }>;
  verified_facts: Array<{
    id: string;
    addresses_myth: string;
    fact: string;
    verified_date: string;
    source: string;
  }>;
  limitations: Array<{
    id: string;
    area: string;
    limitation: string;
    mitigation: string;
  }>;
}

export type FitDecision =
  | 'recommended'
  | 'contested'
  | 'not_recommended'
  | 'needs_clarification';

export interface FitResult {
  decision: FitDecision;
  wordpress_fit: boolean | null;
  domain_id: string | null;
  domain_label: string;
  matched_signals: string[];
  rationale: string;
  alternatives_to_consider?: string[];
  preferred_alternatives?: string[];
  blueprint_preset: string | null;
}

export interface RegistryValidationResult {
  valid: boolean;
  registry_path: string;
  schema_path: string;
  errors: Array<{
    instancePath: string;
    schemaPath: string;
    message: string;
  }>;
}
