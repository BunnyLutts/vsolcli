export interface LogProblem { file: string; line: number; message: string; warning: boolean; }

export function parseCompileLog(log: string, rootFile: string): LogProblem[] {
  const problems: LogProblem[] = [];
  const lines = log.split(/\r?\n/);
  let currentFile = rootFile;
  for (let index = 0; index < lines.length; index++) {
    const text = lines[index];
    const file = text.match(/\((?:\.\/)?([^()\s]+\.tex)/);
    if (file) currentFile = file[1];
    const located = text.match(/^(.+?\.tex):(\d+):\s*(.+)$/);
    if (located) {
      problems.push({ file: located[1], line: Math.max(0, Number(located[2]) - 1), message: located[3], warning: /warning/i.test(located[3]) });
    } else if (text.startsWith('! ')) {
      const location = lines.slice(index + 1, index + 12).map(value => value.match(/^l\.(\d+)\s/)).find(Boolean);
      problems.push({ file: currentFile, line: location ? Math.max(0, Number(location[1]) - 1) : 0, message: text.slice(2), warning: false });
    } else if (/^(?:LaTeX|Package .+|Class .+) Warning:/.test(text)) {
      const line = text.match(/(?:input )?line (\d+)/);
      problems.push({ file: currentFile, line: line ? Math.max(0, Number(line[1]) - 1) : 0, message: text, warning: true });
    }
  }
  return problems;
}
