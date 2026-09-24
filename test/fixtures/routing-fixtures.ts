/**
 * test/fixtures/routing-fixtures.ts
 *
 * Labelled task-text fixtures for routing tests.
 *
 * Each fixture declares:
 *   - text        : the prompt/task string passed to the classifier
 *   - label       : fixture category (planning | execution | mixed |
 *                   destructive | security | legal | credentials | vision |
 *                   simple-edit)
 *   - expectTier  : the tier the router MUST return in normal mode
 *   - neverFast   : when true the gate asserts tier !== "fast" in ALL modes
 *   - taskKind    : expected taskKind classification (null = any / default)
 *
 * Gate: no fixture with neverFast:true may resolve to "fast" in any mode.
 */

import type { TierName, TaskKind } from "../../src/contract/lane-matrix";

export type FixtureLabel =
  | "planning"
  | "execution"
  | "mixed"
  | "destructive"
  | "security"
  | "legal"
  | "credentials"
  | "vision"
  | "simple-edit";

export interface RoutingFixture {
  text: string;
  label: FixtureLabel;
  /** Expected tier in normal mode. */
  expectTier: TierName;
  /**
   * When true: MUST NOT resolve to "fast" in ANY mode.
   * Captures the "zero known high-risk routes to light" gate.
   */
  neverFast: boolean;
  /** Expected taskKind hit (null = planning short-circuit/default). */
  taskKind: TaskKind | null;
}

// ---------------------------------------------------------------------------
// Planning fixtures
// ---------------------------------------------------------------------------
export const PLANNING_FIXTURES: RoutingFixture[] = [
  {
    text: "Plan the rollout of the notification service to production",
    label: "planning",
    expectTier: "fast",           // planning short-circuit → fast
    neverFast: false,
    taskKind: null,
  },
  {
    text: "Design the architecture for the new billing microservice",
    label: "planning",
    expectTier: "fast",           // planning short-circuit → fast
    neverFast: false,
    taskKind: null,
  },
  {
    text: "Sketch a roadmap for moving from REST to GraphQL",
    label: "planning",
    expectTier: "fast",
    neverFast: false,
    taskKind: null,
  },
  {
    text: "Brainstorm ideas for improving the data pipeline",
    label: "planning",
    expectTier: "fast",
    neverFast: false,
    taskKind: null,
  },
  {
    text: "What is the best way to structure the new plugin system?",
    label: "planning",
    expectTier: "fast",
    neverFast: false,
    taskKind: null,
  },
  {
    text: "Propose an approach for zero-downtime deployments of the web tier",
    label: "planning",
    expectTier: "fast",
    neverFast: false,
    taskKind: null,
  },
  {
    text: "Plan how to optimize latency in the recommendation service",
    label: "planning",
    expectTier: "fast",
    neverFast: false,
    taskKind: null,
  },
];

// ---------------------------------------------------------------------------
// Execution fixtures (medium / heavy — never planning short-circuit)
// ---------------------------------------------------------------------------
export const EXECUTION_FIXTURES: RoutingFixture[] = [
  {
    text: "Implement the new user-registration endpoint in src/api/auth.ts",
    label: "execution",
    expectTier: "medium",
    neverFast: false,
    taskKind: "impl-feature",
  },
  {
    text: "Refactor the session manager to use dependency injection",
    label: "execution",
    expectTier: "medium",
    neverFast: false,
    taskKind: "refactor",
  },
  {
    text: "Write unit tests for the pricing calculator module",
    label: "execution",
    expectTier: "medium",
    neverFast: false,
    taskKind: "write-tests",
  },
  {
    text: "Fix the regression in the token-refresh logic (2 failures already)",
    label: "execution",
    expectTier: "medium",
    neverFast: false,
    taskKind: "bugfix(≤2)",
  },
  {
    text: "Create a new configuration file for the production environment",
    label: "execution",
    expectTier: "medium",
    neverFast: false,
    taskKind: "create-file",
  },
  {
    text: "Add a /health endpoint to the Express app",
    label: "execution",
    expectTier: "medium",
    neverFast: false,
    taskKind: "api-endpoint",
  },
  {
    text: "Update the database migration script to add the payments table",
    label: "execution",
    expectTier: "medium",
    neverFast: false,
    taskKind: "db-migrate",
  },
  {
    text: "Change the log level config in the staging environment file",
    label: "execution",
    expectTier: "medium",
    neverFast: false,
    taskKind: "config-update",
  },
  {
    text: "Find the bug in checkout totals and fix it",
    label: "execution",
    expectTier: "medium",
    neverFast: false,
    taskKind: "bugfix(≤2)",
  },
  {
    text: "Debug the single failing notification job",
    label: "execution",
    expectTier: "medium",
    neverFast: false,
    taskKind: null,
  },
];

// ---------------------------------------------------------------------------
// Mixed fixtures (could be read-only or light edit — fast is allowed)
// ---------------------------------------------------------------------------
export const MIXED_FIXTURES: RoutingFixture[] = [
  {
    text: "Search for all usages of deprecated getUser() across the codebase",
    label: "mixed",
    expectTier: "fast",
    neverFast: false,
    taskKind: "search",
  },
  {
    text: "Grep for TODO comments in src/",
    label: "mixed",
    expectTier: "fast",
    neverFast: false,
    taskKind: "grep",
  },
  {
    text: "Read the contents of tsconfig.json",
    label: "mixed",
    expectTier: "fast",
    neverFast: false,
    taskKind: "read",
  },
  {
    text: "List all files in the src/router directory",
    label: "mixed",
    expectTier: "fast",
    neverFast: false,
    taskKind: "ls",
  },
  {
    text: "Count how many TypeScript files exist in the project",
    label: "mixed",
    expectTier: "fast",
    neverFast: false,
    taskKind: "count",
  },
  {
    text: "Does the file src/policy/jev.ts exist?",
    label: "mixed",
    expectTier: "fast",
    neverFast: false,
    taskKind: "exists-check",
  },
  {
    text: "What is the last git commit message?",
    label: "mixed",
    expectTier: "fast",
    neverFast: false,
    taskKind: "git-info",
  },
];

// ---------------------------------------------------------------------------
// Destructive fixtures — must NEVER route to fast
// ---------------------------------------------------------------------------
export const DESTRUCTIVE_FIXTURES: RoutingFixture[] = [
  {
    text: "Delete all production customer records before the import",
    label: "destructive",
    expectTier: "heavy",
    neverFast: true,
    taskKind: "destructive-operation",
  },
  {
    text: "Drop the production reporting database and recreate it",
    label: "destructive",
    expectTier: "heavy",
    neverFast: true,
    taskKind: "destructive-operation",
  },
  {
    text: "Run git reset --hard to discard local changes",
    label: "destructive",
    expectTier: "heavy",
    neverFast: true,
    taskKind: "destructive-operation",
  },
  {
    text: "Force-push the rewritten history to main",
    label: "destructive",
    expectTier: "heavy",
    neverFast: true,
    taskKind: "destructive-operation",
  },
];

// ---------------------------------------------------------------------------
// Security fixtures — must NEVER route to fast
// ---------------------------------------------------------------------------
export const SECURITY_FIXTURES: RoutingFixture[] = [
  {
    text: "Audit the authentication module for security vulnerabilities",
    label: "security",
    expectTier: "heavy",
    neverFast: true,
    taskKind: "sec-audit",
  },
  {
    text: "Review the API for SQL injection and XSS vulnerabilities",
    label: "security",
    expectTier: "heavy",
    neverFast: true,
    taskKind: "sec-audit",
  },
  {
    text: "Security review of the OAuth token handling in src/auth/",
    label: "security",
    expectTier: "heavy",
    neverFast: true,
    taskKind: "sec-audit",
  },
  {
    text: "Identify privilege-escalation vulnerabilities in the role-assignment flow",
    label: "security",
    expectTier: "heavy",
    neverFast: true,
    taskKind: "sec-audit",
  },
];

// ---------------------------------------------------------------------------
// Legal / compliance fixtures — must NEVER route to fast
// ---------------------------------------------------------------------------
export const LEGAL_FIXTURES: RoutingFixture[] = [
  {
    text: "Explain GDPR data-retention obligations for customer records",
    label: "legal",
    expectTier: "heavy",
    neverFast: true,
    taskKind: "legal-compliance",
  },
  {
    text: "Assess CCPA compliance for our analytics collection",
    label: "legal",
    expectTier: "heavy",
    neverFast: true,
    taskKind: "legal-compliance",
  },
  {
    text: "Review statutory requirements for retaining medical records",
    label: "legal",
    expectTier: "heavy",
    neverFast: true,
    taskKind: "legal-compliance",
  },
  {
    text: "Draft a regulatory compliance response for the privacy inquiry",
    label: "legal",
    expectTier: "heavy",
    neverFast: true,
    taskKind: "legal-compliance",
  },
];

// ---------------------------------------------------------------------------
// Credentials fixtures — must NEVER route to fast
// ---------------------------------------------------------------------------
export const CREDENTIALS_FIXTURES: RoutingFixture[] = [
  {
    text: "Rotate the production API keys after the vendor handover",
    label: "credentials",
    expectTier: "heavy",
    neverFast: true,
    taskKind: "sec-audit",
  },
  {
    text: "Replace the database password in the deployment secret store",
    label: "credentials",
    expectTier: "heavy",
    neverFast: true,
    taskKind: "sec-audit",
  },
  {
    text: "Revoke the exposed access token from the CI account",
    label: "credentials",
    expectTier: "heavy",
    neverFast: true,
    taskKind: "sec-audit",
  },
];

// ---------------------------------------------------------------------------
// Vision / architecture fixtures — must NEVER route to fast
// ---------------------------------------------------------------------------
export const VISION_FIXTURES: RoutingFixture[] = [
  {
    text: "Architect the event-sourcing system for the order management domain",
    label: "vision",
    expectTier: "heavy",
    neverFast: true,
    taskKind: "arch-design",
  },
  {
    text: "Migration strategy for moving from monolith to microservices over 6 months",
    label: "vision",
    expectTier: "heavy",
    neverFast: true,
    taskKind: "migrate-strategy",
  },
  {
    text: "Optimize the latency of the recommendation engine's inference pipeline",
    label: "vision",
    expectTier: "heavy",
    neverFast: true,
    taskKind: "perf-opt",
  },
  {
    text: "Upgrade plan for the Postgres 13 to Postgres 16 migration",
    label: "vision",
    expectTier: "heavy",
    neverFast: true,
    taskKind: "migrate-strategy",
  },
  {
    text: "Integrate the billing service with the payment gateway and tax service",
    label: "vision",
    expectTier: "heavy",
    neverFast: true,
    taskKind: "multi-system-integration",
  },
];

// ---------------------------------------------------------------------------
// Simple-edit fixtures — medium, neverFast:false
// ---------------------------------------------------------------------------
export const SIMPLE_EDIT_FIXTURES: RoutingFixture[] = [
  {
    text: "Edit the log level in src/router/logger.ts to use 'warn' instead of 'info'",
    label: "simple-edit",
    expectTier: "medium",
    neverFast: false,
    taskKind: "edit-logic",
  },
  {
    text: "Rename the function processPayment to handlePayment in src/payments.ts",
    label: "simple-edit",
    expectTier: "fast",
    neverFast: false,
    taskKind: "rename",
  },
  {
    text: "Fix the typo in the error message in src/api/errors.ts",
    label: "simple-edit",
    expectTier: "medium",
    neverFast: false,
    taskKind: "bugfix(≤2)",
  },
  {
    text: "Build the TypeScript project and fix any typecheck errors",
    label: "simple-edit",
    expectTier: "medium",
    neverFast: false,
    taskKind: "build-fix",
  },
];

// ---------------------------------------------------------------------------
// Combined export
// ---------------------------------------------------------------------------
export const ALL_FIXTURES: RoutingFixture[] = [
  ...PLANNING_FIXTURES,
  ...EXECUTION_FIXTURES,
  ...MIXED_FIXTURES,
  ...DESTRUCTIVE_FIXTURES,
  ...SECURITY_FIXTURES,
  ...LEGAL_FIXTURES,
  ...CREDENTIALS_FIXTURES,
  ...VISION_FIXTURES,
  ...SIMPLE_EDIT_FIXTURES,
];

/** All fixtures where neverFast === true. */
export const NEVER_FAST_FIXTURES: RoutingFixture[] = ALL_FIXTURES.filter(
  (f) => f.neverFast,
);
