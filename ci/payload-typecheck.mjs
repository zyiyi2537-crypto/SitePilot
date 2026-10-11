import fs from 'node:fs';
import ts from 'typescript';

const configPath = ts.findConfigFile(process.cwd(), ts.sys.fileExists, 'tsconfig.json');
if (!configPath) throw new Error('Website tsconfig.json is missing');
const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
const report = {
  tool: `TypeScript ${ts.version}`,
  project: 'fixed Payload Website Template plus SitePilot synthetic CI scripts',
  files: parsed.fileNames.length,
  diagnosticCount: diagnostics.length,
  diagnostics: diagnostics.slice(0, 80).map((diagnostic) => ({
    file: diagnostic.file?.fileName.replace(`${process.cwd()}/`, '') || null,
    line: diagnostic.file && diagnostic.start !== undefined
      ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1 : null,
    code: diagnostic.code,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
  })),
};
fs.writeFileSync('sitepilot-typecheck-report.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(`Checked ${report.files} files with ${report.tool}: ${report.diagnosticCount} diagnostics`);
for (const diagnostic of report.diagnostics.slice(0, 30)) {
  console.log(`${diagnostic.file || 'tsconfig'}:${diagnostic.line || 0} TS${diagnostic.code} ${diagnostic.message}`);
}
if (diagnostics.length) process.exitCode = 1;
