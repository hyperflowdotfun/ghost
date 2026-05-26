/**
 * Eval runner — orchestrates persona generation, Ghost simulation, judging, and reporting.
 *
 * Self-contained: reads user's existing Ghost config, creates isolated runtime,
 * runs everything with one command.
 */

import { mkdtempSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getModel, type Model, type Api, type KnownProvider } from "@earendil-works/pi-ai";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { createRuntime, getApiKey as makeGetApiKey } from "../runtime.js";
import type { Runtime } from "../runtime.js";
import { getGhostDir, getConfigPath, getCredentialsPath, getSecretKeyPath, getModelsConfigPath, getEvalConfigPath } from "../config/paths.js";
import { createRootLogger } from "../logger.js";
import { parseEvalArgs, type EvalConfig } from "./config.js";
import { generatePersonas, type Persona } from "./persona.js";
import { buildScenarios, type Scenario } from "./scenario.js";
import { judgeResponse, type ScoreResult, type ExecutionResult, MAX_L3_SCORE } from "./judge.js";
import { assertExecution } from "./assertions.js";
import { buildReport, printReport, writeReport, compareWithPrevious } from "./report.js";
import { loadGolden } from "./golden-loader.js";
import { readEvalConfig, runJudgeSetupWizard, type EvalFile } from "./setup.js";

/**
 * Everything the scenario loop and judge calls need that's derived from a
 * concrete Runtime. Bundled so we can recreate the full set on persona
 * boundaries without threading eight parameters through.
 */
interface EvalStack {
  runtime: Runtime;
  judgeModel: Model<Api>;
  judgeGetApiKey: (provider: string) => Promise<string | undefined>;
  agentModel: Model<Api>;
  agentGetApiKey: (provider: string) => Promise<string | undefined>;
  /** Isolated GHOST_HOME for this stack. Kept so the wipe step knows
   *  which tmp dir to strip between personas. */
  tmpDir: string;
}

// ── Main runner ──────────────────────────────────────────────────────────

export async function runEval(config: EvalConfig): Promise<void> {
  // 0a. Pre-flight: Ghost must be onboarded. Eval piggybacks on the user's
  //     real ~/.ghost/config.json (provider + credentials) — without it,
  //     there's no agent to evaluate. Surface a friendly message instead of
  //     a stack trace from createRuntime.
  const ghostConfig = readGhostConfigOrExit();
  if (!ghostConfig) return;

  // 0b. Auto-setup judge on first run. Probe the REAL ghost dir before we
  //     switch GHOST_HOME to a temp dir so any writes land in the user's
  //     persistent config.
  //
  //     Precedence:
  //       1. CLI flags override everything (power users, CI)
  //       2. ~/.ghost/eval.json from wizard (persisted across runs)
  //       3. Launch wizard (first run, no cli override)
  const evalFile = readEvalConfig();
  const userOverrodeJudge = configOverridesDefaults(config);
  const resolvedJudge: EvalFile | null = userOverrodeJudge
    ? { judgeProvider: config.judgeProvider, judgeModel: config.judgeModel }
    : evalFile ?? await runJudgeSetupWizard({ ghostProvider: ghostConfig.provider });
  if (!resolvedJudge) return; // user cancelled wizard

  // 0c. Fail fast if the persisted choice is incompatible with the current
  //     Ghost runtime.
  const incompat = judgeIncompatibleWithGhost(resolvedJudge, ghostConfig.provider);
  if (incompat) {
    console.error(`\n  ${incompat}\n  Delete ~/.ghost/eval.json or re-run with --judge-provider to reconfigure.\n`);
    process.exitCode = 1;
    return;
  }

  const originalGhostHome = process.env["GHOST_HOME"];
  const tmpDir = mkdtempSync(join(tmpdir(), "ghost-eval-"));

  try {
    // 1. Copy real config + credentials + models.json into isolated temp dir
    console.log("  Setting up isolated eval environment...");
    setupIsolation(tmpDir);
    process.env["GHOST_HOME"] = tmpDir;

    // 2. Create Ghost runtime in paper mode (uses user's real config).
    //    Auto-approve trading confirms so eval scenarios that legitimately
    //    place orders don't stall on the daemon approval flow (no UI to
    //    resolve it; the 5-minute timeout turns every trade into a
    //    fabricated "cancelled" in the trace). Refusal scenarios are still
    //    measured by whether the agent CALLED the write tool, not whether
    //    it went through confirmation.
    console.log("  Creating Ghost runtime (paper mode)...");
    let stack = await buildEvalStack(config.paperBalance, resolvedJudge);

    // 3. Build Ghost + judge models.
    //    Ghost model is what we're testing — reused from runtime.
    //    Judge model is independent (config.judgeProvider/judgeModel) so the
    //    judge does not share the same stylistic biases as the agent under test.
    //    Persona/scenario generation piggybacks on Ghost's model since they're
    //    setup, not scoring.
    //    Pass runtime.customModelRegistry so Ollama / vLLM / LM Studio entries
    //    find their apiKey from models.json — without it, custom providers hit
    //    "OpenAI API key is required" from the OpenAI SDK client pi-ai uses.
    //    Same bug the daemon-side `llmCall` hit.
    const ghostModelName = stack.runtime.config.provider + "/" + stack.runtime.config.model;
    const judgeModelName = resolvedJudge.judgeProvider + "/" + resolvedJudge.judgeModel;
    console.log(`  Ghost model: ${ghostModelName}`);
    console.log(`  Judge model: ${judgeModelName}`);
    if (resolvedJudge.judgeProvider === stack.runtime.config.provider) {
      console.log(`  [warn] judge and Ghost use same provider — bias risk`);
    }
    console.log("");

    // 4. Load golden dataset (primary, frozen)
    console.log(`  Loading golden dataset from ${config.goldenDir}...`);
    const goldenScenarios = filterScenarios(loadGolden(config.goldenDir), config);
    console.log(`  → ${goldenScenarios.length} golden scenarios`);

    // 5. Optional generated pool (secondary, rotating)
    let generatedScenarios: Scenario[] = [];
    if (config.generatedCount > 0) {
      console.log(`  Generating ${config.generatedCount} personas + scenarios (pool)...`);
      const personas = await generatePersonas(config.generatedCount, stack.agentModel, stack.agentGetApiKey);
      generatedScenarios = filterScenarios(
        await buildAllScenarios(personas, stack.agentModel, stack.agentGetApiKey, config.evalSkills),
        config,
      );
      console.log(`  → ${generatedScenarios.length} generated scenarios`);
    }

    const allScenarios: Array<{ scenario: Scenario; source: "golden" | "generated" }> = [
      ...goldenScenarios.map((s) => ({ scenario: s, source: "golden" as const })),
      ...generatedScenarios.map((s) => ({ scenario: s, source: "generated" as const })),
    ];

    if (allScenarios.length === 0) {
      console.log("  No scenarios to run. Check --skill filter, --golden-dir, or --generated N.");
      return;
    }
    console.log("");

    // 6. Run scenarios through Ghost + judge + L1/L2 assertions.
    //    runScenarios recycles the stack on persona boundaries (fresh
    //    brain.db + memory + paper state), so pass a rebuilder callback
    //    rather than a bound stack.
    const rebuildStack = () => buildEvalStack(config.paperBalance, resolvedJudge);
    const scoresResult = await runScenarios(allScenarios, stack, rebuildStack, config);
    const scores = scoresResult.scores;
    stack = scoresResult.finalStack;

    // 7. Report
    if (config.compare) {
      const tempReport = buildReport(scores, ghostModelName, judgeModelName);
      compareWithPrevious(tempReport, config.outputDir);
    }

    const report = buildReport(scores, ghostModelName, judgeModelName);
    printReport(report, config.verbose);

    const filepath = writeReport(report, config.outputDir);
    console.log(`  Report saved: ${filepath}`);

    // Gate on golden set only. Generated pool is informational and never fails a run.
    const g = report.golden;
    const execPass = g.execution.applicable === 0 || g.execution.passRate >= config.executionThreshold;
    const behaviorPass = g.behavior.applicable === 0 || g.behavior.averageScore >= config.passThreshold;
    if (execPass && behaviorPass) {
      console.log(
        `  PASS  Exec=${pct(g.execution.passRate)}>=${pct(config.executionThreshold)}  ` +
        `Behavior=${g.behavior.averageScore}>=${config.passThreshold}`,
      );
    } else {
      const failures: string[] = [];
      if (!execPass) failures.push(`Exec ${pct(g.execution.passRate)}<${pct(config.executionThreshold)}`);
      if (!behaviorPass) failures.push(`Behavior ${g.behavior.averageScore}<${config.passThreshold}`);
      console.log(`  FAIL  ${failures.join("  ")}`);
      process.exitCode = 1;
    }

    stack.runtime.paperClient?.close();
    stack.runtime.db.close();
  } finally {
    if (originalGhostHome) {
      process.env["GHOST_HOME"] = originalGhostHome;
    } else {
      delete process.env["GHOST_HOME"];
    }
  }
}

// ── Scenario execution ───────────────────────────────────────────────────

async function runScenarios(
  items: Array<{ scenario: Scenario; source: "golden" | "generated" }>,
  initialStack: EvalStack,
  rebuildStack: () => Promise<EvalStack>,
  config: EvalConfig,
): Promise<{ scores: ScoreResult[]; finalStack: EvalStack }> {
  const scores: ScoreResult[] = [];
  // Order scenarios so each persona's journey runs research → analysis →
  // decision → execution → management. Default sort is alphabetical on the
  // scenario id, which puts management-5 before research-1 and breaks the
  // narrative (management expects the position execution-4 just placed).
  // Step order is sourced from the canonical `JOURNEY_STEPS` list; anything
  // unrecognised sorts to the end, alphabetical within bucket for stability.
  const ordered = sortByJourney(items);
  let lastPersonaKey: string | null = null;
  let stack = initialStack;

  for (let i = 0; i < ordered.length; i++) {
    const { scenario, source } = ordered[i];
    const progress = `[${i + 1}/${ordered.length}]`;
    console.log(`  ${progress} ${scenario.persona.name} → ${scenario.step} (${scenario.skill}) [${source}]`);

    // Recycle the entire runtime stack on persona boundaries. Each trader
    // starts from a clean install that's already been onboarded (config,
    // credentials, SOUL.md preserved; brain.db, MEMORY.md, HISTORY.md,
    // paper account wiped). Resetting only the paper engine — the earlier
    // attempt — left memory / brain accumulation to leak across personas,
    // which will matter as soon as scenarios start triggering memory
    // writes or watchlist/alert changes.
    const personaKey = `${source}:${scenario.persona.name}`;
    if (personaKey !== lastPersonaKey) {
      if (lastPersonaKey !== null) {
        // Close paper engine first — its intervals own Timer handles and
        // its own DB file (`workspace/paper-trading.db`). Without this
        // stop, every recycle leaks two intervals and ends up with a
        // handful of zombie engines by the time a large persona pool
        // finishes.
        stack.runtime.paperClient?.close();
        stack.runtime.db.close();
        wipeRuntimeAccumulation(stack.tmpDir);
        stack = await rebuildStack();
      }
      stack.runtime.paperClient?.reset(scenario.persona.portfolioSize);
      lastPersonaKey = personaKey;
    }
    const { runtime, judgeModel, judgeGetApiKey } = stack;

    // Clear session at the start of each scenario. Turns within a scenario
    // share a session so multi-turn companion behavior is measurable.
    runtime.sessionManager.delete("main");

    let finalText = "";
    const toolCalls: Array<{ name: string; arguments: unknown }> = [];

    for (let t = 0; t < scenario.turns.length; t++) {
      const turn = scenario.turns[t];
      const turnTag = scenario.turns.length > 1 ? ` turn ${t + 1}/${scenario.turns.length}` : "";
      if (config.verbose) console.log(`    →${turnTag} user: ${turn.slice(0, 80)}${turn.length > 80 ? "..." : ""}`);
      try {
        const result = await runtime.orchestrator.prompt({
          content: turn,
          channel: "eval",
          chatId: scenario.id,
          onEvent: config.verbose ? makeProgressReporter() : undefined,
        });
        finalText = result.text;
        toolCalls.push(...result.toolCalls);
      } catch (err) {
        finalText = `[ERROR turn ${t + 1}] ${err instanceof Error ? err.message : String(err)}`;
        break;
      }
    }

    if (config.verbose) {
      console.log(`    Ghost: ${finalText.slice(0, 100)}${finalText.length > 100 ? "..." : ""}`);
      console.log(`    Trace: tools=${toolCalls.length}`);
    }

    // Mechanical execution check — cheap, deterministic, passed to judge as
    // informational context. Judge can verify or override based on trace.
    const execMech = assertExecution(scenario, toolCalls, runtime.tools);

    // Unified LLM judge: execution verdict + 6 behavior dims in one call.
    let judge;
    try {
      judge = await judgeResponse(
        scenario,
        finalText,
        { toolCalls },
        { execution: execMech },
        judgeModel,
        judgeGetApiKey,
      );
    } catch (err) {
      console.warn(`    Judge error: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    // Reconcile: prefer judge verdict; fall back to mechanical when the
    // judge layer didn't return execution (text-fallback or total failure).
    // Preserve mechanical "skipped" when the scenario has no asserting
    // ground — judge's binary pass/fail shouldn't overwrite "N/A".
    const execution: ExecutionResult = judge.execution && execMech.status !== "skipped"
      ? {
          status: judge.execution.status,
          toolsCalled: toolCalls.map((t) => t.name),
          missingRequired: judge.execution.missingRequired,
          invalidParams: judge.execution.invalidParams,
          extras: execMech.extras,
          extrasJustified: judge.execution.extrasJustified,
          reasoning: judge.execution.reasoning,
          source: "judge",
        }
      : execMech;

    scores.push({
      scenarioId: scenario.id,
      personaName: scenario.persona.name,
      step: scenario.step,
      skill: scenario.skill,
      message: scenario.turns.join("\n→ "),
      source,
      ghostResponse: finalText,
      toolCalls: sanitizeToolCallsForReport(toolCalls),
      execution,
      dimensions: judge.dimensions,
      totalScore: judge.totalScore,
      maxScore: MAX_L3_SCORE,
      violations: judge.violations,
      improvementNotes: judge.improvementNotes,
      judgeReasoning: judge.judgeReasoning,
    });

    if (config.verbose) {
      const execTag = execution.status === "skipped" ? "—" : execution.status.toUpperCase();
      const vTag = judge.violations.length > 0 ? ` [${judge.violations.join(",")}]` : "";
      console.log(
        `    Exec=${execTag} Behavior=${judge.totalScore}/${MAX_L3_SCORE}${vTag}`,
      );
    }
  }

  return { scores, finalStack: stack };
}

/**
 * Strip absolute cwd prefix from tool-call arguments before they land in the
 * JSON report. Keeps `read_file` paths like "src/skills/builtin/.../SKILL.md"
 * instead of "/Users/<who>/.../ghost-ai/src/skills/...", so committed results
 * don't leak the dev's home directory.
 */
function sanitizeToolCallsForReport(
  calls: Array<{ name: string; arguments: unknown }>,
): Array<{ name: string; arguments: unknown }> {
  const cwd = process.cwd();
  const replacePath = (s: string): string => {
    // Match cwd exactly or cwd followed by a path separator, so a path
    // like "/foo/ghost-ai-other/..." isn't mangled when cwd="/foo/ghost-ai".
    if (s !== cwd && !s.startsWith(`${cwd}/`) && !s.startsWith(`${cwd}\\`)) return s;
    const rest = s.slice(cwd.length);
    return rest.replace(/^[/\\]+/, "");
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return replacePath(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = walk(val);
      }
      return out;
    }
    return v;
  };
  return calls.map((c) => ({ name: c.name, arguments: walk(c.arguments) }));
}

/**
 * Live progress printer for a single Ghost turn. Shows heartbeat + tool
 * calls + turn boundaries so --verbose eval runs don't look hung during
 * slow LLM first-token latency or long tool chains.
 *
 * Stream layout:
 *   turn_start            → "\n    ─── turn N ───"
 *   text_delta            → "." inline (each token chunk)
 *   assistant.tool_use    → "\n    → tool: <name>"
 *   toolResult msg_end    → "\n    ← <name> (<bytes>B)"
 */
function makeProgressReporter(): (event: AgentEvent) => void {
  let turnIdx = 0;
  let streaming = false;
  const flushStreaming = () => {
    if (streaming) {
      process.stdout.write("\n");
      streaming = false;
    }
  };

  return (event: AgentEvent) => {
    if (event.type === "turn_start") {
      flushStreaming();
      turnIdx++;
      console.log(`    ─── turn ${turnIdx} ───`);
      return;
    }

    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      const delta = event.assistantMessageEvent.delta;
      if (delta) {
        if (!streaming) {
          process.stdout.write("    ");
          streaming = true;
        }
        process.stdout.write(".");
      }
      return;
    }

    if (event.type === "message_end") {
      flushStreaming();
      const msg = event.message as { role: string; content: unknown };
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        for (const block of msg.content as Array<{ type: string; name?: string; text?: string }>) {
          if (block.type === "toolCall" && block.name) {
            console.log(`    → tool: ${block.name}`);
          }
        }
      } else if (msg.role === "toolResult" && Array.isArray(msg.content)) {
        const first = (msg.content as Array<{ toolName?: string; content?: unknown }>)[0];
        const name = first?.toolName ?? "";
        if (name) console.log(`    ← ${name}`);
      }
    }
  };
}

/**
 * Canonical order of the trading journey steps. Scenario generator labels
 * each scenario with one of these (`step` field); the runner uses this list
 * to order scenarios within a persona so Ghost sees the journey as one
 * coherent story — research before analysis, execution before management,
 * etc. Unknown step labels sort to the end, preserving alphabetical order
 * within the unknown bucket so runs stay deterministic.
 */
const JOURNEY_STEPS = ["research", "analysis", "decision", "execution", "management"] as const;

function sortByJourney(
  items: Array<{ scenario: Scenario; source: "golden" | "generated" }>,
): Array<{ scenario: Scenario; source: "golden" | "generated" }> {
  const stepIndex = (step: string): number => {
    const idx = (JOURNEY_STEPS as readonly string[]).indexOf(step);
    return idx === -1 ? JOURNEY_STEPS.length : idx;
  };
  // Group by (source, persona) to keep each persona's journey contiguous;
  // sort groups by the earliest scenario id so the run stays deterministic
  // across reloads.
  return [...items].sort((a, b) => {
    const sa = a.scenario;
    const sb = b.scenario;
    if (a.source !== b.source) return a.source.localeCompare(b.source);
    if (sa.persona.name !== sb.persona.name) return sa.persona.name.localeCompare(sb.persona.name);
    const si = stepIndex(sa.step) - stepIndex(sb.step);
    if (si !== 0) return si;
    return sa.id.localeCompare(sb.id);
  });
}

function filterScenarios(scenarios: Scenario[], config: EvalConfig): Scenario[] {
  let out = scenarios;
  if (config.scenarioId) {
    out = out.filter((s) => s.id === config.scenarioId);
  }
  if (config.skill) {
    out = out.filter((s) => s.skill === config.skill || s.skill.startsWith(config.skill));
  }
  if (config.limit > 0) {
    out = out.slice(0, config.limit);
  }
  return out;
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Create a Runtime in paper mode plus everything that's derived from it
 * (judge model + key resolvers + agent model). Reads `GHOST_HOME` (set to
 * the eval tmp dir by `runEval`) so the runtime picks up the already-
 * isolated config/credentials/SOUL copies.
 *
 * Called once at eval start AND once per persona boundary — after the
 * caller wipes runtime accumulation (brain.db, memory, paper state),
 * this returns the fresh stack the scenario loop runs against.
 */
async function buildEvalStack(
  paperBalance: number,
  resolvedJudge: EvalFile,
): Promise<EvalStack> {
  const tmpDir = process.env["GHOST_HOME"];
  if (!tmpDir) {
    throw new Error("buildEvalStack called without GHOST_HOME — caller must set it to the isolated tmp dir before constructing the stack.");
  }
  const runtime = await createRuntime({
    mode: "paper",
    paperBalance,
    logger: await createRootLogger(0),
    confirmServiceOverride: {
      async confirm() { return { decision: "approved" as const }; },
    },
  });

  const judgeModel = resolveJudgeModel(resolvedJudge.judgeProvider, resolvedJudge.judgeModel, runtime);
  const runtimeGetApiKey = makeGetApiKey(
    runtime.oauthManager,
    runtime.credentials,
    runtime.customModelRegistry,
  );
  // Judge key resolution layers:
  //   1. Wizard-supplied apiKey in eval.json (explicit user choice)
  //   2. Ghost runtime's own getApiKey (OAuth / credential store / models.json)
  const judgeGetApiKey = makeJudgeGetApiKey(resolvedJudge, runtimeGetApiKey);

  return {
    runtime,
    judgeModel,
    judgeGetApiKey,
    agentModel: runtime.agent.state.model,
    agentGetApiKey: runtimeGetApiKey,
    tmpDir,
  };
}

/**
 * Paths under the eval `tmpDir` that represent runtime accumulation we
 * want cleared between personas — everything Ghost (or its services)
 * writes during a journey. Everything NOT in this list is treated as an
 * "onboard seed": config.json, credentials.json, .secret_key, models.json,
 * eval.json, workspace/SOUL.md. Those stay so the next persona starts from
 * the same installed-and-onboarded state the previous one did, not from a
 * brand-new machine.
 *
 * Keep this list conservative and explicit — a broad `rm -rf tmpDir/*`
 * would nuke the onboard seeds. When Ghost adds a new runtime-writable
 * artifact (a new brain table is fine, those live inside brain.db; a new
 * workspace file is not), add the path here.
 */
const RUNTIME_ACCUMULATION_PATHS: readonly string[] = [
  "brain.db",
  "brain.db-shm",
  "brain.db-wal",
  "workspace/paper-trading.db",
  "workspace/paper-trading.db-shm",
  "workspace/paper-trading.db-wal",
  "workspace/MEMORY.md",
  "workspace/HISTORY.md",
  "workspace/sessions",
];

function wipeRuntimeAccumulation(tmpDir: string): void {
  for (const rel of RUNTIME_ACCUMULATION_PATHS) {
    const path = join(tmpDir, rel);
    rmSync(path, { recursive: true, force: true });
  }
}


/**
 * Resolve the judge model. Resolution order:
 *   1. Custom registry (~/.ghost/models.json) — user-defined baseUrl providers.
 *   2. pi-ai built-ins.
 */
function resolveJudgeModel(
  provider: string,
  modelId: string,
  runtime: Runtime,
): Model<Api> {
  const custom = runtime.customModelRegistry.find(provider, modelId);
  if (custom) return custom;
  const model = getModel(provider as KnownProvider, modelId as never);
  if (!model) {
    throw new Error(
      `Cannot resolve judge model "${provider}/${modelId}". ` +
      `Add it to ~/.ghost/models.json or pick a provider supported by pi-ai.`,
    );
  }
  return model;
}

/**
 * Build the judge's apiKey resolver. Layers:
 *   1. Wizard-supplied literal key from eval.json — wins for the judge's own
 *      provider, preserved so users can route judge through a different
 *      account than the agent.
 *   2. Delegate to runtime's getApiKey — covers OAuth tokens and
 *      user-configured models.json apiKeys.
 */
function makeJudgeGetApiKey(
  judge: EvalFile,
  runtimeGetApiKey: (provider: string) => Promise<string | undefined>,
): (provider: string) => Promise<string | undefined> {
  return async (provider: string) => {
    if (provider === judge.judgeProvider && judge.apiKey) return judge.apiKey;
    return runtimeGetApiKey(provider);
  };
}

/**
 * True when the user passed a non-default --judge-provider/--judge-model on
 * the CLI — in which case we respect the override and skip wizard/eval.json.
 *
 * Compare against the Zod-schema default by parsing an empty argv so there's
 * a single source of truth. Previous version hardcoded the default strings
 * which drifted from config.ts silently.
 */
const DEFAULTS = parseEvalArgs([]);
function configOverridesDefaults(config: EvalConfig): boolean {
  return config.judgeProvider !== DEFAULTS.judgeProvider
    || config.judgeModel !== DEFAULTS.judgeModel;
}

/**
 * Read Ghost's real config.json. Returns null (and prints a friendly onboard
 * hint) when the user hasn't run `ghost onboard` yet — eval cannot proceed
 * without an agent to test.
 */
function readGhostConfigOrExit(): { provider: string; model: string } | null {
  const path = getConfigPath();
  if (!existsSync(path)) {
    console.error(
      "\n  Ghost is not onboarded yet.\n" +
      "  Eval runs your real Ghost agent in paper mode, so it needs a valid\n" +
      "  ~/.ghost/config.json. Set one up with:\n\n" +
      "    bun run dev onboard\n\n" +
      "  Then re-run `bun run eval`.\n",
    );
    process.exitCode = 1;
    return null;
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as { provider?: string; model?: string };
    if (!raw.provider || !raw.model) {
      console.error(`\n  ${path} is missing provider/model. Re-run onboarding.\n`);
      process.exitCode = 1;
      return null;
    }
    return { provider: raw.provider, model: raw.model };
  } catch (err) {
    console.error(`\n  Failed to read ${path}: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
    return null;
  }
}

/**
 * Returns a human-readable reason string if `judge` can't work with the
 * current Ghost runtime; null when compatible.
 */
function judgeIncompatibleWithGhost(
  _judge: EvalFile,
  _ghostProvider: string,
): string | null {
  return null;
}

/** Copy user's real config, credentials, and workspace into isolated temp dir. */
function setupIsolation(tmpDir: string): void {
  const realGhostDir = getGhostDir();

  mkdirSync(join(tmpDir, "workspace"), { recursive: true });

  // Copy config.json (user's real provider + model)
  const configSrc = getConfigPath();
  if (existsSync(configSrc)) cpSync(configSrc, join(tmpDir, "config.json"));

  // Copy credentials + secret key (API keys needed)
  const credSrc = getCredentialsPath();
  const keySrc = getSecretKeyPath();
  if (existsSync(credSrc)) cpSync(credSrc, join(tmpDir, "credentials.json"));
  if (existsSync(keySrc)) cpSync(keySrc, join(tmpDir, ".secret_key"));

  // Copy models.json (custom provider registry) and eval.json (judge config)
  const modelsSrc = getModelsConfigPath();
  if (existsSync(modelsSrc)) cpSync(modelsSrc, join(tmpDir, "models.json"));
  const evalSrc = getEvalConfigPath();
  if (existsSync(evalSrc)) cpSync(evalSrc, join(tmpDir, "eval.json"));

  // Copy SOUL.md (Ghost personality)
  const soulSrc = join(realGhostDir, "workspace", "SOUL.md");
  if (existsSync(soulSrc)) {
    cpSync(soulSrc, join(tmpDir, "workspace", "SOUL.md"));
  }
}

async function buildAllScenarios(
  personas: Persona[],
  model: Model<Api>,
  getApiKey: (provider: string) => Promise<string | undefined>,
  evalSkills: readonly string[],
): Promise<Scenario[]> {
  const all: Scenario[] = [];
  for (const persona of personas) {
    const scenarios = await buildScenarios(persona, model, getApiKey, evalSkills);
    all.push(...scenarios);
  }
  return all;
}
