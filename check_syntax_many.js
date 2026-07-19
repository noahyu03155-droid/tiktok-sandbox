const ts = require('typescript');
const fs = require('fs');
const files = process.argv.slice(2);
let anyErr = false;
for (const file of files) {
  const src = fs.readFileSync(file, 'utf-8');
  const result = ts.transpileModule(src, {
    compilerOptions: {
      jsx: ts.JsxEmit.Preserve,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020,
    },
    reportDiagnostics: true,
  });
  if (result.diagnostics && result.diagnostics.length) {
    anyErr = true;
    for (const d of result.diagnostics) {
      const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n');
      if (d.file) {
        const pos = d.file.getLineAndCharacterOfPosition(d.start);
        console.log(file + ':' + (pos.line + 1) + ':' + (pos.character + 1) + ' ' + msg);
      } else {
        console.log(file + ': ' + msg);
      }
    }
  } else {
    console.log(file + ': OK');
  }
}
if (!anyErr) console.log('ALL_OK');
