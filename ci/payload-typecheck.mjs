import fs from 'node:fs';
import ts from 'typescript';

const configPath = ts.findConfigFile(process.cwd(), ts.sys.fileExists, 'tsconfig.json');
if (!configPath) throw new Error('Website tsconfig.json is missing');
const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
// The probe uses the compiler API without incremental emit. Suppress only
// CI-only option warnings so source diagnostics remain visible.
config.config.compilerOptions.incremental = false;
config.config.compilerOptions.ignoreDeprecations = '6.0';
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
const websiteRoot = `${process.cwd()}/`;
const category = (diagnostic) => {
  const file = diagnostic.file?.fileName;
  if (!file) return 'configuration';
  if (file.startsWith(websiteRoot)) return 'website';
  if (file.includes('/packages/')) return 'upstream_workspace';
  return 'other_dependency';
};
const categories = ['website', 'configuration', 'upstream_workspace', 'other_dependency'];
const groups = Object.fromEntries(categories.map((name) => [name, diagnostics.filter((diagnostic) => category(diagnostic) === name).length]));
const ordered = [...diagnostics].sort((a, b) => categories.indexOf(category(a)) - categories.indexOf(category(b)));
const report = {
  tool: `TypeScript ${ts.version}`,
  project: 'fixed Payload Website Template plus SitePilot synthetic CI scripts',
  files: parsed.fileNames.length,
  diagnosticCount: diagnostics.length,
  groups,
  diagnostics: ordered.slice(0, 100).map((diagnostic) => ({
    category: category(diagnostic),
    file: diagnostic.file?.fileName.replace(websiteRoot, '') || null,
    line: diagnostic.file && diagnostic.start !== undefined
      ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1 : null,
    code: diagnostic.code,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
  })),
};
fs.writeFileSync('sitepilot-typecheck-report.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(`Checked ${report.files} files with ${report.tool}: ${report.diagnosticCount} diagnostics; ${JSON.stringify(groups)}`);
for (const diagnostic of report.diagnostics.filter((item) => item.category === 'website').slice(0, 20)) {
  console.log(`${diagnostic.file}:${diagnostic.line || 0} TS${diagnostic.code} ${diagnostic.message.slice(0, 240)}`);
}
for (const diagnostic of report.diagnostics.filter((item) => item.category === 'configuration').slice(0, 5)) console.log(`tsconfig: TS${diagnostic.code} ${diagnostic.message}`);
if (diagnostics.length) process.exitCode = 1;
