export function parseSessionCookie(input: string, defaultName: string): { name: string; value: string } {
  const text = input.trim();
  if (!text || /[\r\n]/.test(text)) throw new Error('Enter a session cookie value or name=value.');
  const separator = text.indexOf('=');
  const prefix = separator < 0 ? '' : text.slice(0, separator);
  if (/^[\w.-]+$/.test(prefix) && (prefix === defaultName || /session|\.sid$/i.test(prefix))) {
    const value = text.slice(separator + 1).split(';')[0].trim();
    if (!value) throw new Error('Session cookie value is empty.');
    return { name: prefix, value };
  }
  return { name: defaultName, value: text };
}
