import fs from 'fs';
import path from 'path';
import { builtinModules } from 'module';
import ts from 'typescript';

const PACKAGE_DIR = path.resolve(__dirname, '..');

type PackageManifest = {
  types: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

/** One bare module specifier named by a public declaration file. */
type DeclarationImport = {
  /** The specifier as written (`@scope/name/sub`, `name`, `node:fs`). */
  specifier: string;
  /** The package a consumer resolves it from (`@scope/name`, `name`); `node:` stripped. */
  packageName: string;
  /** The declaration file naming it, relative to the package. */
  file: string;
  /** How it is named: an import / export clause, an `import('x')` type, or a `/// <reference types>`. */
  via: 'import' | 'import()' | 'reference types';
};

/**
 * The emitted declaration files a consumer's compiler reads — every `.d.ts` reachable from the
 * package's `types` entry through relative imports, exports and `/// <reference path>`
 * directives — and every bare module specifier those files name: import / export … from,
 * `import type`, `import('x')` type nodes, `import x = require('x')`, `/// <reference types="x" />`.
 * Read from the built `dist` with TypeScript's own parser (a doc comment that mentions `'users'`
 * is not an import), so the suite runs after `npm run build`.
 */
class PublicDeclarationSurface {
  readonly files: string[] = [];
  readonly imports: DeclarationImport[] = [];
  private seen = new Set<string>();

  constructor(
    private packageDir: string,
    typesEntry: string
  ) {
    this.walk(path.resolve(packageDir, typesEntry));
  }

  /** The distinct packages the surface names, as a consumer resolves them. */
  packageNames(): string[] {
    return Array.from(new Set(this.imports.map((entry) => entry.packageName))).sort();
  }

  /** `@scope/name/sub` -> `@scope/name`; `name/sub` -> `name`; `node:fs` -> `fs`. */
  static packageNameOf(specifier: string): string {
    const bare = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier;
    const parts = bare.split('/');
    return bare.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  }

  private walk(file: string) {
    if (this.seen.has(file)) {
      return;
    }
    this.seen.add(file);
    if (!fs.existsSync(file)) {
      throw new Error(`public declaration file missing: ${path.relative(this.packageDir, file)} — build first`);
    }
    this.files.push(file);
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    for (const reference of source.referencedFiles) {
      this.walk(this.declarationFileFor(file, reference.fileName));
    }
    for (const reference of source.typeReferenceDirectives) {
      this.record(file, reference.fileName, 'reference types');
    }
    const visit = (node: ts.Node) => {
      const specifier = this.specifierOf(node);
      if (specifier) {
        if (specifier.text.startsWith('.')) {
          this.walk(this.declarationFileFor(file, specifier.text));
        } else {
          this.record(file, specifier.text, specifier.via);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  private specifierOf(node: ts.Node): { text: string; via: DeclarationImport['via'] } | undefined {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      return ts.isStringLiteral(node.moduleSpecifier) ? { text: node.moduleSpecifier.text, via: 'import' } : undefined;
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const { expression } = node.moduleReference;
      return ts.isStringLiteral(expression) ? { text: expression.text, via: 'import' } : undefined;
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const { literal } = node.argument;
      return ts.isStringLiteral(literal) ? { text: literal.text, via: 'import()' } : undefined;
    }
    return undefined;
  }

  private record(file: string, specifier: string, via: DeclarationImport['via']) {
    this.imports.push({
      specifier,
      packageName: PublicDeclarationSurface.packageNameOf(specifier),
      file: path.relative(this.packageDir, file),
      via,
    });
  }

  /** A relative specifier's declaration file: `x.d.ts`, else `x/index.d.ts`; a `.d.ts` path as is. */
  private declarationFileFor(from: string, relative: string): string {
    const target = path.resolve(path.dirname(from), relative);
    const candidates = relative.endsWith('.d.ts') ? [target] : [`${target}.d.ts`, path.join(target, 'index.d.ts')];
    const found = candidates.find((candidate) => fs.existsSync(candidate));
    if (!found) {
      throw new Error(
        `${path.relative(this.packageDir, from)} names ${relative}, but none of ${candidates
          .map((candidate) => path.relative(this.packageDir, candidate))
          .join(', ')} exists`
      );
    }
    return found;
  }
}

/**
 * The law: a package's public declarations resolve against its own `dependencies` and
 * `peerDependencies` (and node's builtins) alone — never a devDependency, never a package reached
 * only through another dependency's tree. A consumer that type-checks this package then sees the
 * same types whether its copy is installed from the registry (devDependencies absent) or linked
 * from a checkout (devDependencies present), and the same whether or not a transitive package
 * happens to hoist beside it.
 */
describe('the public declaration surface resolves against the declared dependencies alone', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, 'package.json'), 'utf8')) as PackageManifest;
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
  const builtins = new Set(builtinModules);
  const surface = new PublicDeclarationSurface(PACKAGE_DIR, manifest.types);

  /** `name` is declared as itself or as its DefinitelyTyped package (`@types/name`, `@types/scope__name`). */
  const isDeclared = (packageName: string) => {
    const typesName = packageName.startsWith('@')
      ? `@types/${packageName.slice(1).replace('/', '__')}`
      : `@types/${packageName}`;
    return declared.has(packageName) || declared.has(typesName);
  };
  /** A builtin module, or the `node` types that `/// <reference types="node" />` names for them. */
  const isBuiltin = (entry: DeclarationImport) =>
    builtins.has(entry.packageName) || (entry.via === 'reference types' && entry.packageName === 'node');

  it('reads the whole surface from the types entry (the control: the walk sees files and their imports)', () => {
    const relativeFiles = surface.files.map((file) => path.relative(PACKAGE_DIR, file));
    expect(relativeFiles).toContain(path.normalize('dist/index.d.ts'));
    expect(relativeFiles).toContain(path.normalize('dist/src/emails/AccountDeletionEmailConfigs.d.ts'));
    expect(relativeFiles.length).toBeGreaterThanOrEqual(10);
    expect(surface.packageNames()).toEqual(
      expect.arrayContaining(['@proteinjs/reflection', '@proteinjs/user', 'moment'])
    );
  });

  it('names no package outside dependencies / peerDependencies / node builtins', () => {
    const undeclared = surface.imports
      .filter((entry) => !isBuiltin(entry) && !isDeclared(entry.packageName))
      .map(
        (entry) =>
          `${entry.file} names '${entry.specifier}' (${entry.via}) — ${entry.packageName} is not in dependencies or peerDependencies`
      );
    expect(undeclared).toEqual([]);
  });
});
