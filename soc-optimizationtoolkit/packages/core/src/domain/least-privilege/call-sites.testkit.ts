/**
 * Test-only: find every Azure request the toolkit source builds - @soc/core,
 * @soc/ui and the cribl-app shell - and work out the path each one is sent
 * to, so the coverage pin can hold each to a least-privilege registry row.
 *
 * NOT production code. It reads source files and uses the TypeScript compiler,
 * which @soc/core may not do at run time; only coverage.test.ts imports it.
 *
 * WHAT COUNTS AS AN AZURE REQUEST. An object literal with a `path` property
 * and an `apiVersion` property - the AzureManagementRequest shape. Cribl
 * requests have no apiVersion, so they are not swept in. Absolute-URL
 * requests (`url`, an ARM nextLink) continue a list another call started and
 * need no permission of their own, so they are not either.
 *
 * Graph and Entra token calls are not that shape: the shell builds them as
 * absolute URLs and fetches them directly. So, separately, in the dirs passed
 * as `directUrlDirs` (the shell - core has no IO and the UI calls through
 * ports, so an absolute URL there is configuration for someone else, such as
 * a Cribl destination's login URL), every string or template literal that
 * evaluates to an https URL on graph.microsoft.com or login.microsoftonline.com
 * with a path is a site too. A bare host constant, which only feeds other
 * URLs, is not; neither is an OAuth scope (`.../.default`), which names an
 * audience rather than a call.
 *
 * HOW THE PATH IS WORKED OUT. Symbolically. A string or template literal
 * contributes its text; anything only known at run time - a parameter, a
 * property read - contributes `{}`; a call to a function in this program
 * contributes whatever that function returns, evaluated the same way; a local
 * const contributes its initializer. A conditional contributes both arms, so
 * one site can yield more than one path. Depth is bounded, so a recursive
 * helper degrades to `{}` rather than hanging.
 */

import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

/** One Azure request object found in the source. */
export interface CallSite {
  /** Path relative to the toolkit root (soc-optimizationtoolkit), forward slashes. */
  readonly file: string;
  readonly line: number;
  /** Every method the site may send, upper case; `*` when unknown. */
  readonly methods: readonly string[];
  /** Every path the site may send, with `{}` for run-time values. */
  readonly paths: readonly string[];
}

const MAX_DEPTH = 8;
const MAX_CANDIDATES = 16;

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
      !/\.test\.tsx?$/.test(entry.name) &&
      !entry.name.endsWith(".testkit.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

function cap(values: string[]): string[] {
  return [...new Set(values)].slice(0, MAX_CANDIDATES);
}

function concat(left: string[], right: string[]): string[] {
  const out: string[] = [];
  for (const l of left) {
    for (const r of right) {
      out.push(l + r);
    }
  }
  return cap(out);
}

/**
 * Mark any segment holding a run-time value as a single unknown, and collapse
 * runs of them. An EMPTY inner or trailing segment is also an unknown: it is
 * a value that evaluated to "" on one branch (`name ?? ""`), not a real
 * double slash.
 */
function normalise(path: string): string {
  const parts = path.split("/");
  return parts
    .map((segment, i) =>
      segment.includes("{}") || (segment === "" && i > 0) ? "{}" : segment,
    )
    .join("/")
    .replace(/(\{\}\/)+\{\}/g, "{}");
}

class Evaluator {
  private readonly checker: ts.TypeChecker;

  constructor(checker: ts.TypeChecker) {
    this.checker = checker;
  }

  private declarationOf(node: ts.Node): ts.Declaration | undefined {
    // A shorthand property `{ path }` names the VALUE's variable, which
    // getSymbolAtLocation does not return (it returns the property).
    let symbol =
      ts.isIdentifier(node) && ts.isShorthandPropertyAssignment(node.parent)
        ? this.checker.getShorthandAssignmentValueSymbol(node.parent)
        : this.checker.getSymbolAtLocation(node);
    if (symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias) {
      symbol = this.checker.getAliasedSymbol(symbol);
    }
    return symbol?.declarations?.[0];
  }

  /**
   * Every expression a local variable can hold: a const's initializer, or a
   * let's initializer plus every plain assignment to it in the same function.
   * Parameters and loop variables hold nothing this can see.
   */
  private boundExpressions(node: ts.Identifier): ts.Expression[] {
    const decl = this.declarationOf(node);
    if (decl === undefined || !ts.isVariableDeclaration(decl) || !ts.isVariableDeclarationList(decl.parent)) {
      return [];
    }
    const out: ts.Expression[] = decl.initializer === undefined ? [] : [decl.initializer];
    if ((decl.parent.flags & ts.NodeFlags.Const) !== 0) {
      return out;
    }
    let scope: ts.Node = decl;
    while (scope.parent !== undefined && !ts.isFunctionLike(scope) && !ts.isSourceFile(scope)) {
      scope = scope.parent;
    }
    const visit = (n: ts.Node): void => {
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(n.left) &&
        this.declarationOf(n.left) === decl
      ) {
        out.push(n.right);
      }
      ts.forEachChild(n, visit);
    };
    visit(scope);
    return out;
  }

  /**
   * The candidate string values of an expression. `env` binds the parameters
   * of the function being evaluated to the values its caller passed, so a
   * helper like `networkPath(sub, rg, "publicIPAddresses/" + name)` resolves
   * its suffix instead of reading as one unknown.
   */
  eval(node: ts.Expression, depth: number, env: Env = NO_ENV): string[] {
    if (depth > MAX_DEPTH) {
      return ["{}"];
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      return [node.text];
    }
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) {
      return this.eval(node.expression, depth, env);
    }
    if (ts.isTemplateExpression(node)) {
      let acc = [node.head.text];
      for (const span of node.templateSpans) {
        acc = concat(acc, this.eval(span.expression, depth + 1, env));
        acc = concat(acc, [span.literal.text]);
      }
      return acc;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return concat(this.eval(node.left, depth + 1, env), this.eval(node.right, depth + 1, env));
    }
    if (ts.isConditionalExpression(node)) {
      return cap([...this.eval(node.whenTrue, depth + 1, env), ...this.eval(node.whenFalse, depth + 1, env)]);
    }
    if (ts.isIdentifier(node)) {
      const decl = this.declarationOf(node);
      const passed = decl === undefined ? undefined : env.get(decl);
      if (passed !== undefined) {
        return passed;
      }
      const bound = this.boundExpressions(node);
      return bound.length > 0 ? cap(bound.flatMap((expr) => this.eval(expr, depth + 1, env))) : ["{}"];
    }
    if (ts.isPropertyAccessExpression(node)) {
      const values = this.objectLiterals(node.expression, depth + 1, env).flatMap(({ obj, env: objEnv }) => {
        const prop = propertyNamed(obj, node.name.text);
        const value = prop === undefined ? undefined : valueOf(prop);
        return value === undefined ? [] : this.eval(value, depth + 1, objEnv);
      });
      return values.length > 0 ? cap(values) : ["{}"];
    }
    if (ts.isCallExpression(node)) {
      const callee = this.callee(node, depth, env);
      if (callee !== undefined && callee.returns.length > 0) {
        return cap(callee.returns.flatMap((expr) => this.eval(expr, depth + 1, callee.env)));
      }
      return ["{}"];
    }
    return ["{}"];
  }

  /**
   * The object literals an expression may evaluate to, each with the binding
   * its property values must be evaluated under: a literal itself, a const
   * bound to one, or a call to a function that returns one.
   */
  private objectLiterals(
    node: ts.Expression,
    depth: number,
    env: Env,
  ): { obj: ts.ObjectLiteralExpression; env: Env }[] {
    if (depth > MAX_DEPTH) {
      return [];
    }
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) {
      return this.objectLiterals(node.expression, depth, env);
    }
    if (ts.isObjectLiteralExpression(node)) {
      return [{ obj: node, env }];
    }
    if (ts.isIdentifier(node)) {
      return this.boundExpressions(node).flatMap((expr) => this.objectLiterals(expr, depth + 1, env));
    }
    if (ts.isCallExpression(node)) {
      const callee = this.callee(node, depth, env);
      return (callee?.returns ?? []).flatMap((expr) => this.objectLiterals(expr, depth + 1, callee?.env ?? NO_ENV));
    }
    return [];
  }

  /** A called function's return expressions, with its parameters bound to the arguments. */
  private callee(
    call: ts.CallExpression,
    depth: number,
    env: Env,
  ): { returns: ts.Expression[]; env: Env } | undefined {
    const decl = this.declarationOf(call.expression);
    const fn = decl === undefined ? undefined : functionOf(decl);
    if (fn === undefined || fn.body === undefined) {
      return undefined;
    }
    const bound = new Map<ts.Declaration, string[]>();
    fn.parameters.forEach((param, i) => {
      const arg = call.arguments[i];
      if (arg !== undefined && ts.isIdentifier(param.name)) {
        bound.set(param, this.eval(arg, depth + 1, env));
      }
    });
    return { returns: returnedExpressions(fn), env: bound };
  }
}

type Env = ReadonlyMap<ts.Declaration, string[]>;
const NO_ENV: Env = new Map();

/** The function a declaration names: a function, a method, or a const arrow. */
function functionOf(decl: ts.Declaration): ts.FunctionLikeDeclaration | undefined {
  if (ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl)) {
    return decl;
  }
  if (
    ts.isVariableDeclaration(decl) &&
    decl.initializer !== undefined &&
    (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
  ) {
    return decl.initializer;
  }
  return undefined;
}

/** The expressions a function returns (an expression-bodied arrow's body). */
function returnedExpressions(fn: ts.FunctionLikeDeclaration): ts.Expression[] {
  if (fn.body === undefined) {
    return [];
  }
  if (!ts.isBlock(fn.body)) {
    return [fn.body];
  }
  const out: ts.Expression[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isReturnStatement(n) && n.expression !== undefined) {
      out.push(n.expression);
    }
    if (!ts.isFunctionLike(n)) {
      ts.forEachChild(n, visit);
    }
  };
  ts.forEachChild(fn.body, visit);
  return out;
}

function propertyNamed(obj: ts.ObjectLiteralExpression, name: string): ts.ObjectLiteralElementLike | undefined {
  return obj.properties.find(
    (p) => p.name !== undefined && ts.isIdentifier(p.name) && p.name.text === name,
  );
}

function valueOf(prop: ts.ObjectLiteralElementLike): ts.Expression | undefined {
  if (ts.isPropertyAssignment(prop)) {
    return prop.initializer;
  }
  if (ts.isShorthandPropertyAssignment(prop)) {
    return prop.name;
  }
  return undefined;
}

/** Hosts whose absolute URLs are Azure calls the shell makes directly. */
const DIRECT_URL = /^https:\/\/(graph\.microsoft\.com|login\.microsoftonline\.com)\/[^?]/i;

/** A literal that is only one part of a larger string (a template span's head is not, its parent is). */
function isNestedLiteral(node: ts.Node): boolean {
  const parent = node.parent;
  return (
    parent !== undefined &&
    (ts.isTemplateSpan(parent) ||
      ts.isTemplateExpression(parent) ||
      (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.PlusToken))
  );
}

/**
 * Every Azure request under `srcDirs`, each reported relative to `baseDir`:
 * request object literals (ARM) and absolute Graph / Entra token URLs.
 * Sorted by file then line, so a diff of the list reads as a diff.
 */
export function findAzureCallSites(
  srcDirs: readonly string[],
  baseDir: string,
  directUrlDirs: readonly string[] = [],
): CallSite[] {
  const files = srcDirs.flatMap(listSourceFiles);
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    allowJs: false,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  });
  const checker = program.getTypeChecker();
  const evaluator = new Evaluator(checker);
  const sites: CallSite[] = [];
  for (const file of files) {
    const source = program.getSourceFile(file);
    if (source === undefined) {
      continue;
    }
    const where = (node: ts.Node): { file: string; line: number } => ({
      file: relative(baseDir, file).split("\\").join("/"),
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    });
    const directUrls = directUrlDirs.some((dir) => !relative(dir, file).startsWith(".."));
    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        const pathProp = propertyNamed(node, "path");
        const versionProp = propertyNamed(node, "apiVersion");
        if (pathProp !== undefined && versionProp !== undefined) {
          const pathExpr = valueOf(pathProp);
          const methodProp = propertyNamed(node, "method");
          const methodExpr = methodProp === undefined ? undefined : valueOf(methodProp);
          const paths = pathExpr === undefined ? ["{}"] : evaluator.eval(pathExpr, 0);
          const methods =
            methodExpr === undefined
              ? ["*"]
              : evaluator.eval(methodExpr, 0).map((m) => (m === "{}" ? "*" : m.toUpperCase()));
          sites.push({ ...where(node), methods: cap(methods), paths: cap(paths.map(normalise)) });
        }
      } else if (
        directUrls &&
        (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) &&
        !isNestedLiteral(node)
      ) {
        const urls = evaluator
          .eval(node, 0)
          .map((value) => value.split("?")[0] ?? "")
          .filter((value) => DIRECT_URL.test(value) && !value.endsWith("/.default"));
        if (urls.length > 0) {
          const normaliseUrl = (url: string): string => {
            const host = /^https:\/\/[^/]+/i.exec(url)?.[0] ?? "";
            return host + normalise(url.slice(host.length));
          };
          sites.push({ ...where(node), methods: ["*"], paths: cap(urls.map(normaliseUrl)) });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return sites.sort((x, y) => (x.file === y.file ? x.line - y.line : x.file < y.file ? -1 : 1));
}
