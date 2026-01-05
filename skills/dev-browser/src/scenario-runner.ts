#!/usr/bin/env -S bun x tsx

import { readFileSync } from "fs";
import { parse as parseYaml } from "yaml";
import { connect, type DevBrowserClient } from "./client";
import {
  waitForPageLoad,
  waitForElement,
  waitForElementGone,
  waitForURL,
  waitForNetworkIdle,
} from "./client";
import { login, responsive, modal, fillAndSubmit } from "./patterns";
import type { Page } from "playwright";

/**
 * Scenario schema types
 */
interface Scenario {
  name: string;
  description?: string;
  page?: string;
  variables?: Record<string, string>;
  onError?: "stop" | "continue";
  steps: Step[];
}

type Step =
  | GotoStep
  | ClickStep
  | FillStep
  | TypeStep
  | WaitStep
  | ScreenshotStep
  | EvalStep
  | LoginStep
  | FillFormStep
  | ModalStep
  | ResponsiveStep
  | IfStep
  | TryStep
  | EachStep
  | RepeatStep;

interface BaseStep {
  onError?: "stop" | "continue";
  assert?: Assertion[];
}

interface GotoStep extends BaseStep {
  goto: string | { url: string; waitUntil?: "load" | "networkidle" };
}

interface ClickStep extends BaseStep {
  click: string | { selector?: string; text?: string; ref?: string; timeout?: number };
}

interface FillStep extends BaseStep {
  fill: Record<string, string> | { selector: string; value: string; clear?: boolean };
}

interface TypeStep extends BaseStep {
  type: { selector?: string; text: string; delay?: number };
}

interface WaitStep extends BaseStep {
  wait:
    | "load"
    | "networkidle"
    | { element?: string; gone?: string; url?: string; ms?: number; timeout?: number };
}

interface ScreenshotStep extends BaseStep {
  screenshot: string | { path: string; fullPage?: boolean };
}

interface EvalStep extends BaseStep {
  eval: string | { script: string; store?: string };
}

interface LoginStep extends BaseStep {
  login: {
    url: string;
    username: string;
    password: string;
    usernameSelector?: string;
    passwordSelector?: string;
    submitSelector?: string;
  };
}

interface FillFormStep extends BaseStep {
  fillForm: {
    fields: Record<string, string>;
    submit?: boolean;
  };
}

interface ModalStep extends BaseStep {
  modal: {
    wait?: string;
    action?: string;
    fill?: Record<string, string>;
    close?: string;
  };
}

interface ResponsiveStep extends BaseStep {
  responsive: {
    path: string;
    viewports?: Array<{ name: string; width: number; height: number }>;
  };
}

interface IfStep extends BaseStep {
  if: { exists?: string; url?: string };
  then?: Step[];
  else?: Step[];
}

interface TryStep extends BaseStep {
  try: Step[];
  catch?: Step[];
}

interface EachStep extends BaseStep {
  each: {
    selector: string;
    as: string;
    steps: Step[];
  };
}

interface RepeatStep extends BaseStep {
  repeat: {
    times: number;
    steps: Step[];
  };
}

type Assertion =
  | { title: string }
  | { titleContains: string }
  | { url: string }
  | { visible: string }
  | { hidden: string }
  | { exists: string }
  | { text: { selector: string; contains?: string; equals?: string } }
  | { count: { selector: string; min?: number; max?: number; equals?: number } };

/**
 * Execution result
 */
interface ExecutionReport {
  scenario: string;
  success: boolean;
  steps: StepResult[];
  duration: number;
  error?: string;
}

interface StepResult {
  index: number;
  type: string;
  status: "passed" | "failed" | "skipped";
  duration: number;
  error?: string;
}

/**
 * Scenario execution context
 */
class ScenarioExecutor {
  private scenario: Scenario;
  private client: DevBrowserClient;
  private page!: Page;
  private variables: Map<string, string>;
  private results: StepResult[] = [];
  private shouldStop = false;

  constructor(scenario: Scenario, client: DevBrowserClient) {
    this.scenario = scenario;
    this.client = client;
    this.variables = new Map();
  }

  /**
   * Execute the scenario
   */
  async execute(): Promise<ExecutionReport> {
    const startTime = Date.now();

    try {
      // Resolve variables
      this.resolveVariables();

      // Get or create page
      const pageName = this.scenario.page || "main";
      this.page = await this.client.page(pageName);

      // Execute steps
      for (let i = 0; i < this.scenario.steps.length; i++) {
        if (this.shouldStop) break;

        const step = this.scenario.steps[i];
        const stepStartTime = Date.now();

        try {
          await this.executeStep(step);

          this.results.push({
            index: i,
            type: this.getStepType(step),
            status: "passed",
            duration: Date.now() - stepStartTime,
          });
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);

          this.results.push({
            index: i,
            type: this.getStepType(step),
            status: "failed",
            duration: Date.now() - stepStartTime,
            error: errorMsg,
          });

          // Handle error based on onError setting
          const onError =
            (step as BaseStep).onError || this.scenario.onError || "stop";

          if (onError === "stop") {
            this.shouldStop = true;
            throw error;
          } else {
            console.warn(`Step ${i} failed (continuing): ${errorMsg}`);
          }
        }
      }

      return {
        scenario: this.scenario.name,
        success: !this.shouldStop && this.results.every((r) => r.status === "passed"),
        steps: this.results,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      return {
        scenario: this.scenario.name,
        success: false,
        steps: this.results,
        duration: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Resolve variables with environment fallback
   */
  private resolveVariables(): void {
    if (!this.scenario.variables) return;

    for (const [key, value] of Object.entries(this.scenario.variables)) {
      // Parse ${ENV:-default} syntax
      const match = value.match(/^\$\{([^:]+):-(.*)\}$/);
      if (match) {
        const [, envVar, defaultValue] = match;
        this.variables.set(key, process.env[envVar] || defaultValue);
      } else {
        this.variables.set(key, value);
      }
    }
  }

  /**
   * Interpolate {{variables}} in strings
   */
  private interpolate(value: string): string {
    return value.replace(/\{\{(\w+)\}\}/g, (_, key) => {
      return this.variables.get(key) || "";
    });
  }

  /**
   * Interpolate variables in object
   */
  private interpolateObject<T>(obj: T): T {
    if (typeof obj === "string") {
      return this.interpolate(obj) as unknown as T;
    }
    if (Array.isArray(obj)) {
      return obj.map((item) => this.interpolateObject(item)) as unknown as T;
    }
    if (obj && typeof obj === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = this.interpolateObject(value);
      }
      return result as T;
    }
    return obj;
  }

  /**
   * Execute a single step
   */
  private async executeStep(step: Step): Promise<void> {
    // Interpolate variables in step
    const interpolated = this.interpolateObject(step);

    // Execute based on step type
    if ("goto" in interpolated) {
      await this.executeGoto(interpolated);
    } else if ("click" in interpolated) {
      await this.executeClick(interpolated);
    } else if ("fill" in interpolated) {
      await this.executeFill(interpolated);
    } else if ("type" in interpolated) {
      await this.executeType(interpolated);
    } else if ("wait" in interpolated) {
      await this.executeWait(interpolated);
    } else if ("screenshot" in interpolated) {
      await this.executeScreenshot(interpolated);
    } else if ("eval" in interpolated) {
      await this.executeEval(interpolated);
    } else if ("login" in interpolated) {
      await this.executeLogin(interpolated);
    } else if ("fillForm" in interpolated) {
      await this.executeFillForm(interpolated);
    } else if ("modal" in interpolated) {
      await this.executeModal(interpolated);
    } else if ("responsive" in interpolated) {
      await this.executeResponsive(interpolated);
    } else if ("if" in interpolated) {
      await this.executeIf(interpolated);
    } else if ("try" in interpolated) {
      await this.executeTry(interpolated);
    } else if ("each" in interpolated) {
      await this.executeEach(interpolated);
    } else if ("repeat" in interpolated) {
      await this.executeRepeat(interpolated);
    } else {
      throw new Error(`Unknown step type: ${JSON.stringify(step)}`);
    }

    // Run assertions if present
    if ((step as BaseStep).assert) {
      await this.executeAssertions((step as BaseStep).assert!);
    }
  }

  private async executeGoto(step: GotoStep): Promise<void> {
    const goto = step.goto;

    if (typeof goto === "string") {
      await this.page.goto(goto);
      await waitForPageLoad(this.page);
    } else {
      await this.page.goto(goto.url);
      if (goto.waitUntil === "networkidle") {
        await waitForNetworkIdle(this.page);
      } else {
        await waitForPageLoad(this.page);
      }
    }
  }

  private async executeClick(step: ClickStep): Promise<void> {
    const click = step.click;

    if (typeof click === "string") {
      await this.page.click(click);
    } else if (click.text) {
      await this.page.getByText(click.text).click();
    } else if (click.ref) {
      const element = await this.client.selectSnapshotRef(this.scenario.page || "main", click.ref);
      if (!element) throw new Error(`Ref not found: ${click.ref}`);
      await element.click();
    } else if (click.selector) {
      const timeout = click.timeout || 5000;
      await this.page.click(click.selector, { timeout });
    }
  }

  private async executeFill(step: FillStep): Promise<void> {
    const fill = step.fill;

    if ("selector" in fill) {
      const clear = fill.clear !== false;
      if (clear) {
        await this.page.fill(fill.selector, "");
      }
      await this.page.fill(fill.selector, fill.value);
    } else {
      // Fill multiple fields
      for (const [selector, value] of Object.entries(fill)) {
        await this.page.fill(selector, value);
      }
    }
  }

  private async executeType(step: TypeStep): Promise<void> {
    const { selector, text, delay } = step.type;

    if (selector) {
      await this.page.type(selector, text, { delay });
    } else {
      await this.page.keyboard.type(text, { delay });
    }
  }

  private async executeWait(step: WaitStep): Promise<void> {
    const wait = step.wait;

    if (wait === "load") {
      await waitForPageLoad(this.page);
    } else if (wait === "networkidle") {
      await waitForNetworkIdle(this.page);
    } else if (typeof wait === "object") {
      const timeout = wait.timeout || 10000;

      if (wait.element) {
        await waitForElement(this.page, wait.element, { timeout });
      } else if (wait.gone) {
        await waitForElementGone(this.page, wait.gone, { timeout });
      } else if (wait.url) {
        await waitForURL(this.page, wait.url, { timeout });
      } else if (wait.ms) {
        await this.page.waitForTimeout(wait.ms);
      }
    }
  }

  private async executeScreenshot(step: ScreenshotStep): Promise<void> {
    const screenshot = step.screenshot;

    if (typeof screenshot === "string") {
      // Add tmp/ prefix if not absolute path
      const path = screenshot.startsWith("/") ? screenshot : `tmp/${screenshot}`;
      await this.page.screenshot({ path });
    } else {
      const path = screenshot.path.startsWith("/") ? screenshot.path : `tmp/${screenshot.path}`;
      await this.page.screenshot({ path, fullPage: screenshot.fullPage });
    }
  }

  private async executeEval(step: EvalStep): Promise<void> {
    const evalStep = step.eval;

    if (typeof evalStep === "string") {
      await this.page.evaluate(evalStep);
    } else {
      const result = await this.page.evaluate(evalStep.script);
      if (evalStep.store) {
        this.variables.set(evalStep.store, String(result));
      }
    }
  }

  private async executeLogin(step: LoginStep): Promise<void> {
    const opts = step.login;

    await login(this.page, {
      url: opts.url,
      user: opts.username,
      pass: opts.password,
      selectors: {
        username: opts.usernameSelector,
        password: opts.passwordSelector,
        submit: opts.submitSelector,
      },
    });
  }

  private async executeFillForm(step: FillFormStep): Promise<void> {
    const opts = step.fillForm;

    await this.client.fillForm(this.scenario.page || "main", opts.fields, {
      submit: opts.submit,
    });
  }

  private async executeModal(step: ModalStep): Promise<void> {
    const opts = step.modal;

    // Simple modal handling - click action or close
    if (opts.wait) {
      await waitForElement(this.page, opts.wait);
    }

    if (opts.fill) {
      for (const [selector, value] of Object.entries(opts.fill)) {
        await this.page.fill(selector, value);
      }
    }

    if (opts.action) {
      await this.page.click(opts.action);
    }

    if (opts.close) {
      await this.page.click(opts.close);
    }
  }

  private async executeResponsive(step: ResponsiveStep): Promise<void> {
    const opts = step.responsive;

    await responsive(this.page, {
      viewports: opts.viewports,
      screenshots: `tmp/${opts.path}`,
    });
  }

  private async executeIf(step: IfStep): Promise<void> {
    let condition = false;

    if (step.if.exists) {
      const count = await this.page.locator(step.if.exists).count();
      condition = count > 0;
    } else if (step.if.url) {
      const url = this.page.url();
      const pattern = step.if.url;
      condition = new RegExp(pattern.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*")).test(url);
    }

    const stepsToExecute = condition ? step.then : step.else;
    if (stepsToExecute) {
      for (const subStep of stepsToExecute) {
        await this.executeStep(subStep);
      }
    }
  }

  private async executeTry(step: TryStep): Promise<void> {
    try {
      for (const subStep of step.try) {
        await this.executeStep(subStep);
      }
    } catch (error) {
      if (step.catch) {
        for (const subStep of step.catch) {
          await this.executeStep(subStep);
        }
      }
    }
  }

  private async executeEach(step: EachStep): Promise<void> {
    const elements = await this.page.locator(step.each.selector).all();

    for (const element of elements) {
      // For simplicity, just execute steps - proper variable substitution would need more work
      for (const subStep of step.each.steps) {
        await this.executeStep(subStep);
      }
    }
  }

  private async executeRepeat(step: RepeatStep): Promise<void> {
    for (let i = 0; i < step.repeat.times; i++) {
      for (const subStep of step.repeat.steps) {
        await this.executeStep(subStep);
      }
    }
  }

  private async executeAssertions(assertions: Assertion[]): Promise<void> {
    for (const assertion of assertions) {
      if ("title" in assertion) {
        const title = await this.page.title();
        if (title !== assertion.title) {
          throw new Error(`Title mismatch: expected "${assertion.title}", got "${title}"`);
        }
      } else if ("titleContains" in assertion) {
        const title = await this.page.title();
        if (!title.includes(assertion.titleContains)) {
          throw new Error(`Title does not contain "${assertion.titleContains}": "${title}"`);
        }
      } else if ("url" in assertion) {
        const url = this.page.url();
        const pattern = assertion.url.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*");
        if (!new RegExp(pattern).test(url)) {
          throw new Error(`URL does not match pattern "${assertion.url}": "${url}"`);
        }
      } else if ("visible" in assertion) {
        const visible = await this.page.locator(assertion.visible).isVisible();
        if (!visible) {
          throw new Error(`Element not visible: ${assertion.visible}`);
        }
      } else if ("hidden" in assertion) {
        const visible = await this.page.locator(assertion.hidden).isVisible();
        if (visible) {
          throw new Error(`Element should be hidden: ${assertion.hidden}`);
        }
      } else if ("exists" in assertion) {
        const count = await this.page.locator(assertion.exists).count();
        if (count === 0) {
          throw new Error(`Element does not exist: ${assertion.exists}`);
        }
      } else if ("text" in assertion) {
        const text = await this.page.locator(assertion.text.selector).textContent();
        if (assertion.text.contains && !text?.includes(assertion.text.contains)) {
          throw new Error(
            `Text does not contain "${assertion.text.contains}": "${text}"`
          );
        }
        if (assertion.text.equals && text !== assertion.text.equals) {
          throw new Error(`Text mismatch: expected "${assertion.text.equals}", got "${text}"`);
        }
      } else if ("count" in assertion) {
        const count = await this.page.locator(assertion.count.selector).count();
        if (assertion.count.equals !== undefined && count !== assertion.count.equals) {
          throw new Error(
            `Count mismatch: expected ${assertion.count.equals}, got ${count}`
          );
        }
        if (assertion.count.min !== undefined && count < assertion.count.min) {
          throw new Error(`Count too low: expected min ${assertion.count.min}, got ${count}`);
        }
        if (assertion.count.max !== undefined && count > assertion.count.max) {
          throw new Error(`Count too high: expected max ${assertion.count.max}, got ${count}`);
        }
      }
    }
  }

  private getStepType(step: Step): string {
    const keys = Object.keys(step).filter((k) => k !== "assert" && k !== "onError");
    return keys[0] || "unknown";
  }
}

/**
 * Main CLI entry point
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error("Usage: scenario-runner.ts <scenario.yaml>");
    process.exit(1);
  }

  const scenarioPath = args[0];

  try {
    // Load scenario file
    const yamlContent = readFileSync(scenarioPath, "utf-8");
    const scenario = parseYaml(yamlContent) as Scenario;

    console.log(`Running scenario: ${scenario.name}`);
    if (scenario.description) {
      console.log(`Description: ${scenario.description}`);
    }

    // Connect to dev-browser
    const client = await connect();

    // Execute scenario
    const executor = new ScenarioExecutor(scenario, client);
    const report = await executor.execute();

    // Print report
    console.log("\n" + "=".repeat(60));
    console.log(`Scenario: ${report.scenario}`);
    console.log(`Status: ${report.success ? "PASSED" : "FAILED"}`);
    console.log(`Duration: ${report.duration}ms`);
    console.log("=".repeat(60));

    for (const step of report.steps) {
      const icon = step.status === "passed" ? "✓" : "✗";
      const status = step.status.toUpperCase().padEnd(7);
      console.log(`${icon} Step ${step.index} [${status}] ${step.type} (${step.duration}ms)`);
      if (step.error) {
        console.log(`  Error: ${step.error}`);
      }
    }

    if (report.error) {
      console.log(`\nFatal error: ${report.error}`);
    }

    // Disconnect
    await client.disconnect();

    // Exit with appropriate code
    process.exit(report.success ? 0 : 1);
  } catch (error) {
    console.error("Fatal error:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { ScenarioExecutor, type Scenario, type ExecutionReport };
